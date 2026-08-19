/* critic-loop — page logic. Renders the loop, one panel at a time.
   Every string that came from a user or from an API is inserted with textContent.
   There is no innerHTML in this file. */
(function () {
  'use strict';

  var MAX_PASSES = 3;
  var STEP_MS = 250;
  var DRAFT_DISPLAY_CHARS = 6000;    /* panels show this much; copy and export use all of it */
  var FINDINGS_RENDER_CAP = 60;
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
    livePanel: $('live-panel'), key: $('api-key'), model: $('model'),
    offline: $('engine-offline'), live: $('engine-live')
  };

  var state = {
    running: false,
    skipAnimation: false,
    aborter: null,
    runToken: 0,
    finalText: '',
    transcript: null
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

  function srOnly(text) { return el('span', 'sr-only', text); }

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

  function signed(d) {
    if (d === 0) return '±0';
    return (d > 0 ? '+' : '−') + num(Math.abs(d));
  }

  function shortenForDisplay(text, limit) {
    var t = String(text == null ? '' : text);
    if (t.length <= limit) return { text: t, truncated: false, total: t.length };
    return { text: t.slice(0, limit), truncated: true, total: t.length };
  }

  /* ---------- engine presence ---------- */

  var CL = window.CriticLoop;
  if (!CL || typeof CL.critique !== 'function') {
    els.run.disabled = true;
    setStatus('The critic engine did not load, so nothing can run. critic.js is missing.', 'error');
  }

  function lenses() {
    return (CL && CL.LENSES) || [{ id: 'clarity', name: 'Clarity', blurb: '' }];
  }

  /* ---------- samples ---------- */

  function sampleText(name) {
    var node = document.getElementById('sample-' + name);
    return node ? node.textContent.trim() : '';
  }

  function updateCounter() {
    var n = els.input.value.length;
    els.counter.textContent = n === 1 ? '1 character' : n.toLocaleString('en-US') + ' characters';
  }

  /* ---------- metrics strip ---------- */

  var METRIC_ROWS = [
    { key: 'words', label: 'words' },
    { key: 'sentences', label: 'sentences' },
    { key: 'meanSentenceLength', label: 'mean sentence' },
    { key: 'hedges', label: 'hedges' }
  ];

  function metricsStrip(m, prev) {
    var wrap = el('div', 'metrics');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Metrics for this draft');
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
    if (m && m.chunked) wrap.appendChild(el('span', 'metric', 'summed over chunks'));
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
  }

  function draftBody(p, text) {
    var shown = shortenForDisplay(text, DRAFT_DISPLAY_CHARS);
    p.appendChild(el('p', 'draft-text', shown.text));
    if (shown.truncated) {
      p.appendChild(el('p', 'truncated-note',
        'Showing the first ' + DRAFT_DISPLAY_CHARS.toLocaleString('en-US') + ' of ' +
        shown.total.toLocaleString('en-US') + ' characters. Copy and export use the whole draft.'));
    }
  }

  function renderDraft0(text, m) {
    var p = panel('draft');
    label(p, 'Draft 0');
    draftBody(p, text);
    p.appendChild(metricsStrip(m, null));
    addTranscript(p);
  }

  function diffNodes(ops) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i] || {};
      var t = String(op.text == null ? '' : op.text);
      if (!t) continue;
      if (op.type === 'del' || op.type === 'ins') {
        var isDel = op.type === 'del';
        var s = el('span', isDel ? 'd-del' : 'd-ins');
        s.appendChild(srOnly(isDel ? ' deleted: ' : ' inserted: '));
        s.appendChild(el('span', 'd-mark', isDel ? '−' : '+'));
        s.appendChild(document.createTextNode(t));
        frag.appendChild(s);
      } else {
        frag.appendChild(document.createTextNode(t));
      }
    }
    return frag;
  }

  function renderDraft(index, before, after, mBefore, mAfter, applied) {
    var p = panel('draft');
    label(p, 'Draft ' + index);

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
            'Showing the first ' + DRAFT_DISPLAY_CHARS.toLocaleString('en-US') + ' of ' +
            shown.total.toLocaleString('en-US') + ' characters.'));
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
        : applied.toLocaleString('en-US') + ' findings applied to make this draft.'));
    p.appendChild(metricsStrip(mAfter, mBefore));
    addTranscript(p);
  }

  function renderFinding(f) {
    var d = el('details', 'finding');
    d.open = true;
    var s = document.createElement('summary');
    s.appendChild(el('span', 'rule-name', String(f.ruleName || f.rule || 'Finding')));
    s.appendChild(el('span', 'quote', shortenForDisplay(String(f.quote == null ? '' : f.quote), QUOTE_DISPLAY_CHARS).text));
    d.appendChild(s);

    var body = el('div', 'finding-body');
    body.appendChild(el('p', 'why', String(f.why == null ? '' : f.why)));

    var repl = el('p', 'repl');
    if (f.replacement === null || f.replacement === undefined) {
      repl.appendChild(el('span', 'repl-none', 'Pointer only — the loop will not rewrite this one for you.'));
    } else if (f.located === false) {
      repl.appendChild(el('span', 'repl-none', 'The model quoted text that is not in this draft, so nothing was changed.'));
    } else {
      repl.appendChild(el('span', 'repl-arrow', '→ '));
      if (String(f.replacement) === '') repl.appendChild(el('span', 'repl-empty', '(delete it)'));
      else repl.appendChild(el('span', 'repl-text', String(f.replacement)));
    }
    body.appendChild(repl);
    d.appendChild(body);
    return d;
  }

  function renderCritique(index, lens, findings, extra) {
    var p = panel('critique');
    label(p, 'Critique ' + index, lens && lens.name ? lens.name : '');
    if (lens && lens.blurb) p.appendChild(el('p', 'panel-blurb', lens.blurb));

    if (extra && extra.unparsed !== undefined) {
      p.appendChild(el('p', 'why', 'The model did not answer with findings this page could parse. Its reply is shown as it came back, unparsed. Nothing was applied.'));
      p.appendChild(el('p', 'quote', shortenForDisplay(String(extra.unparsed), 4000).text));
      addTranscript(p);
      return;
    }

    if (!findings.length && !(extra && extra.total)) {
      p.appendChild(el('p', 'why', 'Found nothing — the loop stops here.'));
      p.appendChild(el('p', 'panel-blurb',
        'A critic with no findings is the termination condition. There is no pass ' + (index + 1) + '.'));
      addTranscript(p);
      return;
    }

    var total = (extra && typeof extra.total === 'number') ? extra.total : findings.length;
    var list = el('ul', 'findings');
    var shown = Math.min(findings.length, FINDINGS_RENDER_CAP);
    for (var i = 0; i < shown; i++) {
      var li = el('li');
      li.appendChild(renderFinding(findings[i]));
      list.appendChild(li);
    }
    p.appendChild(list);
    if (total > shown) {
      p.appendChild(el('p', 'capped-note',
        (total - shown).toLocaleString('en-US') + ' more findings are not listed here, to keep the page quick. ' +
        'All ' + total.toLocaleString('en-US') + ' were applied to the next draft.'));
    }
    p.appendChild(el('p', 'pass-summary',
      (total === 1 ? '1 finding' : total.toLocaleString('en-US') + ' findings') +
      (extra && extra.chunks > 1 ? ' across ' + extra.chunks.toLocaleString('en-US') + ' chunks.' : '.')));
    addTranscript(p);
  }

  function renderNote(text) {
    var p = panel('note');
    p.appendChild(el('p', 'why', text));
    addTranscript(p);
  }

  function renderFinal(result) {
    var p = panel('final');
    label(p, 'Result');
    var head = result.converged
      ? 'Converged after ' + result.stoppedAt + (result.stoppedAt === 1 ? ' pass.' : ' passes.')
      : MAX_PASSES + ' passes, still finding things.';
    p.appendChild(el('p', 'final-head', head));
    p.appendChild(el('p', 'panel-blurb', result.converged
      ? 'Pass ' + result.stoppedAt + ' found nothing, so the loop stopped early. That is the whole termination rule.'
      : 'The cap is ' + MAX_PASSES + ' passes. The critic still had things to say when it hit the cap.'));
    draftBody(p, result.finalText);

    var actions = el('div', 'final-actions');
    var copy = el('button', 'btn', 'Copy final draft');
    copy.type = 'button';
    var exp = el('button', 'btn', 'Export transcript (Markdown)');
    exp.type = 'button';
    var note = el('span', 'status');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');

    copy.addEventListener('click', function () { copyText(result.finalText, note); });
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
        out.push('The reply could not be parsed as findings. Raw reply:');
        out.push('');
        out.push(mdFence(p.unparsed));
      } else if (!p.findings.length) {
        out.push('Found nothing. The loop stops here.');
        out.push('');
      } else {
        var listed = Math.min(p.findings.length, 400);
        for (var j = 0; j < listed; j++) {
          var f = p.findings[j];
          out.push('- **' + String(f.ruleName || f.rule || 'finding') + '** — quote: "' +
            String(f.quote == null ? '' : f.quote).replace(/\s+/g, ' ') + '"');
          out.push('  - why: ' + String(f.why == null ? '' : f.why));
          out.push('  - ' + (f.replacement === null || f.replacement === undefined
            ? 'pointer only, not applied'
            : (f.located === false ? 'quote not found in the draft, not applied'
              : 'replacement: "' + String(f.replacement) + '"')));
        }
        if ((p.total || p.findings.length) > listed) {
          out.push('- (' + ((p.total || p.findings.length) - listed) + ' further findings not listed)');
        }
        out.push('');
        out.push('Applied: ' + p.applied + ' of ' + (p.total || p.findings.length) + '.');
        out.push('');
        out.push('## Draft ' + p.index);
        out.push('');
        out.push(mdFence(p.after));
        out.push('Metrics: ' + metricLine(p.metricsAfter));
        out.push('');
      }
    }
    out.push('## Result');
    out.push('');
    out.push(t.converged
      ? 'Converged after ' + t.stoppedAt + ' pass(es).'
      : MAX_PASSES + ' passes, still finding things.');
    out.push('');
    out.push(mdFence(t.finalText));
    out.push('No API key is included in this file.');
    return out.join('\n');
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

  /* Turn loose model output into findings with real, non-overlapping spans in `text`. */
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
        replacement: replacement, start: start, end: start + quote.length, located: start !== -1
      };
      if (f.located) {
        var overlaps = false;
        for (var k = 0; k < taken.length; k++) {
          if (f.start < taken[k][1] && taken[k][0] < f.end) { overlaps = true; break; }
        }
        if (overlaps) { f.located = false; f.start = -1; f.end = -1; }
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
     The engine is a black box and some of its work is quadratic in the length of a string.
     So long text is cut into chunks, each chunk is critiqued on its own, and the page hands
     the frame back between chunks. Nothing is dropped; findings just never cross a boundary. */

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function splitChunks(text, target) {
    var out = [], i = 0, n = text.length;
    while (i < n) {
      var end = Math.min(n, i + target);
      if (end < n) {
        var limit = Math.min(n, end + Math.floor(target / 2));
        var cut = -1, j;
        for (j = end; j < limit; j++) {
          var c = text.charAt(j);
          if ((c === '.' || c === '!' || c === '?') && j + 1 < n && /\s/.test(text.charAt(j + 1))) { cut = j + 2; break; }
        }
        if (cut === -1) {
          for (j = end; j < limit; j++) { if (/\s/.test(text.charAt(j))) { cut = j + 1; break; } }
        }
        if (cut > 0) end = Math.min(cut, n);
      }
      out.push({ start: i, text: text.slice(i, end) });
      i = end;
    }
    if (!out.length) out.push({ start: 0, text: text });
    return out;
  }

  function shiftFinding(f, offset) {
    return {
      rule: f.rule, ruleName: f.ruleName, quote: f.quote, why: f.why,
      replacement: (f.replacement === undefined ? null : f.replacement),
      start: (typeof f.start === 'number' ? f.start + offset : -1),
      end: (typeof f.end === 'number' ? f.end + offset : -1)
    };
  }

  /* One offline pass: critique + apply, chunked when the text is long. */
  function offlinePass(text, lensId, alive) {
    if (text.length <= CHUNK_THRESHOLD) {
      var c = CL.critique(text, lensId);
      var findings = c.findings || [];
      var ap = CL.applyFindings(text, findings);
      return Promise.resolve({
        findings: findings, total: findings.length, after: ap.text, applied: ap.applied, chunks: 1
      });
    }
    var chunks = splitChunks(text, CHUNK_TARGET);
    var kept = [], total = 0, applied = 0, parts = [];
    var i = 0, last = now();

    function slice() {
      while (i < chunks.length) {
        if (!alive()) return Promise.resolve(null);
        var ch = chunks[i++];
        var res = CL.critique(ch.text, lensId);
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

  /* Metrics over long text, summed chunk by chunk, with the same yielding. */
  function metricsFor(text, alive) {
    if (text.length <= CHUNK_THRESHOLD) return Promise.resolve(CL.metrics(text));
    var chunks = splitChunks(text, CHUNK_TARGET);
    var agg = { words: 0, sentences: 0, hedges: 0, chars: 0, meanSentenceLength: 0, chunked: true };
    var i = 0, last = now();
    function slice() {
      while (i < chunks.length) {
        if (!alive()) return Promise.resolve(agg);
        var m = CL.metrics(chunks[i++].text) || {};
        agg.words += m.words || 0;
        agg.sentences += m.sentences || 0;
        agg.hedges += m.hedges || 0;
        agg.chars += m.chars || 0;
        if (now() - last > SLICE_BUDGET_MS) { last = now(); return yieldToPaint().then(slice); }
      }
      agg.meanSentenceLength = agg.sentences ? Math.round((agg.words / agg.sentences) * 10) / 10 : 0;
      return Promise.resolve(agg);
    }
    return Promise.resolve().then(slice);
  }

  /* ---------- the loop ---------- */

  function setBusy(busy) {
    state.running = busy;
    els.run.disabled = busy;
    els.stop.disabled = !busy;
    els.skip.hidden = !busy || reduceMotion;  /* nothing to skip when motion is already off */
    els.run.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function resetTranscript() {
    clear(els.transcript);
    els.emptyNote.hidden = false;
    state.transcript = null;
    state.finalText = '';
  }

  function isLive() { return els.live.checked; }

  function runLoop() {
    if (state.running) return;
    if (!CL || typeof CL.critique !== 'function') return;

    var raw = els.input.value;
    if (!raw || !raw.trim()) {
      resetTranscript();
      setStatus('Nothing to critique. Paste a paragraph or load a sample first.', 'error');
      els.input.focus();
      return;
    }

    var live = isLive();
    var key = live ? els.key.value.trim() : '';
    var model = live ? (els.model.value.trim() || 'claude-sonnet-4-5') : '';
    if (live && !key) {
      resetTranscript();
      setStatus('Live mode needs an API key in the field above.', 'error');
      els.key.focus();
      return;
    }
    if (live && raw.length > LIVE_MAX_INPUT) {
      resetTranscript();
      setStatus('That is ' + raw.length.toLocaleString('en-US') + ' characters. Live mode sends at most ' +
        LIVE_MAX_INPUT.toLocaleString('en-US') + '. Trim it, or use the offline critic.', 'error');
      return;
    }

    resetTranscript();
    state.skipAnimation = false;
    state.runToken++;
    var token = state.runToken;
    state.aborter = (typeof AbortController === 'function') ? new AbortController() : null;
    setBusy(true);
    setStatus(live ? 'Running — calling the API.' : 'Running the offline critic.', 'busy');

    var t0 = now();
    var alive = function () {
      return token === state.runToken && !(state.aborter && state.aborter.signal.aborted);
    };

    var LENS = lenses();
    var record = {
      engineLabel: live ? 'live (' + model + ')' : 'offline rule-based critic',
      draft0: raw, metrics0: null, passes: [], converged: false, stoppedAt: null, finalText: raw,
      chunks: 1, findingsCapped: false
    };

    var current = raw;
    var currentMetrics = null;

    var chain = yieldToPaint().then(function () {
      return metricsFor(current, alive);
    }).then(function (m) {
      if (!alive()) return;
      record.metrics0 = m;
      currentMetrics = m;
      renderDraft0(current, m);
      if (!live && current.length > CHUNK_THRESHOLD) {
        var n = splitChunks(current, CHUNK_TARGET).length;
        record.chunks = n;
        renderNote('This text is ' + current.length.toLocaleString('en-US') + ' characters, so it is ' +
          'critiqued in ' + n.toLocaleString('en-US') + ' chunks of about ' + CHUNK_TARGET.toLocaleString('en-US') +
          ' characters. The page hands control back to the browser between chunks, so it stays usable. ' +
          'No text is dropped, but a finding never spans a chunk boundary.');
      }
    });

    var makePass = function (i) {
      return function () {
        if (!alive() || record.converged) return;
        var lens = LENS[i % LENS.length];
        var before = current;
        var mBefore = currentMetrics;

        return stepDelay().then(yieldToPaint).then(function () {
          if (!alive()) return null;
          if (live) {
            return liveCritique(before, lens, state.aborter && state.aborter.signal, key, model)
              .then(function (res) {
                if (res.unparsed !== undefined) {
                  return { findings: [], total: 0, after: before, applied: 0, chunks: 1, unparsed: res.unparsed };
                }
                var located = (res.findings || []).filter(function (f) { return f.located !== false; });
                var ap = (res.findings || []).length ? CL.applyFindings(before, located) : { text: before, applied: 0 };
                return {
                  findings: res.findings || [], total: (res.findings || []).length,
                  after: ap.text, applied: ap.applied, chunks: 1
                };
              });
          }
          return offlinePass(before, lens.id, alive);
        }).then(function (res) {
          if (!alive() || !res) return;
          if (res.total > res.findings.length) record.findingsCapped = true;
          renderCritique(i + 1, lens, res.findings, {
            unparsed: res.unparsed, total: res.total, chunks: res.chunks
          });

          if (res.unparsed === undefined && res.total === 0) {
            record.passes.push({
              index: i + 1, lens: lens.id, lensName: lens.name, findings: res.findings, total: 0,
              before: before, after: before, applied: 0, metricsBefore: mBefore, metricsAfter: mBefore
            });
            record.converged = true;
            record.stoppedAt = i + 1;
            return;
          }

          return metricsFor(res.after, alive).then(function (mAfter) {
            if (!alive()) return;
            record.passes.push({
              index: i + 1, lens: lens.id, lensName: lens.name, findings: res.findings, total: res.total,
              before: before, after: res.after, applied: res.applied,
              metricsBefore: mBefore, metricsAfter: mAfter, unparsed: res.unparsed
            });
            current = res.after;
            currentMetrics = mAfter;
            record.finalText = current;
            if (res.unparsed !== undefined) return;
            return stepDelay().then(yieldToPaint).then(function () {
              if (!alive()) return;
              renderDraft(i + 1, before, res.after, mBefore, mAfter, res.applied);
            });
          });
        });
      };
    };

    for (var i = 0; i < MAX_PASSES; i++) chain = chain.then(makePass(i));

    chain.then(function () {
      if (token !== state.runToken) return;
      if (!alive()) {
        renderNote('Stopped. The transcript above is everything that had run when you pressed Stop.');
        setStatus('Stopped.');
        return;
      }
      state.transcript = record;
      state.finalText = record.finalText;
      return stepDelay().then(function () {
        if (token !== state.runToken) return;
        renderFinal(record);
        var ms = now() - t0;
        setStatus('Done in ' + (ms / 1000).toFixed(1) + ' s. ' +
          (record.converged ? 'Converged after ' + record.stoppedAt + '.' : 'Hit the ' + MAX_PASSES + '-pass cap.'));
      });
    }).catch(function (err) {
      if (token !== state.runToken) return;
      var name = err && err.name;
      if (name === 'AbortError' || !alive()) {
        renderNote('Stopped. The transcript above is everything that had run when you pressed Stop.');
        setStatus('Stopped.');
        return;
      }
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

  var sampleButtons = document.querySelectorAll('[data-sample]');
  for (var s = 0; s < sampleButtons.length; s++) {
    (function (btn) {
      btn.addEventListener('click', function () {
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
    renderNote('Stopped. The transcript above is everything that had run when you pressed Stop.');
    setStatus('Stopped.');
  });

  els.skip.addEventListener('click', function () {
    state.skipAnimation = true;
    setStatus('Animation skipped for this run.', 'busy');
  });

  function engineChanged() {
    var live = isLive();
    els.livePanel.hidden = !live;
    setStatus(live
      ? 'Live mode. Requests go to api.anthropic.com from this page.'
      : 'Offline critic. Nothing leaves this page.');
  }
  els.offline.addEventListener('change', engineChanged);
  els.live.addEventListener('change', engineChanged);

  updateCounter();
  els.livePanel.hidden = !isLive();
})();
