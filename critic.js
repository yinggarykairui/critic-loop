/* critic.js — the offline critic engine for critic-loop.
 *
 * Pure logic. No DOM, no network, no timers, no Math.random, no Date, no
 * locale-sensitive comparison: the same input must produce byte-identical
 * output on every call, in every browser. tests.html drives this file directly.
 *
 * Shape: three lenses, each a list of rules. A rule scans text and returns
 * findings that quote an exact span and (usually) carry a replacement for it.
 * A rule that cannot rewrite the span safely points at it instead
 * (replacement === null) rather than guessing; pointers never rewrite anything.
 * critique(text, lens, {before}) merges a lens's rules into one sorted
 * list, non-overlapping among the findings that carry a replacement — pointers
 * are exempt and all survive. A finding may carry display:{quote, replacement}
 * when its mechanical span had to widen past the human-meaningful one.
 * applyFindings() rewrites the text right-to-left so offsets stay valid;
 * steps() is the loop as a generator, and run() drains it. The loop stops early
 * only when the text is clean under every lens it has not yet run.
 *
 * Exports exactly one global: window.CriticLoop.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ hard limits */

  // diffWords builds a full LCS table: O(n*m) cells. At 2500 tokens a side the
  // Uint32Array is ~25 MB and the fill is already tens of ms; beyond that it
  // would stall the page, so the diff degrades to one del + one ins pair
  // ("replaced wholesale") instead of getting slower without bound.
  var MAX_DIFF_TOKENS = 2500;

  // Longest dictionary phrase in words ("it is important to note that" = 6).
  // Bounds the phrase scan at O(6n) rather than O(n * dictionary).
  var MAX_PHRASE_WORDS = 6;

  // No dictionary key is longer than this. Lets the scan skip hashing a
  // pathological token (a 40 kB "word") against every map.
  var MAX_DICT_WORD = 48;

  // Two dictionary words separated by more than this many characters are not a
  // phrase; the cap keeps the gap check from slicing a huge run of whitespace.
  var MAX_PHRASE_GAP = 200;

  /* --------------------------------------------------------------- scanning */

  var WS_RE = /\s/;
  function isSpace(ch) { return ch !== '' && WS_RE.test(ch); }
  function toText(v) { return (v === null || v === undefined) ? '' : String(v); }

  // A word char is a letter, digit or combining mark. Combining marks are in so
  // that decomposed text (e + U+0301) stays one token and no offset ever lands
  // inside a grapheme. Zero-width and bidi controls are category Cf, so they sit
  // outside tokens and act as separators — harmless, since every offset comes
  // from a real match index rather than from counting.
  // Linear by construction: the word class and the connector class ['’-]
  // are disjoint, so there is exactly one way to parse any input and nothing to
  // backtrack over.
  var WORD_RE = /[\p{L}\p{N}\p{M}]+(?:['\u2019\-][\p{L}\p{N}\p{M}]+)*/gu;
  var NONSPACE_RE = /\S+/gu;
  var HAS_ALNUM_RE = /[\p{L}\p{N}]/u;
  var GAP_RE = /^[\s\u200b-\u200f\u202a-\u202e\u2060\ufeff]*$/;

  var TERMINATORS = '.!?\u2026';
  var CLOSING = '.!?;:,)]}\u2026';

  function tokenize(text) {
    var out = [], m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      out.push({ s: m.index, e: m.index + m[0].length, w: m[0], lw: m[0].toLowerCase() });
      if (WORD_RE.lastIndex === m.index) WORD_RE.lastIndex++; // defensive: never spin
    }
    return out;
  }

  function isGapBlank(text, a, b) {
    if (b <= a) return true;
    if (b - a > MAX_PHRASE_GAP) return false;
    return GAP_RE.test(text.slice(a, b));
  }

  // Sentence boundary = a run of . ! ? … followed by whitespace or end of text.
  // "e.g." therefore does not split, which is the common case worth getting
  // right; an abbreviation at the end of a clause still splits, and that is
  // accepted noise rather than a parser.
  function splitSentences(text) {
    var res = [], n = text.length, start = 0, i, j, k;
    for (i = 0; i < n; i++) {
      if (TERMINATORS.indexOf(text.charAt(i)) < 0) continue;
      j = i;
      while (j < n && TERMINATORS.indexOf(text.charAt(j)) >= 0) j++;
      if (j < n && !isSpace(text.charAt(j))) { i = j - 1; continue; }
      pushSentence(res, text, start, j);
      k = j;
      while (k < n && isSpace(text.charAt(k))) k++;
      start = k;
      i = k - 1;
    }
    if (start < n) pushSentence(res, text, start, n);
    return res;
  }

  function pushSentence(res, text, a, b) {
    while (a < b && isSpace(text.charAt(a))) a++;
    while (b > a && isSpace(text.charAt(b - 1))) b--;
    if (b <= a) return;
    res.push({ start: a, end: b, text: text.slice(a, b) });
  }

  // Attaches each sentence its slice of the token array. One merge pass, O(n).
  function sentencesWithTokens(text, tokens) {
    var sents = splitSentences(text), ti = 0, i;
    for (i = 0; i < sents.length; i++) {
      while (ti < tokens.length && tokens[ti].s < sents[i].start) ti++;
      var from = ti;
      while (ti < tokens.length && tokens[ti].e <= sents[i].end) ti++;
      sents[i].from = from;
      sents[i].to = ti; // exclusive
      sents[i].words = ti - from;
    }
    return sents;
  }

  // Bracket and quote pairs, opener i matching closer i.
  var PAIR_OPEN  = '([{"\'\u201c\u2018';
  var PAIR_CLOSE = ')]}"\'\u201d\u2019';

  // Whether offset 0 of a fragment opens a sentence is not a property of the
  // fragment: it is a property of what came before it. A chunk cut out of a
  // longer draft is usually cut *at* a sentence end, so its first word is a
  // sentence start and must keep its capital; a chunk cut mid-sentence must not
  // gain one. opts.before carries the text that precedes the fragment (the tail
  // of the previous chunk is enough) and answers the question directly: no text
  // before it at all, or text that ends with a terminator — closing quotes and
  // brackets ride along — means offset 0 opens a sentence.
  function headStartsSentence(before) {
    var b = String(before == null ? '' : before);
    var k = b.length;
    while (k > 0 && isSpace(b.charAt(k - 1))) k--;
    while (k > 0 && PAIR_CLOSE.indexOf(b.charAt(k - 1)) >= 0) k--;
    if (k === 0) return true;              // nothing before it: this is the text start
    return TERMINATORS.indexOf(b.charAt(k - 1)) >= 0;
  }

  // headStarts is headStartsSentence(opts.before), computed once per critique.
  function startsSentence(text, i, headStarts) {
    var k = i;
    while (k > 0 && isSpace(text.charAt(k - 1))) k--;
    if (k === 0) return headStarts !== false;
    return TERMINATORS.indexOf(text.charAt(k - 1)) >= 0;
  }

  var QUOTE_OPEN = '"\'\u201c\u2018';
  var QUOTE_CLOSE = '"\'\u201d\u2019';

  // True when the span is the entire content of a bracket or quote pair.
  // Cutting it would leave "It is () fine." or 'He said "" and moved on.'
  function enclosedAlone(text, a, b) {
    if (a <= 0 || b >= text.length) return false;
    var i = PAIR_OPEN.indexOf(text.charAt(a - 1));
    if (i < 0) return false;
    return text.charAt(b) === PAIR_CLOSE.charAt(i);
  }

  // True when the span sits immediately inside quotes: quoted material is being
  // mentioned, not used, so swapping the word inside changes what was said.
  function quotedAlone(text, a, b) {
    if (a <= 0 || b >= text.length) return false;
    return QUOTE_OPEN.indexOf(text.charAt(a - 1)) >= 0 &&
           QUOTE_CLOSE.indexOf(text.charAt(b)) >= 0;
  }

  function isCapitalised(w) {
    var c = w.charAt(0);
    return c !== '' && c !== c.toLowerCase() && c === c.toUpperCase();
  }

  /* ------------------------------------------------------------- edit shape */

  // (rule, quote) is a finding's identity, and it is stable: rule is a fixed
  // string per rule, and quote is the exact text the rule read, so two runs over
  // the same words produce the same pair. A caller that critiques a long draft
  // in chunks can therefore dedupe the counting rules — repetition fires once
  // per chunk, at most once per word per critique — by that pair alone, and two
  // findings with the same pair really are the same complaint about the same
  // word. start/end are not part of the identity: they are offsets into
  // whichever chunk produced the finding.

  // display.quote is what a human is shown, so it never carries the whitespace
  // the mechanical span had to swallow: the panel renders it inside quotation
  // marks, and “Perhaps ” reads as a typo.
  var TRIM_ENDS_RE = /^\s+|\s+$/g;

  // display is optional: when the mechanical span had to swallow a neighbouring
  // space or letter, display carries the span a human would recognise. It is
  // never applied — applyFindings only ever uses quote/start/end/replacement.
  function finding(text, rule, ruleName, start, end, why, replacement, display) {
    var f = {
      rule: rule,
      ruleName: ruleName,
      start: start,
      end: end,
      quote: text.slice(start, end),
      why: why,
      replacement: replacement === undefined ? null : replacement
    };
    if (display) f.display = display;
    return f;
  }

  // Carries the capitalisation of the quote onto its replacement, so
  // "Leverage the cache" becomes "Use the cache" and not "use the cache".
  var TWO_LETTERS_RE = /\p{L}[^\p{L}]*\p{L}/u;
  function matchCapital(quote, repl) {
    if (!repl) return repl;
    // Shouting in, shouting out: "IN ORDER TO LEVERAGE IT" must not come back
    // as "To LEVERAGE IT". Needs two letters, so the article "A" is not caught.
    if (quote === quote.toUpperCase() && quote !== quote.toLowerCase() &&
        TWO_LETTERS_RE.test(quote)) {
      return repl.toUpperCase();
    }
    var c = quote.charAt(0);
    if (c && c !== c.toLowerCase() && c === c.toUpperCase()) {
      return repl.charAt(0).toUpperCase() + repl.slice(1);
    }
    return repl;
  }

  // Deleting a span is never just slicing it out: the surrounding spaces and
  // commas have to survive, and a deletion at the head of a sentence has to
  // hand the capital to the next word. Returns the widened span plus the string
  // that replaces it (usually '', sometimes the recapitalised next letter).
  function deletionEdit(text, s, e, headStarts) {
    var n = text.length, start = s, end = e, ls, re, prev, next;

    ls = start; while (ls > 0 && isSpace(text.charAt(ls - 1))) ls--;
    re = end; while (re < n && isSpace(text.charAt(re))) re++;
    prev = ls > 0 ? text.charAt(ls - 1) : '';
    next = re < n ? text.charAt(re) : '';

    if (prev === ',' && next === ',') {
      // "The system, basically, works." — take the phrase and one whole comma.
      start = ls - 1;
      end = re + 1;
    } else if (next === ',') {
      // "Basically, the system works." — the comma goes with the phrase.
      end = re + 1;
    } else if (prev === ',' && (next === '' || CLOSING.indexOf(next) >= 0)) {
      // "It is fast, basically." — the comma would be orphaned.
      start = ls - 1;
    }

    var leftWS = start > 0 && isSpace(text.charAt(start - 1));
    var rightWS = end < n && isSpace(text.charAt(end));
    if (leftWS) {
      while (start > 0 && isSpace(text.charAt(start - 1))) start--;
    } else if (rightWS && start === 0) {
      while (end < n && isSpace(text.charAt(end))) end++;
    }

    var replacement = '', display = null;
    if (startsSentence(text, start, headStarts)) {
      var k = end;
      while (k < n && isSpace(text.charAt(k))) k++;
      if (k < n) {
        var c = text.charAt(k), up = c.toUpperCase();
        if (up !== c) {
          // The span now ends one letter into the next word, which reads as
          // nonsense in a list of edits: show the phrase and the space instead.
          display = { quote: text.slice(s, k).replace(TRIM_ENDS_RE, ''), replacement: '' };
          replacement = text.slice(end, k) + up;
          end = k + 1;
        }
      }
    }
    if (!display && (start !== s || end !== e)) {
      display = { quote: text.slice(s, e), replacement: '' };
    }
    return { start: start, end: end, replacement: replacement, display: display };
  }

  /* --------------------------------------------------------- article repair */

  // Any edit that changes the word after "a"/"an" has to re-pick the article:
  // cutting the intensifier out of "a truly excellent result" leaves
  // "a excellent result", and swapping the jargon in "an actionable list"
  // leaves "an usable list". Orthography is not pronunciation, so the letter
  // rule carries the common words it gets wrong as two lists.
  var TAKES_A = new Set(['use', 'used', 'useful', 'useless', 'user', 'users', 'usable',
    'usage', 'usual', 'unique', 'unified', 'uniform', 'union', 'unit', 'units', 'united',
    'universal', 'universe', 'university', 'utility', 'utilities', 'ubiquitous',
    'one', 'once', 'euro', 'european']);
  var TAKES_AN = new Set(['hour', 'hours', 'hourly', 'honest', 'honestly', 'honour',
    'honours', 'honor', 'honors', 'honourable', 'honorable', 'heir', 'heirs', 'heirloom']);

  // Letters whose *name* opens with a vowel sound, so an initialism read letter
  // by letter takes "an": ay, ee, ef, aitch, eye, el, em, en, oh, ar, es, ex.
  // U ("you"), W ("double-you") and Y ("wye") are not here: "a URL", "a W3C
  // note", "a Y combinator".
  var AN_LETTERS = 'AEFHILMNORSX';

  // How the leading digit group is read decides the article. Everything above
  // 999 is read in thousand-groups, so only the leading group is spoken first:
  // 8000 is "eight thousand" (an), 11,000 "eleven thousand" (an), 1100 "one
  // thousand one hundred" (a). Nothing else opens with a vowel sound: eight,
  // eighty, eight hundred, eleven and eighteen are the whole list.
  function digitsWantAn(digits) {
    while (digits.length > 3) digits = digits.slice(0, ((digits.length - 1) % 3) + 1);
    if (digits.length === 1) return digits === '8';
    if (digits.length === 2) return digits === '11' || digits === '18' || digits.charAt(0) === '8';
    return digits.charAt(0) === '8';   // 800-899 "eight hundred", nothing else
  }

  var LEADING_DIGITS_RE = /^[\p{Nd}]+/u;
  var ALL_CAPS_RE = /^\p{Lu}{2,}$/u;

  // "a" or "an" is decided by sound, not spelling, and the head word arrives in
  // four flavours the letter rule alone gets wrong: initialisms spelled out
  // ("an FAQ", "a URL"), numerals ("an 8-bit palette", "a 1-to-1 mapping"),
  // /ju:/ words ("a unique case") and silent h ("an hourly job"). A hyphenated
  // or apostrophed head is decided by its first part, which is the part spoken
  // first: "8-bit" is read "eight bit".
  function wantsAn(word) {
    var w = String(word), cut = w.search(/[-–—'’]/);
    if (cut > 0) w = w.slice(0, cut);
    var digits = w.match(LEADING_DIGITS_RE);
    if (digits) return digitsWantAn(digits[0]);
    if (ALL_CAPS_RE.test(w)) return AN_LETTERS.indexOf(w.charAt(0)) >= 0;
    var lw = w.toLowerCase();
    if (TAKES_AN.has(lw)) return true;
    if (TAKES_A.has(lw)) return false;
    if (lw.slice(0, 2) === 'eu') return false;   // euphoric, European: /juː/
    return 'aeiou'.indexOf(lw.charAt(0)) >= 0;
  }

  // The article immediately before offset i, or null.
  function articleBefore(text, i) {
    var e = i;
    while (e > 0 && isSpace(text.charAt(e - 1))) e--;
    // Either whitespace sits between the article and the span, or the span
    // itself opens with the whitespace (a deletion swallows the space to its
    // left). Anything else means the span is glued to the word before it.
    if (e === i && !(i < text.length && isSpace(text.charAt(i)))) return null;
    var a = e;
    while (a > 0 && HAS_ALNUM_RE.test(text.charAt(a - 1))) a--;
    if (a === e) return null;
    var w = text.slice(a, e).toLowerCase();
    if (w !== 'a' && w !== 'an') return null;
    return { s: a, e: e };
  }

  function firstWordOf(str) {
    var m = str.match(/[\p{L}\p{N}]+/u);
    return m ? m[0] : null;
  }

  // Returns { w, e }: the first word after offset i and where it ends, so the
  // repair can widen the *displayed* span over that word too.
  function firstWordAfter(text, i) {
    var n = text.length, k = i;
    while (k < n && isSpace(text.charAt(k))) k++;
    var a = k;
    while (k < n && HAS_ALNUM_RE.test(text.charAt(k))) k++;
    return k > a ? { w: text.slice(a, k), e: k } : null;
  }

  // Runs over the findings that will actually be applied, in order, after the
  // overlap sweep. Widening a span leftwards over the article can never collide
  // with the finding before it: the repair is skipped when it would.
  function repairArticles(text, findings) {
    var prevEnd = -1, i, f, art, head, tailWord, have, want, fixed;
    for (i = 0; i < findings.length; i++) {
      f = findings[i];
      if (f.replacement === null) continue;
      art = articleBefore(text, f.start);
      if (art && art.s >= prevEnd) {
        head = firstWordOf(f.replacement);
        tailWord = null;
        if (head === null) {
          // A deletion puts no word of its own after the article: the head is
          // the word already standing behind the span.
          tailWord = firstWordAfter(text, f.end);
          head = tailWord === null ? null : tailWord.w;
        }
        if (head !== null) {
          have = text.slice(art.s, art.e).toLowerCase();
          want = wantsAn(head) ? 'an' : 'a';
          if (want !== have) {
            fixed = matchCapital(text.slice(art.s, art.e), want);
            var repl = fixed + text.slice(art.e, f.start) + f.replacement;
            // The mechanical span now opens at the article, so the readable one
            // must open there too. A rewrite of the reader's text that no
            // finding shows is exactly what this page exists not to do, so the
            // display carries the article on both sides, and the head word with
            // it when that word lives in the text rather than in the
            // replacement: "an essentially unique" -> "a unique".
            var dEnd = tailWord ? tailWord.e : f.end;
            var dQuote = text.slice(art.s, dEnd).replace(TRIM_ENDS_RE, '');
            var dRepl = (repl + text.slice(f.end, dEnd)).replace(TRIM_ENDS_RE, '');
            // A swap already shows the article on both sides ("an actionable"
            // -> "a usable"); display exists for the spans a human would not
            // recognise, so it is dropped when it says the same thing twice.
            if (dQuote === text.slice(art.s, f.end) && dRepl === repl) delete f.display;
            else f.display = { quote: dQuote, replacement: dRepl };
            f.why += ' That puts ' + q(head) + ' after the article, so ' +
              q(text.slice(art.s, art.e)) + ' becomes ' + q(fixed) + '.';
            f.replacement = repl;
            f.start = art.s;
            f.quote = text.slice(f.start, f.end);
          }
        }
      }
      prevEnd = f.end;
    }
    return findings;
  }

  /* ------------------------------------------------------------ dictionaries */

  var DELETE = { del: true }; // sentinel: this phrase is cut, not swapped

  function buildDict(pairs) {
    var map = new Map(), heads = new Set(), maxLen = 1, i, key, parts;
    for (i = 0; i < pairs.length; i++) {
      key = pairs[i][0];
      map.set(key, pairs[i][1]);
      parts = key.split(' ');
      heads.add(parts[0]);
      if (parts.length > maxLen) maxLen = parts.length;
    }
    if (maxLen > MAX_PHRASE_WORDS) maxLen = MAX_PHRASE_WORDS;
    return { map: map, heads: heads, maxLen: maxLen };
  }

  // Longest match wins at each starting token. O(maxLen) work per token, and
  // only for tokens that actually begin some dictionary phrase.
  function scanDict(text, tokens, dict, onMatch) {
    var n = tokens.length, i, L, maxL, key, best, prev, cur;
    for (i = 0; i < n; i++) {
      var t = tokens[i];
      if (t.lw.length > MAX_DICT_WORD || !dict.heads.has(t.lw)) continue;
      maxL = Math.min(dict.maxLen, n - i);
      key = t.lw;
      best = null;
      for (L = 1; L <= maxL; L++) {
        if (L > 1) {
          prev = tokens[i + L - 2];
          cur = tokens[i + L - 1];
          if (!isGapBlank(text, prev.e, cur.s)) break;
          key += ' ' + cur.lw;
        }
        if (dict.map.has(key)) best = { len: L, key: key, value: dict.map.get(key) };
      }
      if (best) onMatch(i, i + best.len - 1, best.key, best.value);
    }
  }

  var ARTICLES = new Set(['the', 'a', 'an']);

  // Several plain-English glosses start with an article ("the easy wins"), which
  // doubles up when the jargon they replace already had one: "the low-hanging
  // fruit" must not become "the the easy wins".
  function trimLeadingArticle(text, tokens, i, value) {
    if (!value || typeof value !== 'string') return value;
    var sp = value.indexOf(' ');
    if (sp < 0 || !ARTICLES.has(value.slice(0, sp).toLowerCase())) return value;
    var prev = tokens[i - 1];
    if (!prev || !ARTICLES.has(prev.lw) || !isGapBlank(text, prev.e, tokens[i].s)) return value;
    return value.slice(sp + 1);
  }

  function words(s) { return s.split(' ').length; }
  function q(s) { return '\u201c' + s + '\u201d'; }

  /* ---------------------------------------------------- clarity lens tables */

  // Nominalisations: a verb wearing a noun suffix. 58 pairs, both spellings of
  // -ise/-ize where both are current.
  var NOMINALISATIONS = buildDict([
    ['utilisation', 'use'], ['utilization', 'use'],
    ['implementation', 'build'], ['optimisation', 'speed up'], ['optimization', 'speed up'],
    ['documentation', 'docs'], ['configuration', 'setup'], ['integration', 'connect'],
    ['application', 'app'], ['information', 'facts'], ['consideration', 'consider'],
    ['determination', 'decide'], ['evaluation', 'test'], ['examination', 'check'],
    ['expectation', 'expect'], ['explanation', 'explain'], ['identification', 'identify'],
    ['investigation', 'look into'], ['modification', 'change'], ['modifications', 'changes'],
    ['notification', 'alert'], ['notifications', 'alerts'], ['observation', 'note'],
    ['preparation', 'prepare'], ['presentation', 'talk'], ['prevention', 'prevent'],
    ['recommendation', 'advice'], ['recommendations', 'advice'], ['registration', 'sign-up'],
    ['simplification', 'simplify'], ['specification', 'spec'], ['transformation', 'change'],
    ['validation', 'check'], ['verification', 'check'], ['migration', 'move'],
    ['allocation', 'assign'], ['authentication', 'log-in'], ['authorisation', 'permission'],
    ['authorization', 'permission'], ['calculation', 'sum'], ['completion', 'finish'],
    ['creation', 'make'], ['duplication', 'copy'], ['generation', 'make'],
    ['isolation', 'isolate'], ['limitation', 'limit'], ['negotiation', 'bargain'],
    ['organisation', 'group'], ['organization', 'group'], ['participation', 'take part'],
    ['reduction', 'cut'], ['selection', 'pick'], ['separation', 'split'],
    ['termination', 'end'], ['translation', 'translate'],
    ['improvement', 'gain'], ['improvements', 'gains'], ['measurement', 'measure'],
    ['requirement', 'need'], ['requirements', 'needs'], ['agreement', 'deal'],
    ['achievement', 'win'], ['assessment', 'check'], ['adjustment', 'tweak'],
    ['enhancement', 'upgrade'], ['announcement', 'news'], ['statement', 'claim'],
    ['replacement', 'swap'], ['arrangement', 'plan'], ['development', 'work'],
    ['management', 'running it'], ['deployment', 'release'], ['settlement', 'deal'],
    ['performance', 'speed'], ['maintenance', 'upkeep'], ['assistance', 'help'],
    ['acceptance', 'accept'], ['appearance', 'look'], ['attendance', 'turnout'],
    ['compliance', 'follow the rules'], ['guidance', 'advice'], ['importance', 'weight'],
    ['reliance', 'depend on'], ['resistance', 'pushback'], ['significance', 'weight'],
    ['functionality', 'features'], ['capability', 'ability'], ['capabilities', 'abilities'],
    ['availability', 'uptime'], ['reliability', 'uptime'], ['scalability', 'room to grow'],
    ['usability', 'ease of use'], ['flexibility', 'give'], ['granularity', 'detail'],
    ['complexity', 'how tangled it is'], ['opportunity', 'chance'], ['possibility', 'chance'],
    ['responsibility', 'duty'], ['visibility', 'a view'], ['similarity', 'likeness']
  ]);

  // Buzzwords, whole words only. A string value is a swap that is the same part
  // of speech as the jargon and reads in any position the jargon reads in;
  // null means the plain word depends on the sentence, so the rule points and
  // leaves the text alone rather than guessing ("limited bandwidth" is not
  // "limited time", "the Java ecosystem" is not "the Java set of tools").
  var JARGON = buildDict([
    ['leverage', 'use'], ['leverages', 'uses'], ['leveraging', 'using'], ['leveraged', 'used'],
    ['utilise', 'use'], ['utilize', 'use'], ['utilises', 'uses'], ['utilizes', 'uses'],
    ['utilising', 'using'], ['utilizing', 'using'],
    ['facilitate', 'help'], ['facilitates', 'helps'], ['facilitating', 'helping'],
    ['robust', 'solid'], ['paradigm', 'model'], ['synergy', 'overlap'], ['synergies', 'overlaps'],
    ['seamless', 'smooth'], ['seamlessly', 'smoothly'],
    ['actionable', 'usable'], ['impactful', 'effective'],
    ['granular', 'detailed'], ['learnings', 'lessons'],
    ['ideate', 'think'], ['operationalise', 'run'], ['operationalize', 'run'],
    ['incentivise', 'reward'], ['incentivize', 'reward'], ['disrupt', 'upend'],
    ['mission-critical', 'essential'], ['world-class', 'excellent'],
    ['turnkey', 'ready-to-run'],
    ['going forward', 'from now on'], ['at the end of the day', 'in the end'],
    ['low-hanging fruit', 'the easy wins'],
    ['core competency', 'main skill'], ['value-add', 'benefit'], ['deep dive', 'close look'],
    ['touch base', 'talk'], ['thought leadership', 'opinions'],
    ['game changer', 'big change'], ['game-changer', 'big change'],
    ['move the needle', 'make a difference'], ['boil the ocean', 'do everything at once'],
    // Pointer-only: no swap holds up in every position these words appear in.
    ['holistic', null], ['scalable', null], ['optics', null], ['bandwidth', null],
    // Superlative glosses need "the" and cannot follow "a": "a newest platform".
    ['state-of-the-art', null], ['cutting-edge', null], ['best-in-class', null],
    ['ecosystem', null], ['stakeholders', null], ['stakeholder', null],
    ['onboarding', null], ['disruptive', null], ['win-win', null],
    ['best practice', null], ['circle back', null]
  ]);

  var CLAUSE_MARKERS = ['which', 'that', 'who', 'where', 'while', 'although', 'because'];
  var CLAUSE_SET = new Set(CLAUSE_MARKERS);

  var LONG_SENTENCE_WORDS = 28;
  // A sentence has to be long AND tangled before the clause count means
  // anything: "We know that that is the file that works." is nine words.
  var CLAUSE_STACK_MIN_WORDS = 20;

  /* --------------------------------------------------- concreteness tables */

  // 26 hedges. Value is DELETE for all of them: a hedge is cut, never swapped.
  var HEDGE_PAIRS = [
    'somewhat', 'arguably', 'perhaps', 'fairly', 'rather', 'quite', 'sort of', 'kind of',
    'it could be argued that', 'it seems that', 'it appears that', 'i think that',
    'i believe that', 'basically', 'essentially', 'generally speaking', 'more or less',
    'possibly', 'probably', 'maybe', 'apparently', 'seemingly', 'relatively', 'presumably',
    'in my opinion', 'to some extent', 'for the most part', 'in a sense'
  ];
  var HEDGES = buildDict(HEDGE_PAIRS.map(function (h) { return [h, DELETE]; }));

  // Words that make a hedge candidate not a hedge: "rather than" is a
  // comparison, "what kind of" is a question, "sort of thing" needs the noun.
  var HEDGE_DEMONSTRATIVES = ['what', 'this', 'that', 'which', 'the', 'a', 'any', 'every'];
  var HEDGE_NEXT_BLOCK = new Map([['rather', ['than']], ['quite', ['a', 'an', 'the']]]);
  var HEDGE_PREV_BLOCK = new Map([['kind of', HEDGE_DEMONSTRATIVES],
                                  ['sort of', HEDGE_DEMONSTRATIVES]]);

  // 14 vague quantifiers. Every one points only: swapping a vague word for
  // another vague word is not an edit, so the finding asks for the number.
  var VAGUE = buildDict([
    ['many', null], ['several', null], ['various', null], ['most', null], ['some', null],
    ['numerous', null], ['a number of', null], ['a large number of', null],
    ['a small number of', null], ['a lot of', null], ['lots of', null], ['a few', null],
    ['a variety of', null], ['a range of', null], ['multiple', null], ['plenty of', null]
  ]);

  var WEAK_VERBS = new Set(['is', 'are', 'was', 'were', 'has', 'have', 'does', 'do', 'makes',
    'make', 'gets', 'get', 'improves', 'improve', 'increases', 'increase', 'reduces', 'reduce',
    'helps', 'help', 'works', 'work', 'runs', 'run']);

  // -ly words that are not adverbs, or are adverbs that carry real content.
  var NOT_ADVERBS = new Set(['only', 'early', 'likely', 'family', 'apply', 'supply', 'reply',
    'imply', 'comply', 'multiply', 'rely', 'ally', 'rally', 'tally', 'folly', 'jolly', 'holy',
    'ugly', 'silly', 'belly', 'jelly', 'bully', 'fully', 'daily', 'weekly', 'monthly', 'yearly',
    'hourly', 'nightly', 'italy', 'july', 'assembly', 'anomaly', 'monopoly', 'panoply', 'reply',
    'supply', 'butterfly', 'melancholy', 'ply', 'fly', 'sly', 'wholly']);

  var PASSIVE_AUX = new Set(['was', 'were', 'is', 'are', 'been', 'being']);

  // 34 irregular past participles; everything else is caught by the -ed suffix.
  var IRREGULAR_PARTICIPLES = new Set(['written', 'built', 'made', 'taken', 'given', 'shown',
    'held', 'run', 'sent', 'seen', 'done', 'said', 'told', 'kept', 'left', 'found', 'brought',
    'bought', 'caught', 'taught', 'thought', 'sold', 'put', 'set', 'cut', 'read', 'led', 'met',
    'paid', 'lost', 'won', 'drawn', 'driven', 'eaten', 'chosen', 'broken', 'spoken', 'known',
    'grown', 'thrown', 'worn', 'torn', 'begun', 'dealt', 'felt', 'meant', 'spent', 'struck']);

  var DETERMINERS = new Set(['the', 'a', 'an', 'our', 'their', 'its', 'his', 'her', 'my',
    'your', 'this', 'that', 'these', 'those', 'every', 'each']);

  // "by the way" and "by design" are not agents, and neither is "by Friday":
  // an adverbial of time, place or manner after "by" names a deadline or a
  // channel, not somebody who could be the subject of an active sentence.
  var BY_NON_AGENT = new Set(['way', 'now', 'then', 'default', 'hand', 'design', 'contrast',
    'comparison', 'accident', 'mistake', 'chance', 'itself', 'himself', 'herself', 'themselves',
    'ourselves', 'necessity', 'definition', 'far', 'means', 'virtue', 'reference',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
    'noon', 'midnight', 'morning', 'afternoon', 'evening', 'night', 'today',
    'tomorrow', 'yesterday', 'email', 'phone', 'post', 'mail', 'accident']);

  /* --------------------------------------------------------- economy tables */

  // 38 filler phrases. DELETE means the phrase carries no information at all.
  var FILLERS = buildDict([
    ['in order to', 'to'], ['in order for', 'for'], ['at this point in time', 'now'],
    ['at the present time', 'now'], ['at this time', 'now'], ['due to the fact that', 'because'],
    ['owing to the fact that', 'because'], ['in spite of the fact that', 'although'],
    ['despite the fact that', 'although'], ['in the event that', 'if'], ['in the event of', 'if'],
    ['has the ability to', 'can'], ['have the ability to', 'can'], ['is able to', 'can'],
    ['are able to', 'can'], ['was able to', 'could'], ['were able to', 'could'],
    ['for the purpose of', 'for'], ['with regard to', 'about'], ['with regards to', 'about'],
    ['in regard to', 'about'], ['in reference to', 'about'], ['in relation to', 'about'],
    ['prior to', 'before'], ['subsequent to', 'after'], ['in the near future', 'soon'],
    ['on a daily basis', 'daily'], ['on a regular basis', 'regularly'],
    ['in the vicinity of', 'near'], ['in close proximity to', 'near'],
    ['take into consideration', 'consider'], ['make a decision', 'decide'],
    ['come to a conclusion', 'conclude'], ['give consideration to', 'consider'],
    ['in a timely manner', 'promptly'], ['until such time as', 'until'],
    ['a majority of', 'most'], ['in the amount of', 'of'],
    ['in the process of', DELETE], ['it is important to note that', DELETE],
    ['it should be noted that', DELETE], ['needless to say', DELETE],
    ['as a matter of fact', DELETE], ['for all intents and purposes', DELETE]
  ]);

  // 26 redundant pairs.
  var REDUNDANT = buildDict([
    ['each and every', 'every'], ['first and foremost', 'first'], ['null and void', 'void'],
    ['basic fundamentals', 'basics'], ['end result', 'result'], ['past history', 'history'],
    ['free gift', 'gift'], ['advance planning', 'planning'], ['close proximity', 'nearness'],
    ['final outcome', 'outcome'], ['future plans', 'plans'], ['added bonus', 'bonus'],
    ['unexpected surprise', 'surprise'], ['absolutely essential', 'essential'],
    ['completely eliminate', 'eliminate'], ['joint collaboration', 'collaboration'],
    ['personal opinion', 'opinion'], ['true facts', 'facts'], ['revert back', 'revert'],
    ['repeat again', 'repeat'], ['new innovation', 'innovation'], ['sum total', 'total'],
    ['general consensus', 'consensus'], ['past experience', 'experience'],
    ['mutual cooperation', 'cooperation'], ['plan ahead', 'plan'], ['merge together', 'merge'],
    ['combine together', 'combine'], ['refer back', 'refer']
  ]);

  var INTENSIFIERS = buildDict([
    ['very', DELETE], ['really', DELETE], ['extremely', DELETE], ['incredibly', DELETE],
    ['highly', DELETE], ['truly', DELETE], ['actually', DELETE], ['literally', DELETE],
    ['definitely', DELETE]
  ]);

  // An intensifier only counts before something it can intensify. Suffixes that
  // are ambiguous between adjective and verb (-ed, -ing) are deliberately out:
  // "actually shipped" must not be read as intensifier + adjective.
  var ADJ_SUFFIXES = ['ous', 'ful', 'ive', 'able', 'ible', 'ical', 'istic', 'less', 'ish',
    'ant', 'ent', 'ary', 'ory'];
  var ADJ_COMMON = new Set(['good', 'bad', 'fast', 'slow', 'big', 'small', 'hard', 'easy',
    'high', 'low', 'new', 'old', 'long', 'short', 'strong', 'weak', 'clear', 'clean', 'complex',
    'simple', 'large', 'deep', 'rich', 'poor', 'safe', 'late', 'quick', 'smart', 'tough',
    'cheap', 'common', 'rare', 'sure', 'real', 'close', 'wide', 'narrow', 'dense', 'sparse',
    'robust', 'solid', 'brittle', 'fragile', 'stable', 'unstable', 'similar', 'different',
    'important', 'useful', 'quiet', 'loud', 'heavy', 'light', 'thin', 'thick', 'rough',
    'smooth', 'odd', 'strange', 'nice', 'fine', 'well', 'far', 'near']);
  var ADJ_BLOCK = new Set(['the', 'a', 'an', 'much', 'many', 'more', 'most', 'is', 'are',
    'was', 'were', 'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'no',
    'i', 'we', 'it', 'they', 'he', 'she', 'you', 'this', 'that', 'these', 'those', 'there']);

  var REPETITION_WINDOW = 120;   // words
  var REPETITION_MIN = 3;        // occurrences inside one window
  var REPETITION_MIN_LEN = 5;    // letters
  var REPETITION_STOPWORDS = new Set(['about', 'above', 'after', 'again', 'against', 'along',
    'among', 'another', 'because', 'before', 'being', 'below', 'between', 'both', 'cannot',
    'could', 'doing', 'during', 'each', 'either', 'every', 'first', 'from', 'further', 'have',
    'having', 'here', 'itself', 'might', 'more', 'most', 'much', 'must', 'never', 'other',
    'ought', 'over', 'same', 'should', 'since', 'some', 'such', 'than', 'that', 'their',
    'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
    'through', 'under', 'until', 'very', 'were', 'what', 'when', 'where', 'which', 'while',
    'with', 'would', 'your', 'yours', 'yourself', 'about', 'shall', 'still', 'also', 'only',
    'into', 'just', 'like', 'make', 'made', 'many', 'even', 'ever', 'else', 'less', 'well']);

  /* ------------------------------------------------------------ clarity rules */

  // Pointer only, always. Splitting at a joint produced subjectless fragments
  // ("..., and then writes the bytes" -> ". Then writes the bytes"), because the
  // second half of a coordination borrows its subject from the first half and
  // nothing here can tell when it does. Where the sentence should break is a
  // judgement about the argument, so the rule shows the length and stops.
  function ruleLongSentence(text, ctx) {
    var out = [], sents = ctx.sentences, i;
    for (i = 0; i < sents.length; i++) {
      var sn = sents[i];
      if (sn.words <= LONG_SENTENCE_WORDS) continue;
      out.push(finding(text, 'long-sentence', 'Long sentence', sn.start, sn.end,
        'This sentence runs ' + sn.words + ' words; the lens flags over ' +
        LONG_SENTENCE_WORDS + ', so break it where the second claim starts.', null));
    }
    return out;
  }

  function ruleClauseStack(text, ctx) {
    var out = [], sents = ctx.sentences, i, k;
    for (i = 0; i < sents.length; i++) {
      var sn = sents[i], hits = [], seen = [];
      for (k = sn.from; k < sn.to; k++) {
        if (CLAUSE_SET.has(ctx.tokens[k].lw)) {
          hits.push(ctx.tokens[k]);
          if (seen.indexOf(ctx.tokens[k].lw) < 0) seen.push(ctx.tokens[k].lw);
        }
      }
      if (hits.length < 3 || sn.words < CLAUSE_STACK_MIN_WORDS) continue;
      // Span the evidence, not the whole sentence: word-level findings before
      // the first marker still survive the overlap filter.
      var a = hits[0].s, b = hits[hits.length - 1].e;
      out.push(finding(text, 'clause-stack', 'Stacked clauses', a, b,
        'This ' + sn.words + '-word sentence hangs ' + hits.length +
        ' subordinate clauses off each other (' + seen.join(', ') +
        '), so the main claim is buried.', null));
    }
    return out;
  }

  // Pointer only. Swapping the noun for its verb changes the part of speech and
  // the sentence around it stops agreeing: "Our documentation is thin" became
  // "Our docs is thin", "Compliance requires docs" became "Follow the rules
  // requires docs". Naming the buried verb is the whole of the useful advice;
  // the rewrite belongs to whoever knows what the subject is.
  function ruleNominalisation(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, NOMINALISATIONS, function (i, j, key, value) {
      var t = ctx.tokens[i];
      out.push(finding(text, 'nominalisation', 'Nominalisation', t.s, ctx.tokens[j].e,
        q(t.w) + ' buries the verb ' + q(value) + '; rebuild the sentence around that verb.',
        null));
    });
    return out;
  }

  // A swap that lands the same word twice in one breath ("a highly effective,
  // very impactful engineer" -> "an effective, effective engineer") is not an
  // improvement, so the rule points at the jargon instead of introducing the
  // repetition. Six tokens either side is the span a reader hears as one phrase.
  var JARGON_ECHO_WINDOW = 6;

  // Only the content words of the gloss count: every second phrase repeats
  // "the", and "the easy wins" beside another "the" is not an echo.
  var GLOSS_FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by',
    'for', 'and', 'or', 'from', 'with', 'as', 'it', 'is', 'be', 'so', 'now', 'that', 'this']);

  function echoesNearby(tokens, i, j, value) {
    var parts = value.toLowerCase().split(' ');
    var from = Math.max(0, i - JARGON_ECHO_WINDOW);
    var to = Math.min(tokens.length - 1, j + JARGON_ECHO_WINDOW), k, p;
    for (k = from; k <= to; k++) {
      if (k >= i && k <= j) continue;
      for (p = 0; p < parts.length; p++) {
        if (GLOSS_FUNCTION_WORDS.has(parts[p])) continue;
        if (tokens[k].lw === parts[p]) return true;
      }
    }
    return false;
  }

  function ruleJargon(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, JARGON, function (i, j, key, value) {
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
      // Quoted material is mentioned, not used: 'The word "robust" is overused'
      // is about the word itself and must survive verbatim.
      if (quotedAlone(text, a, b)) return;
      if (isCapitalised(quote)) {
        // "Robust Systems Inc." is a name. A capital mid-sentence is never this
        // rule's business, and a capital at a sentence start followed by another
        // capital is a name that happens to open the sentence.
        if (!startsSentence(text, a, ctx.headStarts)) return;
        var after = ctx.tokens[j + 1];
        if (after && isGapBlank(text, b, after.s) && isCapitalised(after.w)) return;
      }
      if (value === null) {
        out.push(finding(text, 'jargon', 'Jargon', a, b,
          q(quote) + ' is business jargon whose plain word changes with the sentence; ' +
          'name the thing you mean.', null));
        return;
      }
      if (echoesNearby(ctx.tokens, i, j, value)) {
        out.push(finding(text, 'jargon', 'Jargon', a, b,
          q(quote) + ' is business jargon for ' + q(value) +
          ', which already sits beside it; rephrase rather than repeat.', null));
        return;
      }
      value = trimLeadingArticle(text, ctx.tokens, i, value);
      out.push(finding(text, 'jargon', 'Jargon', a, b,
        q(quote) + ' is business jargon for ' + q(value) + '.',
        matchCapital(quote, value)));
    });
    return out;
  }

  /* ------------------------------------------------------ concreteness rules */

  function hedgeBlocked(tokens, i, j, key) {
    var nextBlock = HEDGE_NEXT_BLOCK.get(key), prevBlock = HEDGE_PREV_BLOCK.get(key);
    if (nextBlock && tokens[j + 1] && nextBlock.indexOf(tokens[j + 1].lw) >= 0) return true;
    if (prevBlock && tokens[i - 1] && prevBlock.indexOf(tokens[i - 1].lw) >= 0) return true;
    return false;
  }

  function ruleHedge(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, HEDGES, function (i, j, key) {
      if (hedgeBlocked(ctx.tokens, i, j, key)) return;
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
      if (enclosedAlone(text, a, b)) return; // '(basically)' would become '()'
      var edit = deletionEdit(text, a, b, ctx.headStarts);
      out.push(finding(text, 'hedge', 'Hedge', edit.start, edit.end,
        q(quote) + ' softens the claim without changing what it says.',
        edit.replacement, edit.display));
    });
    return out;
  }

  function countHedges(text, tokens) {
    var n = 0;
    scanDict(text, tokens, HEDGES, function (i, j, key) {
      if (!hedgeBlocked(tokens, i, j, key)) n++;
    });
    return n;
  }

  function ruleVagueQuantifier(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, VAGUE, function (i, j) {
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
      out.push(finding(text, 'vague-quantifier', 'Vague quantifier', a, b,
        q(quote) + ' stands where a number belongs; say how many.', null));
    });
    return out;
  }

  function isAdverb(lw) {
    if (lw.length < 5) return false;
    if (lw.slice(-2) !== 'ly') return false;
    return !NOT_ADVERBS.has(lw);
  }

  function ruleAdverbProp(text, ctx) {
    var out = [], tokens = ctx.tokens, i;
    for (i = 0; i + 1 < tokens.length; i++) {
      var a = tokens[i], b = tokens[i + 1];
      if (!isAdverb(a.lw) || !WEAK_VERBS.has(b.lw)) continue;
      // A capital means a name, not an adverb: "Emily is the release manager"
      // must not lose Emily. Only an all-lowercase -ly token fires.
      if (a.w !== a.lw) continue;
      if (!isGapBlank(text, a.e, b.s)) continue;
      if (enclosedAlone(text, a.s, a.e)) continue;
      var edit = deletionEdit(text, a.s, a.e, ctx.headStarts);
      out.push(finding(text, 'adverb-prop', 'Adverb propping a weak verb', edit.start, edit.end,
        q(a.w) + ' props up the weak verb ' + q(b.w) + ' instead of a verb that carries the claim.',
        edit.replacement, edit.display));
    }
    return out;
  }

  function isParticiple(lw) {
    if (IRREGULAR_PARTICIPLES.has(lw)) return true;
    return lw.length >= 4 && lw.slice(-2) === 'ed';
  }

  function rulePassiveWithAgent(text, ctx) {
    var out = [], tokens = ctx.tokens, i;
    for (i = 0; i < tokens.length; i++) {
      if (!PASSIVE_AUX.has(tokens[i].lw)) continue;
      var p = i + 1;
      // one optional adverb between auxiliary and participle
      if (tokens[p] && isAdverb(tokens[p].lw) && isGapBlank(text, tokens[p - 1].e, tokens[p].s)) p++;
      if (!tokens[p] || !isParticiple(tokens[p].lw)) continue;
      if (!isGapBlank(text, tokens[p - 1].e, tokens[p].s)) continue;
      var byTok = tokens[p + 1];
      if (!byTok || byTok.lw !== 'by' || !isGapBlank(text, tokens[p].e, byTok.s)) continue;

      var a = p + 2;
      if (!tokens[a] || !isGapBlank(text, byTok.e, tokens[a].s)) continue;
      if (!HAS_ALNUM_RE.test(tokens[a].w) || /^[\p{N}]/u.test(tokens[a].w)) continue; // "by 40 percent"
      var end = a;
      if (DETERMINERS.has(tokens[a].lw)) {
        if (!tokens[a + 1] || !isGapBlank(text, tokens[a].e, tokens[a + 1].s)) continue;
        end = a + 1;
      }
      if (BY_NON_AGENT.has(tokens[end].lw)) continue;
      if (/^[\p{N}]/u.test(tokens[end].w)) continue; // "by the 3rd", "by 40 percent"

      // let one modifier ride along: "by our nightly scheduler"
      if (isAdverb(tokens[end].lw) && tokens[end + 1] &&
          isGapBlank(text, tokens[end].e, tokens[end + 1].s)) end++;

      var agent = text.slice(tokens[a].s, tokens[end].e);
      out.push(finding(text, 'passive-with-agent', 'Passive with a named agent',
        tokens[i].s, tokens[end].e,
        'This is passive with ' + q(agent) + ' trailing after \u201cby\u201d; make ' + q(agent) +
        ' the subject of the sentence.', null));
      i = end; // do not restart inside the span just reported
    }
    return out;
  }

  /* ------------------------------------------------------------ economy rules */

  function ruleFillerPhrase(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, FILLERS, function (i, j, key, value) {
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
      if (value === DELETE) {
        if (enclosedAlone(text, a, b)) return;
        var edit = deletionEdit(text, a, b, ctx.headStarts);
        out.push(finding(text, 'filler-phrase', 'Filler phrase', edit.start, edit.end,
          q(quote) + ' spends ' + words(key) + ' words and adds nothing the sentence needs.',
          edit.replacement, edit.display));
      } else {
        value = trimLeadingArticle(text, ctx.tokens, i, value);
        out.push(finding(text, 'filler-phrase', 'Filler phrase', a, b,
          q(quote) + ' takes ' + words(key) + ' words to say what ' + q(value) + ' says in ' +
          words(value) + '.', matchCapital(quote, value)));
      }
    });
    return out;
  }

  function ruleRedundantPair(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, REDUNDANT, function (i, j, key, value) {
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
      value = trimLeadingArticle(text, ctx.tokens, i, value);
      out.push(finding(text, 'redundant-pair', 'Redundant pair', a, b,
        q(quote) + ' says one thing twice; ' + q(value) + ' carries all of it.',
        matchCapital(quote, value)));
    });
    return out;
  }

  function looksAdjectival(lw) {
    if (ADJ_BLOCK.has(lw)) return false;
    if (ADJ_COMMON.has(lw)) return true;
    for (var i = 0; i < ADJ_SUFFIXES.length; i++) {
      var suf = ADJ_SUFFIXES[i];
      if (lw.length > suf.length + 1 && lw.slice(-suf.length) === suf) return true;
    }
    // an adverb ("very quickly") is intensifiable too
    return isAdverb(lw);
  }

  // "not very useful" means "of little use"; cutting the intensifier turns it
  // into "not useful", which is a different claim. Any negation in the two
  // tokens before the intensifier takes the rule off the sentence.
  var NEGATIONS = new Set(['not', 'never', 'hardly', 'barely', 'scarcely']);

  function negatedBefore(tokens, i) {
    for (var k = i - 1; k >= 0 && k >= i - 2; k--) {
      var lw = tokens[k].lw, tail = lw.slice(-3);
      if (NEGATIONS.has(lw)) return true;
      if (lw.length > 3 && (tail === "n't" || tail === 'n\u2019t')) return true;
    }
    return false;
  }

  function ruleVeryIntensifier(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, INTENSIFIERS, function (i, j) {
      var nextTok = ctx.tokens[j + 1];
      if (!nextTok || !isGapBlank(text, ctx.tokens[j].e, nextTok.s)) return;
      if (!looksAdjectival(nextTok.lw)) return;
      if (negatedBefore(ctx.tokens, i)) return;
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
      if (enclosedAlone(text, a, b)) return;
      var edit = deletionEdit(text, a, b, ctx.headStarts);
      out.push(finding(text, 'very-intensifier', 'Empty intensifier', edit.start, edit.end,
        q(quote) + ' before ' + q(nextTok.w) + ' adds emphasis, not information.',
        edit.replacement, edit.display));
    });
    return out;
  }

  // Bounded on purpose. The naive form ("for every window, count every word") is
  // O(n * 120). This instead groups occurrences per word and asks only whether
  // some three consecutive occurrences fall inside one window — one pass over
  // the occurrence lists, O(n) total, and at most one finding per word.
  function ruleRepetition(text, ctx) {
    var out = [], tokens = ctx.tokens, i, by = new Map();
    for (i = 0; i < tokens.length; i++) {
      var lw = tokens[i].lw;
      if (lw.length < REPETITION_MIN_LEN) continue;
      if (REPETITION_STOPWORDS.has(lw)) continue;
      if (!HAS_ALNUM_RE.test(lw)) continue;
      var list = by.get(lw);
      if (!list) { list = []; by.set(lw, list); }
      list.push(i);
    }
    by.forEach(function (list, lw) {
      if (list.length < REPETITION_MIN) return;
      var k;
      for (k = 0; k + REPETITION_MIN - 1 < list.length; k++) {
        var last = list[k + REPETITION_MIN - 1];
        if (last - list[k] >= REPETITION_WINDOW) continue;
        var count = 0, m;
        for (m = k; m < list.length && list[m] - list[k] < REPETITION_WINDOW; m++) count++;
        // A finding's identity for deduplication is (rule, quote) — see the note
        // on finding(). A counting rule fires once per chunk when a long draft
        // is critiqued in pieces, so the two reports of one word have to carry
        // the same quote: inside the window, prefer the occurrence spelled in
        // lower case, so a chunk that happens to open with "Documentation" still
        // reports "documentation" and merges with the chunk beside it.
        var t = tokens[list[k]];
        for (m = k; m < list.length && list[m] - list[k] < REPETITION_WINDOW; m++) {
          if (tokens[list[m]].w === lw) { t = tokens[list[m]]; break; }
        }
        out.push(finding(text, 'repetition', 'Repeated word', t.s, t.e,
          q(t.w) + ' appears ' + count + ' times inside ' + REPETITION_WINDOW +
          ' words; vary it or cut the sentences that repeat it.', null));
        return; // one finding per word, whatever the count
      }
    });
    return out;
  }

  /* ------------------------------------------------------------------ lenses */

  // Order inside each list is the last tie-break when two findings claim the
  // same span, so it is part of the contract, not cosmetic.
  // A Map, not an object literal: a caller passing "toString" or "constructor"
  // must get the same rejection as any other unknown lens.
  var LENS_RULES = new Map([
    ['clarity', [ruleLongSentence, ruleClauseStack, ruleNominalisation, ruleJargon]],
    ['concreteness', [ruleHedge, ruleVagueQuantifier, ruleAdverbProp, rulePassiveWithAgent]],
    ['economy', [ruleFillerPhrase, ruleRedundantPair, ruleRepetition, ruleVeryIntensifier]]
  ]);

  var LENSES = [
    { id: 'clarity', name: 'Clarity',
      blurb: 'Looks for sentences that run long, clauses that stack, and verbs hidden inside nouns.' },
    { id: 'concreteness', name: 'Concreteness',
      blurb: 'Looks for hedges, quantities left vague, and agents pushed behind the verb.' },
    { id: 'economy', name: 'Economy',
      blurb: 'Looks for phrases, pairs and intensifiers that spend words without adding meaning.' }
  ];

  /* --------------------------------------------------------------- critique */

  // opts.before (default '') is the text immediately in front of this
  // fragment. Pass the tail of the previous chunk when critiquing a long draft
  // in pieces — 40 characters is plenty — and the rules read offset 0 the way a
  // reader does: a fragment cut at a sentence end keeps its capital, a fragment
  // cut mid-sentence never gains one.
  //
  // opts.atTextStart is the deprecated alias it replaces: true (or absent) maps
  // to before '', false to before 'x ' — a fragment that follows a word.
  function beforeOf(opts) {
    if (opts && typeof opts.before === 'string') return opts.before;
    if (opts && opts.atTextStart !== undefined) return opts.atTextStart === false ? 'x ' : '';
    return '';
  }

  function critique(text, lensId, opts) {
    text = toText(text);
    var rules = LENS_RULES.get(lensId);
    if (!rules) throw new Error('critic-loop: unknown lens "' + lensId + '"');

    var before = beforeOf(opts);
    var tokens = tokenize(text);
    var ctx = { tokens: tokens, sentences: sentencesWithTokens(text, tokens),
                headStarts: headStartsSentence(before) };

    var raw = [], r, i, produced, k;
    for (r = 0; r < rules.length; r++) {
      produced = rules[r](text, ctx);
      for (k = 0; k < produced.length; k++) {
        produced[k]._order = r;
        raw.push(produced[k]);
      }
    }

    // Sort: earliest start wins, then the longer span, then the rule that comes
    // first in this lens's list.
    function order(a, b) {
      if (a.start !== b.start) return a.start - b.start;
      var la = a.end - a.start, lb = b.end - b.start;
      if (la !== lb) return lb - la;
      if (a._order !== b._order) return a._order - b._order;
      return a.rule < b.rule ? -1 : (a.rule > b.rule ? 1 : 0);
    }
    raw.sort(order);

    // Non-overlap is a constraint on rewriting, not on reporting: two edits that
    // share a character cannot both be applied. A pointer applies nothing, so it
    // is exempt — a 30-word long-sentence pointer used to swallow every jargon
    // fix inside it and the pass applied nothing at all. Sweep left to right
    // over the applicable findings only; pointers all survive.
    var applicable = [], pointers = [], f;
    for (i = 0; i < raw.length; i++) {
      f = raw[i];
      if (f.end <= f.start && f.replacement === null) continue; // empty pointer
      (f.replacement === null ? pointers : applicable).push(f);
    }
    var findings = [], lastEnd = -1;
    for (i = 0; i < applicable.length; i++) {
      if (applicable[i].start < lastEnd) continue;
      findings.push(applicable[i]);
      lastEnd = applicable[i].end;
    }
    findings = findings.concat(pointers);
    findings.sort(order);
    repairArticles(text, findings);
    findings.sort(order);   // a repaired span starts one article earlier
    for (i = 0; i < findings.length; i++) delete findings[i]._order;
    return { lens: lensId, findings: findings };
  }

  /* ---------------------------------------------------------- applyFindings */

  // Right to left, so an edit never moves the offsets of the edits still to
  // come. Built as a piece list joined once: rebuilding the whole string per
  // finding is O(n) each and turns a 300 kB draft into seconds of copying.
  // Neither the array nor the finding objects passed in are mutated.
  function applyFindings(text, findings) {
    text = toText(text);
    var list = (findings || []).slice();
    list.sort(function (a, b) { return b.start - a.start; });

    var pieces = [], cursor = text.length, applied = 0, i, f;
    for (i = 0; i < list.length; i++) {
      f = list[i];
      if (!f || f.replacement === null || f.replacement === undefined) continue;
      if (f.start < 0 || f.end < f.start || f.end > text.length) continue;
      if (f.end > cursor) continue; // caller handed in overlapping spans
      pieces.push(text.slice(f.end, cursor));
      pieces.push(String(f.replacement));
      cursor = f.start;
      applied++;
    }
    pieces.push(text.slice(0, cursor));
    pieces.reverse();
    return { text: pieces.join(''), applied: applied };
  }

  /* ---------------------------------------------------------------- metrics */

  var ALNUM_ONE_RE = /[\p{L}\p{N}]/u;
  function isAlnumChar(ch) {
    if (ch >= 'a' && ch <= 'z') return true;
    if (ch >= 'A' && ch <= 'Z') return true;
    if (ch >= '0' && ch <= '9') return true;
    return ch > '\u007f' && ALNUM_ONE_RE.test(ch);
  }

  // One left-to-right pass over the characters, no slicing and no regex over an
  // unbounded span: words and sentences are counted by the same walk, so the
  // whole function is O(n) with a small constant on any input, punctuated or
  // not. (The previous version ran a regex per non-space run and rebuilt the
  // sentence list as an array of substrings.) Counts are byte-identical to
  // \S+-with-a-letter for words and to splitSentences().length for sentences.
  function metrics(text) {
    text = toText(text);
    var n = text.length, wordCount = 0, sentenceCount = 0;
    var inWord = false, wordHasAlnum = false, segHasContent = false;
    var i = 0, j, ch;
    while (i < n) {
      ch = text.charAt(i);
      if (isSpace(ch)) {
        if (inWord && wordHasAlnum) wordCount++;
        inWord = false; wordHasAlnum = false;
        i++;
        continue;
      }
      inWord = true;
      segHasContent = true;
      if (TERMINATORS.indexOf(ch) >= 0) {
        j = i;
        while (j < n && TERMINATORS.indexOf(text.charAt(j)) >= 0) j++;
        if (j >= n || isSpace(text.charAt(j))) {   // this run closes a sentence
          if (wordHasAlnum) wordCount++;
          inWord = false; wordHasAlnum = false;
          sentenceCount++;
          segHasContent = false;
        }
        i = j;                                     // "e.g." keeps its word going
        continue;
      }
      if (!wordHasAlnum && isAlnumChar(ch)) wordHasAlnum = true;
      i++;
    }
    if (inWord && wordHasAlnum) wordCount++;
    if (segHasContent) sentenceCount++;
    if (sentenceCount === 0 && wordCount > 0) sentenceCount = 1;
    var mean = sentenceCount === 0 ? 0 : Math.round((wordCount / sentenceCount) * 10) / 10;
    return {
      words: wordCount,
      sentences: sentenceCount,
      meanSentenceLength: mean === 0 ? 0 : mean,
      hedges: countHedges(text, tokenize(text)),
      chars: text.length
    };
  }

  /* -------------------------------------------------------------- diffWords */

  // Whitespace travels with the word that follows it, so concatenating the
  // tokens reproduces the input byte for byte. \S+ (never \s*\S+) because a
  // leading-whitespace quantifier backtracks quadratically on runs of spaces.
  function diffTokens(s) {
    var out = [], m, prev = 0;
    NONSPACE_RE.lastIndex = 0;
    while ((m = NONSPACE_RE.exec(s)) !== null) {
      var end = m.index + m[0].length;
      out.push(s.slice(prev, end));
      prev = end;
    }
    if (prev < s.length) out.push(s.slice(prev));
    return out;
  }

  function diffWords(a, b) {
    a = toText(a); b = toText(b);
    var A = diffTokens(a), B = diffTokens(b);
    if (A.length > MAX_DIFF_TOKENS || B.length > MAX_DIFF_TOKENS) {
      return [{ type: 'del', text: a }, { type: 'ins', text: b }];
    }
    var n = A.length, m = B.length, W = m + 1;
    var dp = new Uint32Array((n + 1) * W), i, j;
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i * W + j] = A[i] === B[j]
          ? dp[(i + 1) * W + (j + 1)] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
      }
    }
    var out = [];
    function push(type, text) {
      var last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type: type, text: text });
    }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { push('del', A[i]); i++; }
      else { push('ins', B[j]); j++; }
    }
    while (i < n) { push('del', A[i]); i++; }
    while (j < m) { push('ins', B[j]); j++; }
    return out;
  }

  /* ------------------------------------------------------- convergence rule */

  // Convergence is not "this lens found nothing". A draft whose only fault is
  // hedges reported one clean clarity pass as the end of the loop, next to a
  // metrics strip reading HEDGES 5. A pass that finds nothing therefore has to
  // put the same unchanged text in front of every lens it has not run yet, and
  // the loop ends only when all of them are clean too.
  //
  // This is the only implementation of that question in the project. The page
  // used to carry a second one for its live and chunked paths, and the two
  // disagreed on exactly the runs that matter, so the decision is exported:
  // a caller passes the index of the next lens it would run and gets back both
  // the answer and the findings behind it — one entry per lens, in lens order —
  // so nothing has to be critiqued twice to act on it.
  //
  // opts.through (default: every lens) is the exclusive end of the range the
  // caller will actually cover. A run capped at one pass looks ahead at nothing,
  // because it has no second lens in its future that could still be dirty.
  // opts.before is passed through to critique().
  function tailClean(text, nextLensIndex, opts) {
    text = toText(text);
    var i = Math.floor(Number(nextLensIndex));
    if (!(i > 0)) i = 0;
    var through = (opts && typeof opts.through === 'number')
      ? Math.floor(opts.through) : LENSES.length;
    if (through > LENSES.length) through = LENSES.length;
    var results = [], clean = true, r;
    for (; i < through; i++) {
      r = critique(text, LENSES[i].id, opts);
      results.push({ lens: LENSES[i].id, findings: r.findings });
      if (r.findings.length > 0) clean = false;
    }
    return { clean: clean, results: results };
  }

  /* ------------------------------------------------------------- the verdict */

  // Three outcomes, three sentences, one place they are written. The page used
  // to phrase this itself and told the reader a run that had used all three of
  // its three passes had stopped early.
  //   converged   - a pass found nothing and so did every lens still to come
  //   cappedClean - that happened on the last pass the cap allowed, or the cap
  //                 was spent and the final draft turned out clean anyway
  function verdict(state) {
    var n = state && state.passesRun;
    n = (typeof n === 'number' && n > 0) ? Math.floor(n) : 0;
    if (n === 0) return 'The loop ran no passes, so the draft is unchanged.';
    var passes = n + (n === 1 ? ' pass' : ' passes');
    if (state.cappedClean) {
      return 'The loop ran its full ' + passes + ' and found nothing left to fix.';
    }
    if (state.converged) {
      return 'The loop stopped early after ' + passes +
        ': that pass found nothing, and neither did the lenses it still had to run.';
    }
    return 'The loop ran its full ' + passes + ' and still had findings outstanding.';
  }

  /* -------------------------------------------------------------------- run */

  // The loop, one pass at a time, so a caller can yield to the event loop
  // between passes and abort mid-run. Yields the same pass objects run() used to
  // build; returns { converged, stoppedAt, cappedClean, finalText, passCount }.
  // The lookahead is tailClean() — the same function the page calls — over the
  // lens range this run will actually cover, so a one-pass run is not told it
  // failed to converge by a lens it was never going to run. Its results are
  // cached: the next pass reads the same text, so it never critiques it twice.
  function* steps(text, opts) {
    text = toText(text);
    var maxPasses = (opts && typeof opts.maxPasses === 'number') ? opts.maxPasses : 3;
    if (!(maxPasses > 0)) maxPasses = 0;
    maxPasses = Math.min(Math.floor(maxPasses), LENSES.length);
    var copts = { before: beforeOf(opts), through: maxPasses };

    var current = text, converged = false, stoppedAt = null, cappedClean = false;
    var passCount = 0, i, j;
    // metrics() walks the whole text; the previous pass's "after" is this
    // pass's "before", so it is computed once per distinct draft, not twice.
    var mBefore = maxPasses > 0 ? metrics(current) : null;
    var cache = new Map(), cacheText = null;

    function look(t, lensId) {
      if (cacheText !== t) { cache.clear(); cacheText = t; }
      var hit = cache.get(lensId);
      if (!hit) { hit = critique(t, lensId, copts); cache.set(lensId, hit); }
      return hit;
    }
    function keep(t, entry) {
      if (cacheText !== t) { cache.clear(); cacheText = t; }
      if (!cache.has(entry.lens)) cache.set(entry.lens, { lens: entry.lens, findings: entry.findings });
    }

    for (i = 0; i < maxPasses; i++) {
      var lens = LENSES[i];
      var before = current;
      var res = look(before, lens.id);
      if (res.findings.length === 0) {
        var ahead = tailClean(before, i + 1, copts);
        for (j = 0; j < ahead.results.length; j++) keep(before, ahead.results[j]);
        yield {
          index: i, lens: lens.id, lensName: lens.name, findings: [],
          before: before, after: before, applied: 0,
          metricsBefore: mBefore, metricsAfter: mBefore
        };
        passCount++;
        if (ahead.clean) {
          converged = true;
          stoppedAt = i + 1;
          break;
        }
        continue; // a later lens still has work: this pass was not the end
      }
      var applied = applyFindings(before, res.findings);
      var mAfter = applied.text === before ? mBefore : metrics(applied.text);
      yield {
        index: i, lens: lens.id, lensName: lens.name, findings: res.findings,
        before: before, after: applied.text, applied: applied.applied,
        metricsBefore: mBefore, metricsAfter: mAfter
      };
      passCount++;
      current = applied.text;
      mBefore = mAfter;
    }
    // The cap is spent. "Is anything left to find" is then a question about the
    // draft, not about the schedule, so it is asked of the final text and of
    // every lens — the last pass rewrote the text, so no earlier answer covers
    // it, and a run capped below three lenses must not call a draft clean on
    // the strength of the one lens it happened to run.
    if (passCount > 0 && passCount >= maxPasses) {
      cappedClean = tailClean(current, 0, { before: copts.before }).clean;
    }
    return { converged: converged, stoppedAt: stoppedAt, cappedClean: cappedClean,
             finalText: current, passCount: passCount };
  }

  // Drains the generator. The page drives steps() directly, so the loop the
  // tests exercise here is the same loop the page ships.
  function run(text, opts) {
    var it = steps(text, opts), passes = [], step;
    while (!(step = it.next()).done) passes.push(step.value);
    return { passes: passes, converged: step.value.converged,
             stoppedAt: step.value.stoppedAt, cappedClean: step.value.cappedClean,
             finalText: step.value.finalText };
  }

  /* ----------------------------------------------------------------- export */

  global.CriticLoop = {
    LENSES: LENSES,
    critique: critique,
    applyFindings: applyFindings,
    metrics: metrics,
    diffWords: diffWords,
    steps: steps,
    run: run,
    tailClean: tailClean,
    verdict: verdict
  };
})(typeof window !== 'undefined' ? window : this);
