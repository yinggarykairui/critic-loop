/* critic-loop — page logic. Renders the loop, one panel at a time.
   Every string that came from a user or from an API is inserted with textContent.
   There is no innerHTML in this file. */
(function () {
  'use strict';

  var MAX_PASSES = 3;
  var STEP_MS = 250;
  var DRAFT_DISPLAY_CHARS = 6000;    /* panels show this much; copy and export use all of it */
  var FINDINGS_RENDER_CAP = 60;
  /* openFlags opens the first applicable finding of each rule, so this cap counts rules,
     not findings: a pass whose applicable findings span more than this many rules renders
     every one of them closed. Ten open boxes is where a panel stops teaching and starts
     being a wall. No pass of the four samples reaches it — the most any of them opens is
     three — and a pass that did is one press of Expand all away. */
  var FINDINGS_OPEN_CAP = 10;
  var FINDINGS_KEEP_CAP = 3000;      /* how many finding objects a pass holds on to */
  var DIFF_CHAR_LIMIT = 12000;       /* above this the word diff is skipped, and says so */
  var CHUNK_THRESHOLD = 6000;        /* text longer than this is critiqued in chunks */
  /* Both are characters, counted the way the counter under the box counts and the way the
     display caps above cut: a code point, not the UTF-16 unit it is stored in. They used
     to be unit lengths, so one paste could be told two different things in one word —
     "3,077 characters" under the box, then "4 findings across 3 chunks" and "too large for
     a word-level diff" from a 6,000 and a 12,000 that had counted 6,077. */
  var CHUNK_TARGET = 3000;           /* chunk size, in characters */
  var SLICE_BUDGET_MS = 12;          /* work this long, then hand the frame back */
  var QUOTE_DISPLAY_CHARS = 400;
  var LIVE_MAX_INPUT = 12000;

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    input: $('input'), counter: $('counter'), run: $('run'), stop: $('stop'), skip: $('skip'),
    runbar: $('runbar'),
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

  /* One rounding rule, in one place: both column formats print at one decimal, and the
     strip's deltas are taken on the numbers that rule produces. */
  function snap1(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 0;
    return Math.round(n * 10) / 10;
  }

  /* Thousands are grouped wherever the strip prints a number. count() grouped and num() did
     not, so a 43,299-character paste rendered "edits applied 1,000 · words 7400 → 5100
     (−2300)" — two thousands conventions in one row, on numbers read side by side. num is
     count applied to the snapped value: one grouping rule, in one place. */
  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    return count(snap1(n));
  }

  function count(n) { return Number(n || 0).toLocaleString('en-US'); }

  /* A mean keeps its decimal even when it lands on a whole number: the strip used to print
     "mean word 5.3 → 5 (−0.3)", three numbers in two shapes, one of which reads as an
     integer count. Counts — words, sentences, hedges — are whole and keep num(). */
  function num1(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0.0';
    /* toFixed alone is not this rounding: (0.15).toFixed(1) is "0.1", because 0.15 is
       stored a hair below the midpoint. The strip rounds a half up, everywhere, and snap1
       has already done it here — so the format below only has to print one decimal and
       group the thousands, which is the same grouping count() and num() use. A mean is a
       number on the same strip as the counts, and two drafts of 1,200 words each would
       otherwise print "words 2,400" beside "mean sentence (words) 1200.0". */
    return snap1(n).toLocaleString('en-US',
      { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function signed(d, fmt) {
    if (d === 0) return '±0';
    return (d > 0 ? '+' : '−') + (fmt || num)(Math.abs(d));
  }

  /* A string's characters as a reader counts them: an astral character is one, not the two
     UTF-16 units it is stored as. Array.from would do it in one word; this file targets no
     build step and no polyfill, and the loop is the same thing spelled out. */
  function codePoints(s) {
    var out = [], i = 0, c, code;
    while (i < s.length) {
      c = s.charAt(i);
      code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        var next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { c = s.slice(i, i + 2); i++; }
      }
      out.push(c);
      i++;
    }
    return out;
  }

  /* The same count without the array. codePoints exists to be sliced; a limit only needs
     the number, and the counter under the box recomputes it on every keystroke, where
     allocating one string per character of a ten-megabyte paste is a cost with nothing to
     show for it. `stopAt` ends the walk as soon as the count reaches the number the caller
     is comparing against, so a limit test costs the limit and not the paste. */
  function codePointCount(s, stopAt) {
    var t = String(s == null ? '' : s), n = 0, i = 0, len = t.length, code, next;
    while (i < len) {
      code = t.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
        next = t.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
      }
      n++; i++;
      if (stopAt !== undefined && n >= stopAt) return n;
    }
    return n;
  }

  /* Is this text longer than `limit` characters? A string is never fewer UTF-16 units than
     it is code points, so one whose unit length is within the limit is within it in
     characters too and is answered without a walk at all. Pure ASCII takes that branch
     every time, which is why the thresholds behave identically on ASCII: 5,999 / 6,000 /
     6,001 units of ASCII are 5,999 / 6,000 / 6,001 characters. */
  function longerThan(text, limit) {
    var t = String(text == null ? '' : text);
    return t.length > limit && codePointCount(t, limit + 1) > limit;
  }

  /* The diff limit is on the two drafts together, so the pair is counted as one length.
     The second walk is given only the budget the first left, and neither runs when the
     units already fit. */
  function pairLongerThan(a, b, limit) {
    var x = String(a == null ? '' : a), y = String(b == null ? '' : b);
    if (x.length + y.length <= limit) return false;
    var n = codePointCount(x, limit + 1);
    if (n > limit) return true;
    return n + codePointCount(y, limit + 1 - n) > limit;
  }

  /* The cut and both numbers beside it count the way clipApiError already counts, and for
     the same reason: a character is what a reader counts, not the UTF-16 unit it is stored
     as. Cutting on units got both halves wrong at once — 'A' + one emoji 3,000 times is
     3,001 characters and the note read "Showing the first 6,000 of 6,001 characters", and
     the cut at unit 6,000 landed inside a surrogate pair, so the panel ended on half an
     emoji. Slicing code points cuts between characters and prints the numbers on the page. */
  function shortenForDisplay(text, limit) {
    var t = String(text == null ? '' : text);
    var chars = codePoints(t);
    if (chars.length <= limit) return { text: t, truncated: false, total: chars.length };
    return { text: chars.slice(0, limit).join(''), truncated: true, total: chars.length };
  }

  /* A quoted span is capped like every other long thing on this page, but a quote cut
     mid-word reads as broken text rather than shortened text. So the cut moves back to the
     last space at or before the cap, the trailing space goes, and an ellipsis ends the
     line: the elision is on screen, in the quote itself. shown is how many characters of
     the source are on screen, which is what the note beside the quote states — it is the
     length after the word-boundary walk, not the cap. A span with no space inside the cap
     falls back to a hard cut.

     The walk and both printed numbers run over code points, the same count clipApiError
     uses. On units the surrogate guard stopped the cut splitting a pair, but the numbers
     were still UTF-16 lengths: a 504-character span of emoji prose printed "Showing the
     first 400 of 552 characters" beside a quote a reader counts 368 of. Walking the code
     points makes the note the count on the page, and makes the split impossible rather
     than guarded against after the fact. */
  function shortenQuoteForDisplay(text, limit) {
    var t = String(text == null ? '' : text);
    var chars = codePoints(t);
    if (chars.length <= limit) {
      return { text: t, truncated: false, total: chars.length, shown: chars.length };
    }
    var end = limit;
    while (end > 0 && !/\s/.test(chars[end])) end--;
    var head = (end > 0 ? chars.slice(0, end) : chars.slice(0, limit)).join('').replace(/\s+$/, '');
    if (!head) head = chars.slice(0, limit).join('');
    return { text: head + '\u2026', truncated: true, total: chars.length,
             shown: codePoints(head).length };
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

  /* The run-control strip is fixed over the foot of the viewport while a run is in flight,
     so the bottom of the usable viewport is that much higher while it is there. */
  function bottomInset() {
    var bar = els.runbar;
    if (!bar || bar.hidden) return 0;
    var r = bar.getBoundingClientRect();
    return r.height || 0;
  }

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
    var vh = (window.innerHeight || 800) - bottomInset();
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
    var vh = (window.innerHeight || 800) - bottomInset();
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
  /* The page owns no critic and no verdict of its own: it needs the engine's critique,
     its convergence test and its wording, or it has nothing honest to show. */
  var engineOk = !!(CL && typeof CL.critique === 'function' && typeof CL.applyFindings === 'function' &&
    typeof CL.metrics === 'function' && typeof CL.steps === 'function' &&
    typeof CL.tailClean === 'function' && typeof CL.verdict === 'function');
  if (!engineOk) {
    els.run.disabled = true;
    setStatus('The critic engine did not load, so nothing can run. critic.js is missing or older than this page.', 'error');
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

  /* What counts as an empty box, and nothing else: a run critiques exactly the characters
     the reader pasted, so this test normalises a copy and never the text itself.

     trim() removes Unicode whitespace, which is why three non-breaking spaces were already
     caught. It leaves the zero-width and format characters, which are just as invisible:
     three zero-width spaces ran a full three-pass critique of nothing and reported the
     draft clean. A box holding nothing a reader can see is empty however that invisibility
     is spelled — zero-width space, the two joiners, the bidi marks and embeddings, the
     word joiner, a byte-order mark, a soft hyphen — so they all come out before the test.
     A zero-width space inside real prose is untouched: it only stops the text being empty,
     which it does. */
  var INVISIBLE = /[\s\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;

  function isBlankInput(value) {
    return String(value == null ? '' : value).replace(INVISIBLE, '') === '';
  }

  /* The counter under the box counts characters the way the three display caps count them:
     a paste of 50 emoji is 50 characters, and used to read "100 characters". The label is
     its own function so the suite can read it with no page around it. */
  function counterLabel(value) {
    var n = codePointCount(value);
    return n === 1 ? '1 character' : count(n) + ' characters';
  }

  function updateCounter() {
    els.counter.textContent = counterLabel(els.input.value);
  }

  /* ---------- the verdict ----------
     CriticLoop.verdict() is the only implementation of the wording, and the only thing
     that decides which of the three outcomes a run had: stopped early before the cap,
     reached the cap clean, reached the cap with findings outstanding. The status line,
     the Result panel and the exported Markdown all print the string it returns, so the
     three cannot disagree by a single byte. */

  function unparsedPasses(rec) {
    var n = 0;
    for (var i = 0; i < rec.passes.length; i++) if (rec.passes[i].unparsed !== undefined) n++;
    return n;
  }

  function appliedTotal(rec) {
    var n = 0;
    for (var i = 0; i < rec.passes.length; i++) n += rec.passes[i].applied || 0;
    return n;
  }

  function verdictLine(rec) {
    return CL.verdict({
      passesRun: rec.passes.length,
      /* Stopping early is a claim about the cap, so the cap goes with it and the engine
         decides: the page does not second-guess a lookahead by subtracting passes here. */
      maxPasses: MAX_PASSES,
      converged: !!rec.converged,
      cappedClean: !!rec.cappedClean,
      /* A run whose replies could not be read at all is its own outcome, and the engine
         has the sentence for it. */
      unparsed: unparsedPasses(rec),
      /* A run that reaches the cap with work outstanding has usually still changed the
         draft, and the sentence says what landed before it says what is left. Summed in
         this one place, so the status line, the Result panel and the exported Markdown
         cannot disagree about the number any more than they can about the wording. */
      applied: appliedTotal(rec)
    });
  }

  /* The line under the verdict explains the machine, and never restates the outcome —
     including when every reply was unreadable, which is the verdict's own fourth sentence. */
  function verdictNote(rec) {
    var unparsed = unparsedPasses(rec);
    if (unparsed > 0 && unparsed < rec.passes.length) {
      return 'An unparseable reply is not a pass that found nothing. ' + count(unparsed) +
        ' of ' + count(rec.passes.length) + ' replies could not be read as findings.';
    }
    return 'The cap is ' + MAX_PASSES + ' passes. One lens runs per pass, and a pass that finds ' +
      'nothing is checked against every lens that has not run yet before the loop calls it clean.';
  }

  /* ---------- metrics strip ---------- */

  /* The two mean columns are read side by side and are not the same unit, so each names
     its own: mean sentence counts words, mean word counts characters. `mean` marks the
     columns that print a decimal even on a whole number. */
  /* What separates one exported field from the next. It is a constant so the suite can
     split the line on the same string the line was built with. */
  var METRIC_SEP = ' · ';

  var METRIC_ROWS = [
    { key: 'words', label: 'words' },
    { key: 'sentences', label: 'sentences' },
    { key: 'meanSentenceLength', label: 'mean sentence (words)', mean: true },
    /* Mean word length is a column a clarity pass moves without moving the word count: a
       jargon swap trades one word for one word ("uses" for "utilises"). Which way it moves
       depends on the swap — plainer is usually shorter, but an economy pass that deletes
       filler leaves the long words behind and pushes it up. It sits beside mean sentence
       because the two are read together. */
    { key: 'meanWordLength', label: 'mean word (chars)', mean: true },
    { key: 'hedges', label: 'hedges' }
  ];

  /* Mean sentence length is words divided by sentences, so for a draft of one sentence it
     is the word count again — the strip used to print the same number in two columns. The
     column is dropped whenever every draft this strip covers is a single sentence, and
     kept whenever it says something the words column does not. */
  function oneSentenceThroughout(m, prev) {
    var cur = m && typeof m.sentences === 'number' ? m.sentences : null;
    var was = prev && typeof prev.sentences === 'number' ? prev.sentences : null;
    return cur === 1 && (was === null || was === 1);
  }

  /* `applied` is the count applyFindings actually made in this pass — not a property of the
     text, but the one number that says a pass which changed the draft changed it. It is
     left out where there is nothing to report it for, as on draft 0. */
  function metricsStrip(m, prev, aria, applied) {
    var wrap = el('div', 'metrics');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', aria || 'Metrics for this draft');
    if (typeof applied === 'number') {
      var ed = el('span', 'metric');
      ed.appendChild(el('span', 'metric-name', 'edits applied '));
      ed.appendChild(el('span', 'metric-val', count(applied)));
      wrap.appendChild(ed);
    }
    var drop = oneSentenceThroughout(m, prev);
    for (var i = 0; i < METRIC_ROWS.length; i++) {
      var row = METRIC_ROWS[i];
      if (row.key === 'meanSentenceLength' && drop) continue;
      var cur = m && typeof m[row.key] === 'number' ? m[row.key] : 0;
      /* The delta is the difference between the two numbers this row prints, not between
         the two it was handed. The strip used to round each value for display and round
         their raw difference separately, which is how
         metricsStrip({…meanWordLength: 4.96}, {…meanWordLength: 5.04}) printed
         "mean word (chars) 5.0 → 5.0 (−0.1)": both values show as 5.0 and 0.08 shows as
         0.1. Both formats round at one decimal, so snapping there first and subtracting
         after leaves the row agreeing with itself. The integer columns are unmoved: their
         values are whole, and snapping a whole number returns it. */
      var shown = snap1(cur);
      var was = (prev && typeof prev[row.key] === 'number') ? snap1(prev[row.key]) : null;
      var fmt = row.mean ? num1 : num;
      var item = el('span', 'metric');
      item.appendChild(el('span', 'metric-name', row.label + ' '));
      if (was !== null && was !== shown) {
        item.appendChild(el('span', 'metric-val', fmt(was) + ' → ' + fmt(cur)));
        item.appendChild(document.createTextNode(' '));
        item.appendChild(el('span', 'metric-delta', '(' + signed(shown - was, fmt) + ')'));
      } else {
        item.appendChild(el('span', 'metric-val', fmt(cur)));
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
     content, and the gap that keeps them off the previous word is padding and margin,
     so neither adds a character to the text.

     The marker hangs off .d-head, which carries the run's own first word. The head is an
     atomic inline, so no line can break between the marker and that word and the marker
     is never left alone against the right margin, reading as the em dash this markup
     exists to avoid. The split is inside the op's own element — the same characters, in
     the same order, in the same op — so nothing moves between ops and the reconstruction
     is unchanged. */
  function appendMarkedRun(node, text) {
    var n = text.length, i = 0, j, k;
    while (i < n && /\s/.test(text.charAt(i))) i++;
    if (i >= n) {
      /* Nothing but whitespace: there is no word for the marker to hold on to, and a
         struck or underlined space is all this run would draw. */
      if (n) node.appendChild(document.createTextNode(text));
      node.appendChild(el('span', 'd-head', ''));
      return;
    }
    j = i;
    while (j < n && !/\s/.test(text.charAt(j))) j++;
    k = n;
    while (k > j && /\s/.test(text.charAt(k - 1))) k--;
    /* The run's own outer whitespace stays in the run, in its own text node, and carries
       no line: a struck space hanging at a right margin is another dash the reader has to
       read past, and it is where the line may break so the whole marked run moves down. */
    if (i > 0) node.appendChild(document.createTextNode(text.slice(0, i)));
    node.appendChild(el('span', 'd-head', text.slice(i, j)));
    if (k > j) node.appendChild(el('span', 'd-tail', text.slice(j, k)));
    if (k < n) node.appendChild(document.createTextNode(text.slice(k)));
  }

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
        appendMarkedRun(s, t);
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
      !pairLongerThan(before, after, DIFF_CHAR_LIMIT);

    var body = el('div');
    var controls = el('div', 'diff-controls');
    /* One toggle between the word diff and the clean text. Its name does not move and
       aria-pressed carries the state: pressed means the clean text is the thing on screen,
       unpressed means the diff is. A name that flips with the state while aria-pressed
       flips too says two contradictory things at once — "Show clean text" pressed, with
       the diff showing — so the name stays put and the state is the part that moves.
       The pressed state is drawn as well as exposed; see the stylesheet. */
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
        toggle.setAttribute('aria-pressed', mode === 'clean' ? 'true' : 'false');
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
      applied === 1 ? 'One finding was applied to make this draft.'
        : count(applied) + ' findings were applied to make this draft.'));
    p.appendChild(metricsStrip(mAfter, mBefore, null, applied));
    addTranscript(p);
  }

  /* The two kinds of finding applyFindings never touches are a pointer (no replacement at
     all) and, in live mode, a quote the page could not place in this draft. Everything
     else is applicable: the loop will rewrite it. */
  function isApplicable(f) {
    return !!f && f.replacement !== null && f.replacement !== undefined && f.located !== false;
  }

  /* Which findings in one panel open on their own. The rule: the first applicable finding
     of a rule opens, every later finding of that same rule renders closed. A panel then
     carries one worked example per kind of complaint and one row per repeat — six FILLER
     PHRASE findings used to open six boxes, each with its own quote, why-line and arrow.
     Pointers and unplaced quotes never open (isApplicable). The cap governs the set that
     would open, so more than FINDINGS_OPEN_CAP distinct applicable rules opens none of
     them. Expand all still reaches every finding in the list.
     The key is the name the row prints — `ruleName || rule`, the same expression
     renderFinding puts in .rule-name — because "one worked example per rule" is a claim
     about what the reader sees. Offline the two are one-to-one over all twelve rules, so
     either would do; live mode stamps rule: 'live' on every finding and carries the
     model's own name in ruleName, so keying on `rule` collapsed a whole panel onto one
     key and opened exactly one box however many distinct complaints came back.
     Returns one flag per finding, in order. */
  function openFlags(findings, cap) {
    var flags = [], seen = {}, distinct = 0, i, k;
    for (i = 0; i < findings.length; i++) {
      if (!isApplicable(findings[i])) { flags.push(false); continue; }
      /* The prefix keeps a rule named __proto__, constructor or hasOwnProperty out of
         Object.prototype, where every one of them reads back truthy on an empty object. */
      k = 'rule:' + String(findings[i].ruleName || findings[i].rule || '');
      if (seen[k]) { flags.push(false); continue; }
      seen[k] = true;
      distinct++;
      flags.push(true);
    }
    if (distinct > cap) for (i = 0; i < flags.length; i++) flags[i] = false;
    return flags;
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
    /* A pointer says so in the summary row, in two words, once. It used to say it in a
       sentence in the body — six of them in the first pass of the Bloated corporate
       sample, which is most of why that panel stood four times the height of the draft it
       sits above. The pass summary still states the count in prose, once per panel. */
    if (f.replacement === null || f.replacement === undefined) {
      s.appendChild(el('span', 'finding-tag', 'pointer only'));
    }
    var shownQuote = shortenQuoteForDisplay(quoteText, QUOTE_DISPLAY_CHARS);
    s.appendChild(el('span', 'quote', shownQuote.text));
    /* The cap says so in the same shape as the draft and listing caps. It sits under the
       quote, inside the summary, so it is read as being about that quote and nothing else.
       Closed, a finding is one row and every quote in it is clipped to the row's width by
       the stylesheet whatever its length, so the note shows with the open finding. */
    if (shownQuote.truncated) {
      s.appendChild(el('span', 'truncated-note quote-note',
        'Showing the first ' + count(shownQuote.shown) + ' of ' + count(shownQuote.total) +
        ' characters of this quoted span. The exported transcript carries the whole span.'));
    }
    d.appendChild(s);

    var body = el('div', 'finding-body');
    body.appendChild(el('p', 'why', String(f.why == null ? '' : f.why)));

    /* A pointer carries no replacement line: the tag in the summary row is the whole of
       it. A quote the page could not place still carries one, because which way it failed
       is not something a tag says. */
    if (f.replacement !== null && f.replacement !== undefined) {
      var repl = el('p', 'repl');
      if (f.located === false) {
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
    }
    d.appendChild(body);
    return d;
  }

  /* One button per critique panel, opening or closing every finding in it. It is a real
     button, so it is in the tab order and answers Enter and Space, and its aria-expanded
     says which way it will go — recomputed whenever any finding in the list is opened or
     closed by hand, so the label and the state never lie about the list. The toggle event
     does not bubble, so the listener runs in the capture phase. */
  function expandAllControl(list) {
    var row = el('div', 'findings-controls');
    var btn = el('button', 'btn btn-quiet expand-all');
    btn.type = 'button';
    btn.setAttribute('aria-controls', list.id);

    function items() { return list.querySelectorAll('details.finding'); }
    function allOpen() {
      var d = items(), i;
      if (!d.length) return false;
      for (i = 0; i < d.length; i++) if (!d[i].open) return false;
      return true;
    }
    function sync() {
      var open = allOpen();
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? 'Collapse all' : 'Expand all';
    }
    btn.addEventListener('click', function () {
      var want = !allOpen();
      var d = items(), i;
      for (i = 0; i < d.length; i++) d[i].open = want;
      sync();
    });
    list.addEventListener('toggle', sync, true);
    sync();
    row.appendChild(btn);
    return row;
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
    list.id = 'findings-' + index;
    var shown = Math.min(findings.length, FINDINGS_RENDER_CAP);
    /* openFlags decides what opens, over the findings this panel renders — which is the
       set the flag governs. */
    var flags = openFlags(findings.slice(0, shown), FINDINGS_OPEN_CAP);
    for (var i = 0; i < shown; i++) {
      var li = el('li');
      li.appendChild(renderFinding(findings[i], flags[i]));
      list.appendChild(li);
    }
    p.appendChild(expandAllControl(list));
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
    var head = (total === 1 ? 'One finding' : count(total) + ' findings') +
      (chunks > 1 ? ' across ' + count(chunks) + ' chunks' : '');
    if (applied === total) {
      return head + (total === 1 ? ', applied to the next draft.'
        : ', all applied to the next draft.');
    }
    var body = head + ', ' +
      (applied === 0 ? 'none applied to the next draft. '
        : (applied === 1 ? 'one applied to the next draft. '
          : count(applied) + ' applied to the next draft. '));
    if (findings.length === total) {
      var pointers = 0, unplaced = 0, i;
      for (i = 0; i < findings.length; i++) {
        var f = findings[i] || {};
        if (f.replacement === null || f.replacement === undefined) pointers++;
        else if (f.located === false) unplaced++;
      }
      if (pointers) body += (pointers === 1 ? 'One is a pointer'
        : count(pointers) + ' are pointers') + ', which the loop never applies. ';
      if (unplaced) body += (unplaced === 1 ? 'One quote could not be placed in this draft. '
        : count(unplaced) + ' quotes could not be placed in this draft. ');
      return body.replace(/\s+$/, '');
    }
    return body + (total - applied === 1 ? 'The other one was' : 'The other ' + count(total - applied) + ' were') +
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
    p.appendChild(el('p', 'panel-blurb', verdictNote(record)));
    draftBody(p, record.finalText);

    var mFinal = record.metrics0;
    var appliedAll = appliedTotal(record);
    for (var i = 0; i < record.passes.length; i++) {
      if (record.passes[i].metricsAfter) mFinal = record.passes[i].metricsAfter;
    }
    p.appendChild(el('p', 'metrics-head', 'Draft 0 → final draft'));
    p.appendChild(metricsStrip(mFinal, record.metrics0, 'Draft 0 to final draft', appliedAll));

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
    out.push('Metrics: ' + metricLine(t.metrics0, null));
    out.push('');
    /* Each pass's strip on screen is metricsStrip(after, before): the line for that draft is
       given the same before, so the two drop the mean-sentence column together. */
    var prevM = t.metrics0;
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
        out.push('Metrics: ' + metricLine(p.metricsAfter, prevM));
        out.push('');
      }
      if (p.metricsAfter) prevM = p.metricsAfter;
    }
    out.push('## Result');
    out.push('');
    out.push(verdictLine(t));
    out.push('');
    out.push(mdFence(t.finalText));
    /* The footer is one row covering both drafts, like the final strip: each half is given
       the other, so the pair decides the mean-sentence column once and the halves match. */
    var mFin = finalMetrics(t);
    out.push('Metrics, draft 0 → final: ' + metricLine(t.metrics0, mFin) + ' → ' + metricLine(mFin, t.metrics0));
    out.push('');
    out.push('No API key is included in this file.');
    return out.join('\n');
  }

  function finalMetrics(t) {
    var m = t.metrics0;
    for (var i = 0; i < t.passes.length; i++) if (t.passes[i].metricsAfter) m = t.passes[i].metricsAfter;
    return m;
  }

  /* The exported line is the on-screen strip written out in prose, so it prints the same
     columns under the same rules or the file and the page disagree about the same run. Both
     means keep their decimal (num1): mean word is where a clarity pass shows up when the
     word count does not move, and leaving it out made the Almost clean export read
     identically before and after a pass the same file records as "Applied: 3 of 3". Mean
     sentence is dropped exactly where the strip drops it — oneSentenceThroughout, against
     the same prev the strip was given — because for a one-sentence draft it is the word
     count again, in a second column.

     It walks METRIC_ROWS, which is the list the strip walks, rather than a second copy of
     the column names kept beside it. The copy had already drifted: day 047 put the units
     on the strip's two mean columns to close a defect where nothing said what the column
     measured, and the export went on writing "mean sentence 15.0, mean word 4.4" — the
     ambiguity closed on screen and left in the artifact that outlives the page. Adding a
     column, renaming one or changing what it prints now reaches both renderings or
     neither.

     Fields are separated by the page's own separator, " · " — the one that already
     divides "Pass 2 · Draft 2" and "default · rules in this page · no network". They were
     separated by ", " until 303bc2d taught num() to group thousands, after which one comma
     did two jobs in the same line: "words 7,400, sentences 1,000, mean sentence (words)
     7.4" leaves a reader to work out which commas end a field. The middle dot is not a
     character any value on this line contains, and it survives Markdown untouched. */
  function metricLine(m, prev) {
    if (!m) return 'n/a';
    var drop = oneSentenceThroughout(m, prev), parts = [], i, row, cur;
    for (i = 0; i < METRIC_ROWS.length; i++) {
      row = METRIC_ROWS[i];
      if (row.key === 'meanSentenceLength' && drop) continue;
      cur = (typeof m[row.key] === 'number') ? m[row.key] : 0;
      parts.push(row.label + ' ' + (row.mean ? num1 : num)(cur));
    }
    return parts.join(METRIC_SEP);
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

  /* Both halves of an error reply go through one cap and one note. api.anthropic.com
     answers a 401, a 429 or a 500 with JSON carrying an error.message, so that is the
     path a real key hits; a body this page cannot read as JSON is shown as it came back.
     Capping only the second left a 606-character message printing in full, which was the
     one uncapped string the page had left. The note is the shape the draft, listing and
     quote caps already use. */
  var API_ERROR_CHARS = 300;

  /* Both numbers in the note are counted the way a reader counts them: in code points, not
     in the UTF-16 units a JavaScript string is stored as. An error body of one letter and
     200 emoji is 401 units and 201 characters on screen, so the old count said "the first
     300 of 401 characters" about a string a reader counts 201 of — and the cut at unit 300
     landed inside a surrogate pair, ending the line on half an emoji. Splitting on code
     points fixes both: the string is cut between characters, and the two numbers are the
     ones on the page. The collapse of runs of whitespace comes first, so a body that is
     mostly newlines is not clipped to a column of blanks — it is also what makes the note's
     count match the single-spaced text beside it. */
  function clipApiError(text) {
    var body = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    var chars = codePoints(body);
    if (chars.length <= API_ERROR_CHARS) return { msg: body, note: '' };
    return {
      msg: chars.slice(0, API_ERROR_CHARS).join(''),
      note: ' Showing the first ' + count(API_ERROR_CHARS) + ' of ' + count(chars.length) +
        ' characters of the error body.'
    };
  }

  /* api.anthropic.com answers with { error: { message: "…" } }. A body that is JSON but
     carries no string there — a missing message, a message that is an object — is no more
     readable than a body that is not JSON at all, so it takes the same path the raw body
     takes rather than being stringified into "[object Object]". */
  function apiErrorMessage(raw, status) {
    var msg = '';
    try {
      var v = JSON.parse(raw);
      if (v && v.error && typeof v.error.message === 'string') msg = v.error.message;
      else if (v && typeof v.message === 'string') msg = v.message;
    } catch (e) { /* not JSON */ }
    var clipped = clipApiError(msg || raw);
    return 'HTTP ' + status + ' — ' + (clipped.msg || 'no message in the reply') + clipped.note;
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
     sentence end where there is one and at whitespace otherwise, never mid-token. Every
     chunk is critiqued with opts.before — the text that actually precedes it, the last
     BEFORE_CHARS characters of the draft up to the cut — so the engine decides for itself
     whether offset 0 begins a sentence. It usually does, because the cuts are made at
     sentence ends: the boolean this replaced asserted the opposite and deleted capitals
     that belonged there, which is why a chunked draft could read "ecosystem. the
     implementation" where the unchunked engine reads "ecosystem. The implementation".
     Metrics are never chunked: metrics() is O(n) and runs on the whole draft. Nothing is
     dropped, but a finding never spans a chunk boundary. */

  var BEFORE_CHARS = 40;   /* how much of the preceding text each chunk is critiqued with */

  function precedingText(text, start) {
    if (!(start > 0)) return '';
    return text.slice(Math.max(0, start - BEFORE_CHARS), start);
  }

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function isSpaceAt(text, i) {
    var c = text.charAt(i);
    return c !== '' && /\s/.test(c);
  }

  /* A chunk never ends on an article. repairArticles (critic.js) re-picks a/an from the
     word that follows the span it rewrites, and it can only see one chunk at a time: with
     "… a | basically excellent result …" astride the cut, the hedge rule deletes
     "basically" in the second chunk while the "a" sits at the end of the first, out of
     reach, and the chunked draft reads "a excellent result" where the whole-text draft
     reads "an excellent result". So the article travels into the chunk that holds its
     head. */
  var ARTICLE_AT_CUT_RE = /^an?$/i;

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
        /* The cut is chosen above; this only ever moves it back, one word, to the first
           character of a trailing article. Never to or before i — that would be an empty
           chunk and a loop that does not advance — and never on the last chunk, which has
           nothing after it to strand. One word is all English needs: the guard wins on a
           text that is nothing but articles, and that chunk still ends on one. */
        if (end < n) {
          var we = end, ws;
          while (we > i && isSpaceAt(text, we - 1)) we--;
          ws = we;
          while (ws > i && !isSpaceAt(text, ws - 1)) ws--;
          if (ws > i && ARTICLE_AT_CUT_RE.test(text.slice(ws, we))) end = ws;
        }
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

  /* Chunking must not change what a pass reports. Nearly every rule fires once per
     occurrence, so its findings are already per-draft: three chunks holding two jargon
     words each report six, exactly as the whole draft does, and deduping them would
     lose four real complaints. The counting rules are the exception — they fire at most
     once per word per critique however often the word comes back (critic.js: "a counting
     rule fires once per chunk when a long draft is critiqued in pieces"), so chunking
     multiplies them by the number of chunks the word appears in. Those, and only those,
     are deduped by (rule, quote) — the identity the engine guarantees — first occurrence
     kept. Applicable findings are never deduped: two identical fixable spans are two
     real edits. */
  var COUNTING_RULES = (function () {
    var m = Object.create(null);
    m.repetition = true;   /* "Repeated word" — one finding per word, whatever the count */
    return m;
  })();

  function countingKey(f) {
    if (!f || (f.replacement !== null && f.replacement !== undefined)) return null;  /* pointer-only */
    if (!COUNTING_RULES[String(f.rule)]) return null;
    return String(f.rule) + '\u0000' + String(f.quote == null ? '' : f.quote);
  }

  /* One chunked offline critique: findings for the whole text, applied chunk by chunk. */
  function chunkedPass(text, lensId, alive) {
    var chunks = splitChunks(text, CHUNK_TARGET);
    var kept = [], total = 0, applied = 0, parts = [];
    var seen = Object.create(null);
    var i = 0, last = now();

    function slice() {
      while (i < chunks.length) {
        if (!alive()) return Promise.resolve(null);
        var ch = chunks[i++];
        var res = CL.critique(ch.text, lensId, { before: precedingText(text, ch.start) });
        var fs = res.findings || [];
        var ap = CL.applyFindings(ch.text, fs);
        parts.push(ap.text);
        applied += ap.applied;
        for (var k = 0; k < fs.length; k++) {
          var key = countingKey(fs[k]);
          if (key !== null) {
            if (seen[key]) continue;
            seen[key] = true;
          }
          total++;
          if (kept.length < FINDINGS_KEEP_CAP) kept.push(shiftFinding(fs[k], ch.start));
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

  /* The drivers the page steps itself ask the engine exactly the questions steps() asks,
     with the same function and the same arguments: CriticLoop.tailClean() is the only
     convergence test on every offline path, and the three flags it produces are worded by
     CriticLoop.verdict() and nothing else.

     Live mode is the one case tailClean cannot answer, because the lenses are the model's
     and the page cannot run the ones that have not run without calling the API again. It
     reads what the model actually returned instead — a reply that parsed and held no
     findings — so it can say the draft came out clean at the cap, and it never claims an
     early stop it did not make. */
  function pagePasses(text, opts) {
    var L = lenses();
    var passes = [];
    var current = text;
    var mCurrent = null;
    var i = 0;
    var live = !!opts.live;
    var converged = false, cappedClean = false, stopped = false;

    function result() {
      return {
        done: true,
        value: {
          converged: converged, cappedClean: cappedClean,
          finalText: current, passCount: passes.length
        }
      };
    }

    return {
      next: function () {
        if (stopped || i >= MAX_PASSES || i >= L.length) return Promise.resolve(result());
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

          /* An unparseable reply is not a pass that found nothing. */
          var foundNothing = (pass.unparsed === undefined && pass.total === 0);
          var atCap = (i >= MAX_PASSES || i >= L.length);
          if (foundNothing && !live) {
            converged = CL.tailClean(current, i, { through: MAX_PASSES }).clean;
            if (converged && !atCap) stopped = true;
          }
          if (atCap || stopped) {
            /* The cap is spent: whether anything is left is a question about the final
               draft, so it is asked of the final draft and of every lens. */
            cappedClean = atCap && (live ? foundNothing : CL.tailClean(current, 0).clean);
          }
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
    /* The strip carrying Stop and Skip exists only while there is a run to stop. */
    els.runbar.hidden = !busy;
    els.stop.disabled = !busy;
    /* Read-only, not disabled: the text stays readable, selectable and copyable, but it
       cannot drift away from the draft 0 the transcript below was built from. */
    els.input.readOnly = busy;
    els.input.classList.toggle('is-locked', busy);
    els.skip.hidden = reduceMotion;  /* nothing to skip when motion is already off */
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
    if (!engineOk) return;

    /* Validate before anything is cleared: a blank box must not destroy a finished run. */
    var raw = els.input.value;
    if (isBlankInput(raw)) {
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

    var chunked = !live && longerThan(raw, CHUNK_THRESHOLD);
    var record = {
      engineLabel: live ? 'live (' + model + ')' : 'offline rule-based critic',
      draft0: raw, metrics0: null, passes: [], converged: false, cappedClean: false, finalText: raw,
      chunks: 1
    };

    var driver;
    if (live) {
      driver = pagePasses(raw, {
        live: true,
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
    } else {
      driver = enginePasses(raw);
    }

    var chain = yieldToPaint().then(function () {
      if (!alive()) return;
      record.metrics0 = CL.metrics(raw);
      renderDraft0(raw, record.metrics0);
      if (chunked) {
        var n = splitChunks(raw, CHUNK_TARGET).length;
        record.chunks = n;
        renderNote('This text is ' + count(codePointCount(raw)) + ' characters, so each pass critiques it in ' +
          count(n) + ' chunks of about ' + count(CHUNK_TARGET) + ' characters, cut at a sentence ' +
          'end where there is one and at whitespace otherwise, never mid-word. Each chunk is ' +
          'critiqued with the text that comes before it, so a sentence that starts a chunk is ' +
          'still read as the start of a sentence. ' +
          'The page hands control back to the browser between chunks, so it stays usable. Metrics are ' +
          'measured on the whole draft, not summed over chunks. The rules that count how often a ' +
          'word comes back report it once per draft, not once per chunk, so a chunked draft counts ' +
          'them exactly as an unchunked one does. No text is dropped, but a finding never spans a ' +
          'chunk boundary.');
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
        record.cappedClean = !!result.cappedClean;
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

  /* The page decisions tests.html asserts, reached rather than copied: a copy of a function
     in a test only ever proves the copy. The suite runs on file:// and cannot fetch a
     sibling, so this object is how it gets at them. It is the whole of what this file
     exposes, nothing on the page reads it, and the page behaves the same with it as
     without. */
  window.CriticLoopPage = {
    splitChunks: splitChunks,
    openFlags: openFlags,
    isApplicable: isApplicable,
    renderFinding: renderFinding,
    expandAllControl: expandAllControl,
    metricsStrip: metricsStrip,
    metricLine: metricLine,
    shortenForDisplay: shortenForDisplay,
    shortenQuoteForDisplay: shortenQuoteForDisplay,
    counterLabel: counterLabel,
    codePointCount: codePointCount,
    longerThan: longerThan,
    pairLongerThan: pairLongerThan,
    isBlankInput: isBlankInput,
    appliedTotal: appliedTotal,
    verdictLine: verdictLine,
    apiErrorMessage: apiErrorMessage,
    METRIC_ROWS: METRIC_ROWS,
    METRIC_SEP: METRIC_SEP,
    FINDINGS_OPEN_CAP: FINDINGS_OPEN_CAP,
    API_ERROR_CHARS: API_ERROR_CHARS,
    DRAFT_DISPLAY_CHARS: DRAFT_DISPLAY_CHARS,
    QUOTE_DISPLAY_CHARS: QUOTE_DISPLAY_CHARS,
    CHUNK_THRESHOLD: CHUNK_THRESHOLD,
    DIFF_CHAR_LIMIT: DIFF_CHAR_LIMIT
  };

  /* ---------- wiring ----------
     Everything below binds to index.html's elements. The suite loads this file with no
     page around it, for the export above, so the wiring stands down when the page is not
     there. index.html always has these, so nothing that ships takes this branch. */
  if (!els.input || !els.run) return;

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
  els.runbar.hidden = true;
  els.skip.hidden = reduceMotion;
})();
