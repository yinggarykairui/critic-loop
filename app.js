/* critic-loop — page logic. Renders the loop, one panel at a time.
   Every string that came from a user or from an API is inserted with textContent.
   There is no innerHTML in this file. */
(function () {
  'use strict';

  var MAX_PASSES = 3;
  var STEP_MS = 250;
  var DRAFT_DISPLAY_CHARS = 6000;    /* panels show this much; copy and export use all of it */
  var FINDINGS_RENDER_CAP = 60;
  var FINDINGS_OPEN_CAP = 6;         /* a pass with more findings than this renders them closed */
  var FINDINGS_KEEP_CAP = 3000;      /* how many finding objects a pass holds on to */
  var DIFF_CHAR_LIMIT = 12000;       /* above this the word diff is skipped, and says so */
  var CHUNK_THRESHOLD = 6000;        /* text longer than this is critiqued in chunks */
  var CHUNK_TARGET = 3000;           /* chunk size, in characters */
  var SLICE_BUDGET_MS = 12;          /* work this long, then hand the frame back */
  var QUOTE_DISPLAY_CHARS = 400;
  var LIVE_MAX_INPUT = 12000;

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    input: $('input'), counter: $('counter'), run: $('run'), stop: $('stop'), skip: $('skip'),
    status: $('status'), transcript: $('transcript'), emptyNote: $('empty-note'),
    section: $('transcript-section'),
    livePanel: $('live-panel'), key: $('api-key'), model: $('model'),
    offline: $('engine-offline'), live: $('engine-live')
  };

  var sampleButtons = document.querySelectorAll('[data-sample]');
  var engineRadios = document.querySelectorAll('input[name="engine"]');

  var state = {
    running: false,
    skipAnimation: false,
    aborter: null,
    runToken: 0,
    finalText: '',
    transcript: null,
    followTail: true,      /* is the newest panel still what the reader is watching? */
    readerScrolled: false,
    lastAutoY: 0           /* where the page's own last scroll landed */
  };

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { reduceMotion = false; }

  /* ---------- small DOM helpers (textContent only) ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function setStatus(text, kind) {
    els.status.className = 'status' + (kind ? ' is-' + kind : '');
    els.status.textContent = text || '';
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Give the browser a frame so the busy state actually paints before heavy work. */
  function yieldToPaint() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () { setTimeout(finish, 0); });
        setTimeout(finish, 60);
      } else { setTimeout(finish, 0); }
    });
  }

  function stepDelay() {
    if (reduceMotion || state.skipAnimation) return Promise.resolve();
    return sleep(STEP_MS);
  }

  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    return String(Math.round(n * 10) / 10);
  }

  function count(n) { return Number(n || 0).toLocaleString('en-US'); }

  function signed(d) {
    if (d === 0) return '±0';
    return (d > 0 ? '+' : '−') + num(Math.abs(d));
  }

  function shortenForDisplay(text, limit) {
    var t = String(text == null ? '' : text);
    if (t.length <= limit) return { text: t, truncated: false, total: t.length };
    return { text: t.slice(0, limit), truncated: true, total: t.length };
  }

  /* ---------- keeping the loop on screen ----------
     The transcript sits below the fold, so a run that is not scrolled to plays where
     nobody can see it. The page follows the newest panel only while the reader is still
     at the tail. The first scroll that leaves the newest panel off screen ends the
     following for the rest of that run: nothing drags the reader back. Scrolling is
     instant, never animated, so it does not fight reduced motion.

     Scrolls the page makes itself record where they landed, so the scroll listener can
     tell the page's own scrolling from the reader's and never mistake one for the other. */

  var TAIL_MARGIN = 12;   /* px of viewport kept above the newest panel */

  function scrollNow() {
    return window.pageYOffset ||
      (document.documentElement && document.documentElement.scrollTop) || 0;
  }

  function pageScrollBy(delta) {
    try { window.scrollBy(0, delta); } catch (e) { /* nothing else to try */ }
    state.lastAutoY = scrollNow();
  }

  /* Puts the node's top TAIL_MARGIN below the top of the viewport, or leaves the page
     alone when the node already sits fully inside it. The top is never pushed above the
     margin, so the newest panel is never clipped by the top edge. */
  function scrollIntoTail(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return;
    var vh = window.innerHeight || 800;
    var r = node.getBoundingClientRect();
    var floor = vh - TAIL_MARGIN;
    var delta = 0;
    if (r.height >= floor - TAIL_MARGIN || r.top < TAIL_MARGIN) delta = r.top - TAIL_MARGIN;
    else if (r.bottom > floor) delta = Math.min(r.top - TAIL_MARGIN, r.bottom - floor);
    if (Math.abs(delta) > 1) pageScrollBy(delta);
  }

  /* Focus without scrolling: moving focus back to Run at the end of a run must not
     yank the page away from the panel that just landed. */
  function focusQuietly(node) {
    if (!node) return;
    try { node.focus({ preventScroll: true }); } catch (e) { try { node.focus(); } catch (e2) { /* none */ } }
  }

  function keepInView(node) {
    if (!state.followTail) return;
    scrollIntoTail(node);
  }

  /* A scroll the page did not make. Following continues only while the newest panel is
     still whole on the screen — that is the one case where the reader is plainly watching
     the tail and moving with it. Anything else, up or down, part of a panel or none of it,
     is a reader reading something else, and this run stops following for good. */
  function readerMoved() {
    if (!state.running || !state.followTail) return;
    var last = els.transcript.lastElementChild;
    if (!last) return;
    var vh = window.innerHeight || 800;
    var r = last.getBoundingClientRect();
    if (!(r.top >= 0 && r.bottom <= vh)) state.followTail = false;
  }

  function noteReaderIntent() { if (state.running) state.readerScrolled = true; }

  window.addEventListener('scroll', function () {
    if (!state.readerScrolled && Math.abs(scrollNow() - state.lastAutoY) <= 1) return;
    state.readerScrolled = false;
    readerMoved();
  }, false);
  window.addEventListener('wheel', noteReaderIntent, { passive: true });
  window.addEventListener('touchmove', noteReaderIntent, { passive: true });
  window.addEventListener('keydown', function (e) {
    var k = e && e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown' ||
      k === 'Home' || k === 'End' || k === ' ' || k === 'Spacebar') noteReaderIntent();
  }, true);

  /* ---------- engine presence ---------- */

  var CL = window.CriticLoop;
  if (!CL || typeof CL.critique !== 'function') {
    els.run.disabled = true;
    setStatus('The critic engine did not load, so nothing can run. critic.js is missing.', 'error');
  }

  function lenses() {
    return (CL && CL.LENSES) || [{ id: 'clarity', name: 'Clarity', blurb: '' }];
  }

  function lensById(id) {
    var L = lenses();
    for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i];
    return { id: id, name: String(id || 'lens'), blurb: '' };
  }

  /* ---------- samples ---------- */

  function sampleText(name) {
    var node = document.getElementById('sample-' + name);
    return node ? node.textContent.trim() : '';
  }

  function updateCounter() {
    var n = els.input.value.length;
    els.counter.textContent = n === 1 ? '1 character' : count(n) + ' characters';
  }

  /* ---------- the verdict ----------
     One function builds the sentence. The status bar, the Result panel and the export
     all call it, so the three can never disagree. */

  function verdictLine(rec) {
    var n = rec.passes.length;
    if (rec.converged) {
      var at = (typeof rec.stoppedAt === 'number') ? rec.stoppedAt : n;
      return 'Converged after ' + count(at) + (at === 1 ? ' pass.' : ' passes.');
    }
    var unparsed = 0, found = 0, i;
    for (i = 0; i < rec.passes.length; i++) {
      if (rec.passes[i].unparsed !== undefined) unparsed++;
      else if (rec.passes[i].total > 0) found++;
    }
    var passes = count(n) + (n === 1 ? ' pass' : ' passes');
    if (n > 0 && unparsed === n) {
      return passes + ', and no reply could be parsed. Nothing was found.';
    }
    if (unparsed > 0) {
      return passes + ', ' + count(unparsed) + ' of them unparseable. The rest still found things.';
    }
    if (found === 0) return passes + ', and nothing more was found.';
    return passes + ', still finding things.';
  }

  function verdictBlurb(rec) {
    if (rec.converged) {
      return 'The draft was clean under every lens that had not run yet, so the loop stopped early.';
    }
    var unparsed = 0;
    for (var i = 0; i < rec.passes.length; i++) if (rec.passes[i].unparsed !== undefined) unparsed++;
    if (unparsed > 0) {
      return 'An unparseable reply is not a pass that found nothing. ' + count(unparsed) +
        ' of ' + count(rec.passes.length) + ' replies could not be read as findings.';
    }
    return 'The cap is ' + MAX_PASSES + ' passes. One lens runs per pass.';
  }

  /* ---------- metrics strip ---------- */

  var METRIC_ROWS = [
    { key: 'words', label: 'words' },
    { key: 'sentences', label: 'sentences' },
    { key: 'meanSentenceLength', label: 'mean sentence' },
    { key: 'hedges', label: 'hedges' }
  ];

  function metricsStrip(m, prev, aria) {
    var wrap = el('div', 'metrics');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', aria || 'Metrics for this draft');
    for (var i = 0; i < METRIC_ROWS.length; i++) {
      var row = METRIC_ROWS[i];
      var cur = m && typeof m[row.key] === 'number' ? m[row.key] : 0;
      var item = el('span', 'metric');
      item.appendChild(el('span', 'metric-name', row.label + ' '));
      if (prev && typeof prev[row.key] === 'number' && prev[row.key] !== cur) {
        item.appendChild(el('span', 'metric-val', num(prev[row.key]) + ' → ' + num(cur)));
        item.appendChild(document.createTextNode(' '));
        item.appendChild(el('span', 'metric-delta', '(' + signed(cur - prev[row.key]) + ')'));
      } else {
        item.appendChild(el('span', 'metric-val', num(cur)));
        if (prev) item.appendChild(el('span', 'metric-delta', ' (±0)'));
      }
      wrap.appendChild(item);
    }
    return wrap;
  }

  /* ---------- panels ---------- */

  function panel(kind) {
    var p = el('section', 'panel panel-' + kind);
    if (!reduceMotion && !state.skipAnimation) p.classList.add('panel-enter');
    return p;
  }

  function label(p, textMain, lensName) {
    var l = el('p', 'panel-label');
    l.appendChild(document.createTextNode(textMain));
    if (lensName) {
      l.appendChild(document.createTextNode(' — '));
      l.appendChild(el('span', 'lens', lensName));
    }
    p.appendChild(l);
    return l;
  }

  function addTranscript(node) {
    els.emptyNote.hidden = true;
    els.transcript.appendChild(node);
    keepInView(node);
  }

  function draftBody(p, text) {
    var shown = shortenForDisplay(text, DRAFT_DISPLAY_CHARS);
    p.appendChild(el('p', 'draft-text', shown.text));
    if (shown.truncated) {
      p.appendChild(el('p', 'truncated-note',
        'Showing the first ' + count(DRAFT_DISPLAY_CHARS) + ' of ' +
        count(shown.total) + ' characters. Copy and export use the whole draft.'));
    }
  }

  function renderDraft0(text, m) {
    var p = panel('draft');
    label(p, 'Draft 0 — pasted text');
    draftBody(p, text);
    p.appendChild(metricsStrip(m, null));
    addTranscript(p);
  }

  /* Every character of an op — its leading whitespace included — goes inside that op's
     own node, so concatenating the text nodes of a diff rebuilds the drafts byte for
     byte: same + del is the draft before, same + ins is the draft after. Nothing is
     moved between nodes to buy visual space. The − and + markers are CSS ::before
     content on <del>/<ins>, and the gap that keeps them off the previous word is
     padding and margin on the same elements, so neither adds a character to the text. */
  function diffNodes(ops) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i] || {};
      var t = String(op.text == null ? '' : op.text);
      if (!t) continue;
      if (op.type === 'del' || op.type === 'ins') {
        var isDel = op.type === 'del';
        var s = document.createElement(isDel ? 'del' : 'ins');
        s.className = isDel ? 'd-del' : 'd-ins';
        s.textContent = t;
        frag.appendChild(s);
      } else {
        frag.appendChild(document.createTextNode(t));
      }
    }
    return frag;
  }

  function renderNoChange(index, findings) {
    var p = panel('draft');
    label(p, 'Pass ' + index + ' · Draft ' + index + ' — no change');
    var pointers = 0;
    for (var i = 0; i < findings.length; i++) {
      if (findings[i] && (findings[i].replacement === null || findings[i].replacement === undefined)) pointers++;
    }
    p.appendChild(el('p', 'why', pointers === findings.length && findings.length
      ? 'Every finding in this pass was a pointer, so nothing was rewritten. Draft ' +
        index + ' is draft ' + (index - 1) + ', unchanged.'
      : 'Nothing was applied in this pass. Draft ' + index + ' is draft ' + (index - 1) + ', unchanged.'));
    addTranscript(p);
  }

  function renderDraft(index, before, after, mBefore, mAfter, applied) {
    var p = panel('draft');
    label(p, 'Pass ' + index + ' · Draft ' + index);

    var canDiff = typeof CL.diffWords === 'function' &&
      (before.length + after.length) <= DIFF_CHAR_LIMIT;

    var body = el('div');
    var controls = el('div', 'diff-controls');
    var toggle = el('button', 'btn btn-quiet', 'Show clean text');
    toggle.type = 'button';
    var legend = el('span', 'diff-legend', '− struck through = removed · + underlined = added');

    var ops = null;
    if (canDiff) {
      try { ops = CL.diffWords(before, after); } catch (e) { ops = null; }
    }

    if (ops) {
      var mode = 'diff';
      var paint = function () {
        clear(body);
        if (mode === 'diff') {
          var d = el('div', 'diff');
          d.appendChild(diffNodes(ops));
          body.appendChild(d);
        } else {
          var shown = shortenForDisplay(after, DRAFT_DISPLAY_CHARS);
          body.appendChild(el('p', 'draft-text', shown.text));
          if (shown.truncated) body.appendChild(el('p', 'truncated-note',
            'Showing the first ' + count(DRAFT_DISPLAY_CHARS) + ' of ' +
            count(shown.total) + ' characters.'));
        }
        toggle.textContent = mode === 'diff' ? 'Show clean text' : 'Show diff';
        toggle.setAttribute('aria-pressed', mode === 'diff' ? 'true' : 'false');
        legend.hidden = mode !== 'diff';
      };
      toggle.addEventListener('click', function () {
        mode = mode === 'diff' ? 'clean' : 'diff';
        paint();
      });
      controls.appendChild(toggle);
      controls.appendChild(legend);
      p.appendChild(controls);
      p.appendChild(body);
      paint();
    } else {
      draftBody(p, after);
      p.appendChild(el('p', 'truncated-note',
        'This draft is too large for a word-level diff, so the clean text is shown instead.'));
    }

    p.appendChild(el('p', 'pass-summary',
      applied === 1 ? '1 finding applied to make this draft.'
        : count(applied) + ' findings applied to make this draft.'));
    p.appendChild(metricsStrip(mAfter, mBefore));
    addTranscript(p);
  }

  /* A finding may carry display.quote / display.replacement: the text to show when the
     mechanical span picked up a neighbouring character. What is applied is always
     f.replacement — display is for reading only. */
  function renderFinding(f, open) {
    var d = el('details', 'finding');
    d.open = !!open;
    var disp = (f && f.display && typeof f.display === 'object') ? f.display : null;
    var quoteText = (disp && disp.quote !== undefined && disp.quote !== null)
      ? String(disp.quote) : String(f.quote == null ? '' : f.quote);

    var s = document.createElement('summary');
    s.appendChild(el('span', 'rule-name', String(f.ruleName || f.rule || 'Finding')));
    s.appendChild(el('span', 'quote', shortenForDisplay(quoteText, QUOTE_DISPLAY_CHARS).text));
    d.appendChild(s);

    var body = el('div', 'finding-body');
    body.appendChild(el('p', 'why', String(f.why == null ? '' : f.why)));

    var repl = el('p', 'repl');
    if (f.replacement === null || f.replacement === undefined) {
      repl.appendChild(el('span', 'repl-none', 'Pointer only — the loop will not rewrite this one for you.'));
    } else if (f.located === false) {
      repl.appendChild(el('span', 'repl-none', f.reason === 'overlap'
        ? 'That quote is in this draft, but it overlaps a finding earlier in the list, so this one was left alone.'
        : 'The model quoted text that is not in this draft, so nothing was changed.'));
    } else {
      var shownRepl = (disp && disp.replacement !== undefined && disp.replacement !== null)
        ? String(disp.replacement) : String(f.replacement);
      repl.appendChild(el('span', 'repl-arrow', '→ '));
      if (shownRepl === '') repl.appendChild(el('span', 'repl-empty', '(delete it)'));
      else repl.appendChild(el('span', 'repl-text', shownRepl));
    }
    body.appendChild(repl);
    d.appendChild(body);
    return d;
  }

  function renderCritique(index, lens, findings, info) {
    info = info || {};
    var p = panel('critique');
    label(p, 'Pass ' + index + ' · Critique', lens && lens.name ? lens.name : '');
    if (lens && lens.blurb) p.appendChild(el('p', 'panel-blurb', lens.blurb));

    if (info.unparsed !== undefined) {
      p.appendChild(el('p', 'why', 'The model did not answer with findings this page could parse. ' +
        'Its reply is shown as it came back, unparsed. Nothing was applied, and this pass found nothing.'));
      p.appendChild(el('p', 'quote', shortenForDisplay(String(info.unparsed), 4000).text));
      addTranscript(p);
      return;
    }

    var total = (typeof info.total === 'number') ? info.total : findings.length;
    var applied = (typeof info.applied === 'number') ? info.applied : 0;

    if (!total) {
      p.appendChild(el('p', 'why', 'Found nothing under this lens. The draft is unchanged.'));
      addTranscript(p);
      return;
    }

    var list = el('ul', 'findings');
    var shown = Math.min(findings.length, FINDINGS_RENDER_CAP);
    var openThem = total <= FINDINGS_OPEN_CAP;
    for (var i = 0; i < shown; i++) {
      var li = el('li');
      li.appendChild(renderFinding(findings[i], openThem));
      list.appendChild(li);
    }
    p.appendChild(list);
    if (total > shown) {
      p.appendChild(el('p', 'capped-note',
        'Listing the first ' + count(shown) + ' of ' + count(total) +
        ' findings, to keep the page quick. The counts below cover all ' + count(total) + '.'));
    }

    p.appendChild(el('p', 'pass-summary', passSummary(findings, total, applied, info.chunks)));
    addTranscript(p);
  }

  /* Says which number means what. Pointers are never applied, and a live quote the page
     could not place is never applied either, so "found" and "applied" are different counts. */
  function passSummary(findings, total, applied, chunks) {
    var head = count(total) + (total === 1 ? ' finding' : ' findings') +
      (chunks > 1 ? ' across ' + count(chunks) + ' chunks' : '') + '. ';
    if (applied === total) {
      return head + (total === 1 ? 'It was applied to the next draft.'
        : 'All ' + count(total) + ' were applied to the next draft.');
    }
    var body = count(applied) + ' of them ' + (applied === 1 ? 'was' : 'were') + ' applied to the next draft. ';
    if (findings.length === total) {
      var pointers = 0, unplaced = 0, i;
      for (i = 0; i < findings.length; i++) {
        var f = findings[i] || {};
        if (f.replacement === null || f.replacement === undefined) pointers++;
        else if (f.located === false) unplaced++;
      }
      if (pointers) body += count(pointers) + ' ' + (pointers === 1 ? 'is a pointer' : 'are pointers') +
        ', which the loop never applies. ';
      if (unplaced) body += count(unplaced) + ' ' + (unplaced === 1 ? 'quote' : 'quotes') +
        ' could not be placed in this draft. ';
      return head + body.replace(/\s+$/, '');
    }
    return head + body + count(total - applied) + ' ' + (total - applied === 1 ? 'was' : 'were') +
      ' not applied: pointers, or quotes the loop could not place.';
  }

  function renderNote(text) {
    var p = panel('note');
    p.appendChild(el('p', 'why', text));
    addTranscript(p);
  }

  function renderFinal(record) {
    var p = panel('final');
    label(p, 'Result');
    p.appendChild(el('p', 'final-head', verdictLine(record)));
    p.appendChild(el('p', 'panel-blurb', verdictBlurb(record)));
    draftBody(p, record.finalText);

    var mFinal = record.metrics0;
    for (var i = 0; i < record.passes.length; i++) {
      if (record.passes[i].metricsAfter) mFinal = record.passes[i].metricsAfter;
    }
    p.appendChild(el('p', 'metrics-head', 'Draft 0 → final draft'));
    p.appendChild(metricsStrip(mFinal, record.metrics0, 'Draft 0 to final draft'));

    var actions = el('div', 'final-actions');
    var copy = el('button', 'btn', 'Copy final draft');
    copy.type = 'button';
    var exp = el('button', 'btn', 'Export transcript (Markdown)');
    exp.type = 'button';
    var note = el('span', 'status');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');

    copy.addEventListener('click', function () { copyText(record.finalText, note); });
    exp.addEventListener('click', function () { exportMarkdown(note); });

    actions.appendChild(copy);
    actions.appendChild(exp);
    actions.appendChild(note);
    p.appendChild(actions);
    addTranscript(p);
  }

  /* ---------- copy and export ---------- */

  function copyText(text, note) {
    var ok = function () { note.className = 'status'; note.textContent = 'Copied.'; };
    var fail = function () {
      note.className = 'status is-error';
      note.textContent = 'Copy was blocked here. Select the final draft and press Ctrl+C.';
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, function () { legacyCopy(text, ok, fail); });
        return;
      }
    } catch (e) { /* falls through */ }
    legacyCopy(text, ok, fail);
  }

  function legacyCopy(text, ok, fail) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    var done = false;
    try { done = document.execCommand('copy'); } catch (e) { done = false; }
    document.body.removeChild(ta);
    if (done) ok(); else fail();
  }

  function mdFence(text) {
    var t = String(text == null ? '' : text);
    var fence = '```';
    while (t.indexOf(fence) !== -1) fence += '`';
    return fence + '\n' + t + '\n' + fence + '\n';
  }

  function buildMarkdown(t) {
    var out = [];
    out.push('# critic-loop transcript');
    out.push('');
    out.push('Engine: ' + t.engineLabel + '. Passes run: ' + t.passes.length + ' of ' + MAX_PASSES + '.');
    out.push('');
    out.push('## Draft 0');
    out.push('');
    out.push(mdFence(t.draft0));
    out.push('Metrics: ' + metricLine(t.metrics0));
    out.push('');
    for (var i = 0; i < t.passes.length; i++) {
      var p = t.passes[i];
      out.push('## Critique ' + p.index + ' — ' + p.lensName);
      out.push('');
      if (p.unparsed !== undefined) {
        out.push('The reply could not be parsed as findings, so this pass found nothing. Raw reply:');
        out.push('');
        out.push(mdFence(p.unparsed));
      } else if (!p.total) {
        out.push('Found nothing under this lens. The draft is unchanged.');
        out.push('');
      } else {
        /* No cap: this is a file download, so it lists every finding the pass kept. */
        for (var j = 0; j < p.findings.length; j++) {
          var f = p.findings[j];
          out.push('- **' + String(f.ruleName || f.rule || 'finding') + '** — quote: "' +
            String(f.quote == null ? '' : f.quote).replace(/\s+/g, ' ') + '"');
          out.push('  - why: ' + String(f.why == null ? '' : f.why));
          out.push('  - ' + (f.replacement === null || f.replacement === undefined
            ? 'pointer only, not applied'
            : (f.located === false
              ? (f.reason === 'overlap'
                ? 'quote is in the draft but overlaps an earlier finding, not applied'
                : 'quote not found in the draft, not applied')
              : 'replacement: "' + String(f.replacement) + '"')));
        }
        if (p.total > p.findings.length) {
          out.push('- (' + (p.total - p.findings.length) +
            ' further findings were counted but not kept in memory, so they are not listed)');
        }
        out.push('');
        out.push('Applied: ' + p.applied + ' of ' + p.total + '.');
        out.push('');
        out.push('## Draft ' + p.index);
        out.push('');
        if (p.after === p.before) {
          out.push('Unchanged: nothing in this pass was applied.');
          out.push('');
        } else {
          out.push(mdFence(p.after));
        }
        out.push('Metrics: ' + metricLine(p.metricsAfter));
        out.push('');
      }
    }
    out.push('## Result');
    out.push('');
    out.push(verdictLine(t));
    out.push('');
    out.push(mdFence(t.finalText));
    out.push('Metrics, draft 0 → final: ' + metricLine(t.metrics0) + ' → ' + metricLine(finalMetrics(t)));
    out.push('');
    out.push('No API key is included in this file.');
    return out.join('\n');
  }

  function finalMetrics(t) {
    var m = t.metrics0;
    for (var i = 0; i < t.passes.length; i++) if (t.passes[i].metricsAfter) m = t.passes[i].metricsAfter;
    return m;
  }

  function metricLine(m) {
    if (!m) return 'n/a';
    return 'words ' + num(m.words) + ', sentences ' + num(m.sentences) +
      ', mean sentence ' + num(m.meanSentenceLength) + ', hedges ' + num(m.hedges);
  }

  function exportMarkdown(note) {
    if (!state.transcript) return;
    try {
      var md = buildMarkdown(state.transcript);
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'critic-loop-transcript.md';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      note.className = 'status';
      note.textContent = 'Transcript downloaded.';
    } catch (e) {
      note.className = 'status is-error';
      note.textContent = 'The download was blocked here. Copy the final draft instead.';
    }
  }

  /* ---------- live engine ---------- */

  function livePrompt(lens) {
    return [
      'You are one lens of a draft-critique-revise loop. Your lens is "' + lens.name + '": ' +
      (lens.blurb || '') ,
      'Read the paragraph the user sends. Return findings only for your lens.',
      'Answer with JSON and nothing else: an array of objects with these keys.',
      '  quote: the exact substring from the paragraph you object to, copied character for character.',
      '  ruleName: two or three words naming the rule you applied.',
      '  why: one short sentence saying why it hurts the reader.',
      '  replacement: the exact text to substitute for the quote, or null if you are only pointing.',
      'Use at most 8 findings. Quotes must not overlap. If the paragraph is already good for your',
      'lens, return an empty array. Do not explain. Do not apologise.'
    ].join('\n');
  }

  function extractJson(raw) {
    var text = String(raw == null ? '' : raw);
    var tries = [];
    tries.push(text.trim());
    var fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) tries.push(fence[1].trim());
    var first = text.indexOf('[');
    var last = text.lastIndexOf(']');
    if (first !== -1 && last > first) tries.push(text.slice(first, last + 1));
    var fo = text.indexOf('{');
    var lo = text.lastIndexOf('}');
    if (fo !== -1 && lo > fo) tries.push(text.slice(fo, lo + 1));
    for (var i = 0; i < tries.length; i++) {
      if (!tries[i]) continue;
      try {
        var v = JSON.parse(tries[i]);
        if (Array.isArray(v)) return v;
        if (v && Array.isArray(v.findings)) return v.findings;
      } catch (e) { /* try the next shape */ }
    }
    return null;
  }

  /* Turn loose model output into findings with real, non-overlapping spans in `text`.
     Two different failures are kept apart: a quote that is not in the draft at all, and
     a quote that is in the draft but sits inside a span an earlier finding already claimed. */
  function locateFindings(items, text) {
    var out = [];
    var taken = [];
    for (var i = 0; i < items.length && out.length < 24; i++) {
      var it = items[i];
      if (!it || typeof it !== 'object') continue;
      var quote = it.quote == null ? '' : String(it.quote);
      var why = it.why == null ? '' : String(it.why);
      var ruleName = it.ruleName == null ? (it.rule == null ? 'Finding' : String(it.rule)) : String(it.ruleName);
      var replacement = (it.replacement === null || it.replacement === undefined) ? null : String(it.replacement);
      if (!quote) continue;
      var start = -1;
      if (typeof it.start === 'number' && typeof it.end === 'number' && text.slice(it.start, it.end) === quote) {
        start = it.start;
      } else {
        start = text.indexOf(quote);
      }
      var f = {
        rule: 'live', ruleName: ruleName, quote: quote, why: why,
        replacement: replacement, start: start, end: start + quote.length,
        located: start !== -1, reason: (start === -1 ? 'missing' : null)
      };
      if (f.located) {
        var overlaps = false;
        for (var k = 0; k < taken.length; k++) {
          if (f.start < taken[k][1] && taken[k][0] < f.end) { overlaps = true; break; }
        }
        if (overlaps) { f.located = false; f.reason = 'overlap'; f.start = -1; f.end = -1; }
        else taken.push([f.start, f.end]);
      } else { f.start = -1; f.end = -1; }
      out.push(f);
    }
    out.sort(function (a, b) { return (a.start < 0 ? 1e12 : a.start) - (b.start < 0 ? 1e12 : b.start); });
    return out;
  }

  function apiErrorMessage(raw, status) {
    var msg = '';
    try {
      var v = JSON.parse(raw);
      if (v && v.error && v.error.message) msg = String(v.error.message);
      else if (v && v.message) msg = String(v.message);
    } catch (e) { /* not JSON */ }
    if (!msg) msg = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!msg) msg = 'no message in the reply';
    return 'HTTP ' + status + ' — ' + msg;
  }

  function liveCritique(text, lens, signal, key, model) {
    var body = {
      model: model,
      max_tokens: 1500,
      system: livePrompt(lens),
      messages: [{ role: 'user', content: text }]
    };
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (raw) {
        if (!res.ok) {
          var err = new Error(apiErrorMessage(raw, res.status));
          err.apiMessage = true;
          throw err;
        }
        var data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }
        var out = '';
        if (data && Array.isArray(data.content)) {
          for (var i = 0; i < data.content.length; i++) {
            var block = data.content[i];
            if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
          }
        }
        if (!out) out = raw;
        var items = extractJson(out);
        if (items === null) return { unparsed: out, findings: [] };
        return { findings: locateFindings(items, text) };
      });
    });
  }

  /* ---------- chunking ----------
     Some of the engine's work is superlinear in the length of one string, so long text is
     critiqued chunk by chunk with the frame handed back between chunks. Chunks are cut at a
     sentence end where there is one and at whitespace otherwise, never mid-token, and every
     chunk after the first is critiqued with atTextStart:false so offset 0 is not read as the
     start of a sentence. Metrics are never chunked: metrics() is O(n) and runs on the whole
     draft. Nothing is dropped, but a finding never spans a chunk boundary. */

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function isSpaceAt(text, i) {
    var c = text.charAt(i);
    return c !== '' && /\s/.test(c);
  }

  function splitChunks(text, target) {
    var out = [], i = 0, n = text.length;
    while (i < n) {
      var end = Math.min(n, i + target);
      if (end < n) {
        var floor = i + Math.floor(target / 2);
        var atSpace = -1, atSentence = -1, j, k, c;
        for (j = end; j > floor; j--) {
          if (!isSpaceAt(text, j - 1)) continue;
          if (atSpace === -1) atSpace = j;
          k = j - 2;
          while (k > i && isSpaceAt(text, k)) k--;
          c = text.charAt(k);
          if (c === '.' || c === '!' || c === '?') { atSentence = j; break; }
        }
        var cut = atSentence !== -1 ? atSentence : atSpace;
        if (cut === -1) {
          var limit = Math.min(n, end + Math.floor(target / 2));
          for (j = end; j < limit; j++) { if (isSpaceAt(text, j)) { cut = j + 1; break; } }
        }
        if (cut > i) end = Math.min(cut, n);
      }
      out.push({ start: i, text: text.slice(i, end) });
      i = end;
    }
    if (!out.length) out.push({ start: 0, text: text });
    return out;
  }

  function shiftFinding(f, offset) {
    return {
      rule: f.rule, ruleName: f.ruleName, quote: f.quote, why: f.why, display: f.display,
      replacement: (f.replacement === undefined ? null : f.replacement),
      start: (typeof f.start === 'number' ? f.start + offset : -1),
      end: (typeof f.end === 'number' ? f.end + offset : -1)
    };
  }

  /* One chunked offline critique: findings for the whole text, applied chunk by chunk. */
  function chunkedPass(text, lensId, alive) {
    var chunks = splitChunks(text, CHUNK_TARGET);
    var kept = [], total = 0, applied = 0, parts = [];
    var i = 0, last = now();

    function slice() {
      while (i < chunks.length) {
        if (!alive()) return Promise.resolve(null);
        var ch = chunks[i++];
        var res = CL.critique(ch.text, lensId, { atTextStart: ch.start === 0 });
        var fs = res.findings || [];
        var ap = CL.applyFindings(ch.text, fs);
        parts.push(ap.text);
        applied += ap.applied;
        total += fs.length;
        for (var k = 0; k < fs.length && kept.length < FINDINGS_KEEP_CAP; k++) {
          kept.push(shiftFinding(fs[k], ch.start));
        }
        if (now() - last > SLICE_BUDGET_MS) { last = now(); return yieldToPaint().then(slice); }
      }
      return Promise.resolve({
        findings: kept, total: total, after: parts.join(''), applied: applied, chunks: chunks.length
      });
    }
    return Promise.resolve().then(slice);
  }

  /* ---------- drivers ----------
     A driver is an iterator of passes: next() resolves to {done:false, value:pass} or
     {done:true, value:{converged, stoppedAt, finalText, passCount}}. The offline default
     path is CriticLoop.steps() itself, so the loop the page plays is the loop the suite
     tests. Live mode and chunked long text step the same shape from the page, because
     one needs the network and the other needs to hand the frame back mid-pass. */

  function enginePasses(text) {
    var it = CL.steps(text, { maxPasses: MAX_PASSES });
    return {
      next: function () { return Promise.resolve(it.next()); }
    };
  }

  /* Convergence, for the drivers the page steps itself: the draft is clean under every
     lens that has not run yet. Those lenses are simply run, and a tail of parsed passes
     that found nothing is what "clean under the rest" means. Nothing is guessed. */
  function tailConverged(passes) {
    var at = null;
    for (var i = passes.length - 1; i >= 0; i--) {
      var p = passes[i];
      if (p.unparsed !== undefined || p.total > 0) break;
      at = i + 1;
    }
    return { converged: at !== null, stoppedAt: at };
  }

  function pagePasses(text, opts) {
    var L = lenses();
    var passes = [];
    var current = text;
    var mCurrent = null;
    var i = 0;

    function result() {
      var t = tailConverged(passes);
      return {
        done: true,
        value: {
          converged: t.converged, stoppedAt: t.stoppedAt,
          finalText: current, passCount: passes.length
        }
      };
    }

    return {
      next: function () {
        if (i >= MAX_PASSES || i >= L.length) return Promise.resolve(result());
        var lens = L[i];
        var index = i + 1;
        i++;
        var before = current;
        if (mCurrent === null) mCurrent = CL.metrics(before);
        var mBefore = mCurrent;

        return opts.critique(before, lens).then(function (res) {
          if (!res) return { done: true, value: null };
          var after = res.after === undefined ? before : res.after;
          /* metrics() is O(n): the whole draft, every time, never summed over chunks. */
          var mAfter = after === before ? mBefore : CL.metrics(after);
          var pass = {
            index: index, lens: lens.id, lensName: lens.name, findings: res.findings || [],
            total: res.total || 0, before: before, after: after, applied: res.applied || 0,
            metricsBefore: mBefore, metricsAfter: mAfter, chunks: res.chunks || 1,
            unparsed: res.unparsed
          };
          passes.push(pass);
          current = after;
          mCurrent = mAfter;
          return { done: false, value: pass };
        });
      }
    };
  }

  /* ---------- the loop ---------- */

  function setBusy(busy) {
    var s;
    state.running = busy;
    els.run.disabled = busy;
    els.run.textContent = busy ? 'Running…' : 'Run';
    els.run.setAttribute('aria-busy', busy ? 'true' : 'false');
    /* Stop is not shown at all until there is a run to stop. */
    els.stop.hidden = !busy;
    els.stop.disabled = !busy;
    els.skip.hidden = !busy || reduceMotion;  /* nothing to skip when motion is already off */
    for (s = 0; s < sampleButtons.length; s++) sampleButtons[s].disabled = busy;
    for (s = 0; s < engineRadios.length; s++) engineRadios[s].disabled = busy;
    /* Run disables itself, so keyboard focus has to go somewhere real. */
    if (busy) {
      if (document.activeElement === els.run || document.activeElement === document.body) focusQuietly(els.stop);
    } else if (document.activeElement === els.stop || document.activeElement === els.skip ||
      document.activeElement === document.body) {
      focusQuietly(els.run);
    }
  }

  function resetTranscript() {
    clear(els.transcript);
    els.emptyNote.hidden = false;
    state.transcript = null;
    state.finalText = '';
  }

  function isLive() { return els.live.checked; }

  function stoppedNote() {
    /* Only when there is a transcript above it to be everything that had run. */
    if (els.transcript.firstChild) {
      renderNote('Stopped. The transcript above is everything that had run when you pressed Stop.');
    }
    setStatus('Stopped.');
  }

  function runLoop() {
    if (state.running) return;
    if (!CL || typeof CL.critique !== 'function') return;

    /* Validate before anything is cleared: a blank box must not destroy a finished run. */
    var raw = els.input.value;
    if (!raw || !raw.trim()) {
      setStatus('Nothing to critique. Paste a paragraph or load a sample first. The transcript is untouched.', 'error');
      els.input.focus();
      return;
    }

    var live = isLive();
    var key = live ? els.key.value.trim() : '';
    var model = live ? (els.model.value.trim() || 'claude-sonnet-4-5') : '';
    if (live && !key) {
      setStatus('Live mode needs an API key in the field above.', 'error');
      els.key.focus();
      return;
    }
    if (live && raw.length > LIVE_MAX_INPUT) {
      setStatus('That is ' + count(raw.length) + ' characters. Live mode sends at most ' +
        count(LIVE_MAX_INPUT) + '. Trim it, or use the offline critic.', 'error');
      return;
    }

    resetTranscript();
    state.skipAnimation = false;
    state.runToken++;
    var token = state.runToken;
    state.aborter = (typeof AbortController === 'function') ? new AbortController() : null;
    setBusy(true);
    setStatus(live ? 'Running — calling the API.' : 'Running the offline critic.', 'busy');
    state.followTail = true;
    state.readerScrolled = false;
    scrollIntoTail(els.section);

    var t0 = now();
    var alive = function () {
      return token === state.runToken && !(state.aborter && state.aborter.signal.aborted);
    };

    var chunked = !live && raw.length > CHUNK_THRESHOLD;
    var record = {
      engineLabel: live ? 'live (' + model + ')' : 'offline rule-based critic',
      draft0: raw, metrics0: null, passes: [], converged: false, stoppedAt: null, finalText: raw,
      chunks: 1
    };

    var driver;
    if (live) {
      driver = pagePasses(raw, {
        critique: function (before, lens) {
          return liveCritique(before, lens, state.aborter && state.aborter.signal, key, model)
            .then(function (res) {
              if (!alive()) return null;
              if (res.unparsed !== undefined) {
                return { findings: [], total: 0, after: before, applied: 0, chunks: 1, unparsed: res.unparsed };
              }
              var all = res.findings || [];
              var located = all.filter(function (f) { return f.located !== false; });
              var ap = located.length ? CL.applyFindings(before, located) : { text: before, applied: 0 };
              return { findings: all, total: all.length, after: ap.text, applied: ap.applied, chunks: 1 };
            });
        }
      });
    } else if (chunked) {
      driver = pagePasses(raw, {
        critique: function (before, lens) { return chunkedPass(before, lens.id, alive); }
      });
    } else if (CL && typeof CL.steps === 'function') {
      driver = enginePasses(raw);
    } else {
      /* Older engine without steps(): the page steps the same loop with critique(). */
      driver = pagePasses(raw, {
        critique: function (before, lens) {
          var c = CL.critique(before, lens.id, { atTextStart: true });
          var fs = c.findings || [];
          var ap = CL.applyFindings(before, fs);
          return Promise.resolve({
            findings: fs, total: fs.length, after: ap.text, applied: ap.applied, chunks: 1
          });
        }
      });
    }

    var chain = yieldToPaint().then(function () {
      if (!alive()) return;
      record.metrics0 = CL.metrics(raw);
      renderDraft0(raw, record.metrics0);
      if (chunked) {
        var n = splitChunks(raw, CHUNK_TARGET).length;
        record.chunks = n;
        renderNote('This text is ' + count(raw.length) + ' characters, so each pass critiques it in ' +
          count(n) + ' chunks of about ' + count(CHUNK_TARGET) + ' characters, cut at a sentence ' +
          'end where there is one and at whitespace otherwise, never mid-word. ' +
          'The page hands control back to the browser between chunks, so it stays usable. Metrics are ' +
          'measured on the whole draft, not summed over chunks. No text is dropped, but a finding ' +
          'never spans a chunk boundary.');
      }
    });

    function pump() {
      if (!alive()) return Promise.resolve(null);
      return Promise.resolve(driver.next()).then(function (step) {
        if (!alive() || !step) return null;
        if (step.done) return step.value || null;
        var pass = step.value;
        if (!pass) return null;
        var n = record.passes.length + 1;
        var lens = lensById(pass.lens);
        record.passes.push({
          index: n, lens: pass.lens, lensName: pass.lensName || lens.name,
          findings: pass.findings || [],
          total: (typeof pass.total === 'number' ? pass.total : (pass.findings || []).length),
          before: pass.before, after: pass.after, applied: pass.applied || 0,
          metricsBefore: pass.metricsBefore, metricsAfter: pass.metricsAfter,
          unparsed: pass.unparsed
        });
        var rec = record.passes[record.passes.length - 1];
        record.finalText = rec.after;

        return stepDelay().then(yieldToPaint).then(function () {
          if (!alive()) return null;
          renderCritique(n, lens, rec.findings, {
            unparsed: rec.unparsed, total: rec.total, applied: rec.applied, chunks: pass.chunks
          });
          if (rec.unparsed !== undefined || rec.total === 0) return null;
          return stepDelay().then(yieldToPaint).then(function () {
            if (!alive()) return null;
            /* A pass that applied nothing gets a "no change" line, not a second copy
               of the draft rendered as an all-same diff. */
            if (rec.after === rec.before) renderNoChange(n, rec.findings);
            else renderDraft(n, rec.before, rec.after, rec.metricsBefore, rec.metricsAfter, rec.applied);
            return null;
          });
        }).then(pump);
      });
    }

    chain.then(pump).then(function (result) {
      if (token !== state.runToken) return;
      if (!alive()) { stoppedNote(); return; }
      /* The verdict is the generator's, not the page's. */
      if (result) {
        record.converged = !!result.converged;
        record.stoppedAt = (typeof result.stoppedAt === 'number') ? result.stoppedAt : null;
        if (typeof result.finalText === 'string') record.finalText = result.finalText;
      }
      state.transcript = record;
      state.finalText = record.finalText;
      return stepDelay().then(function () {
        if (token !== state.runToken) return;
        renderFinal(record);
        var ms = now() - t0;
        setStatus('Done in ' + (ms / 1000).toFixed(1) + ' s. ' + verdictLine(record));
      });
    }).catch(function (err) {
      if (token !== state.runToken) return;
      var name = err && err.name;
      if (name === 'AbortError' || !alive()) { stoppedNote(); return; }
      var msg = (err && err.apiMessage) ? err.message
        : (name === 'TypeError' ? 'The request did not reach api.anthropic.com. Check the network and the key field.'
          : String((err && err.message) || err));
      setStatus(msg, 'error');
      renderNote('The run stopped here: ' + msg);
    }).then(function () {
      if (token === state.runToken) setBusy(false);
    });
  }

  /* ---------- wiring ---------- */

  els.input.addEventListener('input', updateCounter);

  for (var s = 0; s < sampleButtons.length; s++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        if (state.running) return;
        els.input.value = sampleText(btn.getAttribute('data-sample'));
        updateCounter();
        setStatus('Sample loaded. Press Run.');
        els.input.focus();
      });
    })(sampleButtons[s]);
  }

  els.run.addEventListener('click', runLoop);

  els.stop.addEventListener('click', function () {
    if (!state.running) return;
    if (state.aborter) { try { state.aborter.abort(); } catch (e) { /* nothing to do */ } }
    state.runToken++;
    setBusy(false);
    stoppedNote();
  });

  els.skip.addEventListener('click', function () {
    state.skipAnimation = true;
    setStatus('Animation skipped for this run.', 'busy');
  });

  function engineChanged() {
    if (state.running) return;
    var live = isLive();
    els.livePanel.hidden = !live;
    setStatus(live
      ? 'Live mode. Requests go to api.anthropic.com from this page.'
      : 'Offline critic. Nothing leaves this page.');
  }
  for (var r = 0; r < engineRadios.length; r++) engineRadios[r].addEventListener('change', engineChanged);

  updateCounter();
  els.livePanel.hidden = !isLive();
  els.stop.hidden = true;
})();
