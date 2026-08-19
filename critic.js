/* critic.js — the offline critic engine for critic-loop.
 *
 * Pure logic. No DOM, no network, no timers, no Math.random, no Date, no
 * locale-sensitive comparison: the same input must produce byte-identical
 * output on every call, in every browser. tests.html drives this file directly.
 *
 * Shape: three lenses, each a list of rules. A rule scans text and returns
 * findings that quote an exact span and (usually) carry a replacement for it.
 * critique() merges a lens's rules into one sorted, non-overlapping list;
 * applyFindings() rewrites the text right-to-left so offsets stay valid;
 * run() walks lens 1..3 and stops early on a lens that finds nothing.
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

  function startsSentence(text, i) {
    var k = i;
    while (k > 0 && isSpace(text.charAt(k - 1))) k--;
    if (k === 0) return true;
    return TERMINATORS.indexOf(text.charAt(k - 1)) >= 0;
  }

  /* ------------------------------------------------------------- edit shape */

  function finding(text, rule, ruleName, start, end, why, replacement) {
    return {
      rule: rule,
      ruleName: ruleName,
      start: start,
      end: end,
      quote: text.slice(start, end),
      why: why,
      replacement: replacement === undefined ? null : replacement
    };
  }

  // Carries the capitalisation of the quote onto its replacement, so
  // "Leverage the cache" becomes "Use the cache" and not "use the cache".
  function matchCapital(quote, repl) {
    if (!repl) return repl;
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
  function deletionEdit(text, s, e) {
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

    var replacement = '';
    if (startsSentence(text, start)) {
      var k = end;
      while (k < n && isSpace(text.charAt(k))) k++;
      if (k < n) {
        var c = text.charAt(k), up = c.toUpperCase();
        if (up !== c) { replacement = text.slice(end, k) + up; end = k + 1; }
      }
    }
    return { start: start, end: end, replacement: replacement };
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

  // Buzzwords with a plain synonym. 46 entries, whole words only.
  var JARGON = buildDict([
    ['leverage', 'use'], ['leverages', 'uses'], ['leveraging', 'using'], ['leveraged', 'used'],
    ['utilise', 'use'], ['utilize', 'use'], ['utilises', 'uses'], ['utilizes', 'uses'],
    ['utilising', 'using'], ['utilizing', 'using'],
    ['facilitate', 'help'], ['facilitates', 'helps'], ['facilitating', 'helping'],
    ['robust', 'solid'], ['paradigm', 'model'], ['synergy', 'overlap'], ['synergies', 'overlaps'],
    ['holistic', 'whole'], ['seamless', 'smooth'], ['seamlessly', 'smoothly'],
    ['scalable', 'able to grow'], ['actionable', 'usable'], ['impactful', 'effective'],
    ['granular', 'detailed'], ['learnings', 'lessons'], ['optics', 'appearance'],
    ['bandwidth', 'time'], ['ecosystem', 'set of tools'], ['stakeholders', 'the people affected'],
    ['stakeholder', 'the person affected'], ['onboarding', 'setup'], ['ideate', 'think'],
    ['operationalise', 'run'], ['operationalize', 'run'], ['incentivise', 'reward'],
    ['incentivize', 'reward'], ['disrupt', 'upend'], ['disruptive', 'upending'],
    ['mission-critical', 'essential'], ['state-of-the-art', 'newest'], ['cutting-edge', 'newest'],
    ['best-in-class', 'best'], ['world-class', 'excellent'], ['turnkey', 'ready to run'],
    ['going forward', 'from now on'], ['at the end of the day', 'in the end'],
    ['low-hanging fruit', 'the easy wins'], ['best practice', 'the usual method'],
    ['core competency', 'main skill'], ['value-add', 'benefit'], ['deep dive', 'close look'],
    ['circle back', 'come back to it'], ['touch base', 'talk'], ['thought leadership', 'opinions'],
    ['game changer', 'big change'], ['game-changer', 'big change'], ['win-win', 'good for both'],
    ['move the needle', 'make a difference'], ['boil the ocean', 'do everything at once']
  ]);

  var CLAUSE_MARKERS = ['which', 'that', 'who', 'where', 'while', 'although', 'because'];
  var CLAUSE_SET = new Set(CLAUSE_MARKERS);

  var LONG_SENTENCE_WORDS = 28;
  var SPLIT_MIN_SIDE = 8;
  // Joints safe enough to turn into a full stop. No nesting, disjoint classes:
  // linear on any input.
  var JOINT_RE = /,[ \t]+(?:and|but)[ \t]+|;[ \t]+/g;

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

  // "by the way", "by design" and friends are not agents.
  var BY_NON_AGENT = new Set(['way', 'now', 'then', 'default', 'hand', 'design', 'contrast',
    'comparison', 'accident', 'mistake', 'chance', 'itself', 'himself', 'herself', 'themselves',
    'ourselves', 'necessity', 'definition', 'far', 'means', 'virtue', 'reference']);

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

  function ruleLongSentence(text, ctx) {
    var out = [], sents = ctx.sentences, i;
    for (i = 0; i < sents.length; i++) {
      var sn = sents[i];
      if (sn.words <= LONG_SENTENCE_WORDS) continue;
      var joint = bestJoint(text, ctx.tokens, sn);
      if (joint) {
        out.push(finding(text, 'long-sentence', 'Long sentence', joint.start, joint.end,
          'The sentence around this joint runs ' + sn.words + ' words; the lens flags over ' +
          LONG_SENTENCE_WORDS + ', and this joint splits it into two.',
          joint.replacement));
      } else {
        out.push(finding(text, 'long-sentence', 'Long sentence', sn.start, sn.end,
          'This sentence runs ' + sn.words + ' words; the lens flags over ' +
          LONG_SENTENCE_WORDS + ', and there is no joint that leaves ' + SPLIT_MIN_SIDE +
          ' words on each side.', null));
      }
    }
    return out;
  }

  // The most balanced ", and " / ", but " / "; " that leaves at least 8 words on
  // each side. Balanced rather than first, so a trailing aside is not the split.
  function bestJoint(text, tokens, sn) {
    var body = sn.text, m, best = null, bestScore = -1;
    JOINT_RE.lastIndex = 0;
    while ((m = JOINT_RE.exec(body)) !== null) {
      var abs = sn.start + m.index;
      var after = sn.start + m.index + m[0].length;
      if (after >= sn.end) continue;
      var before = 0, k;
      for (k = sn.from; k < sn.to; k++) { if (tokens[k].s < abs) before++; else break; }
      var afterWords = 0;
      for (k = sn.from; k < sn.to; k++) { if (tokens[k].s >= after) afterWords++; }
      if (before < SPLIT_MIN_SIDE || afterWords < SPLIT_MIN_SIDE) continue;
      var score = Math.min(before, afterWords);
      if (score > bestScore) {
        bestScore = score;
        var c = text.charAt(after);
        best = {
          start: abs,
          end: after + 1,
          replacement: '. ' + c.toUpperCase()
        };
      }
    }
    return best;
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
      if (hits.length < 3) continue;
      // Span the evidence, not the whole sentence: word-level findings before
      // the first marker still survive the overlap filter.
      var a = hits[0].s, b = hits[hits.length - 1].e;
      out.push(finding(text, 'clause-stack', 'Stacked clauses', a, b,
        'This sentence hangs ' + hits.length + ' subordinate clauses off each other (' +
        seen.join(', ') + '), so the main claim is buried.', null));
    }
    return out;
  }

  function ruleNominalisation(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, NOMINALISATIONS, function (i, j, key, value) {
      var t = ctx.tokens[i];
      value = trimLeadingArticle(text, ctx.tokens, i, value);
      out.push(finding(text, 'nominalisation', 'Nominalisation', t.s, ctx.tokens[j].e,
        q(t.w) + ' packs the verb ' + q(value) + ' into a noun.',
        matchCapital(t.w, value)));
    });
    return out;
  }

  function ruleJargon(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, JARGON, function (i, j, key, value) {
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
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
      var edit = deletionEdit(text, a, b);
      out.push(finding(text, 'hedge', 'Hedge', edit.start, edit.end,
        q(quote) + ' softens the claim without changing what it says.',
        edit.replacement));
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
      if (!isGapBlank(text, a.e, b.s)) continue;
      var edit = deletionEdit(text, a.s, a.e);
      out.push(finding(text, 'adverb-prop', 'Adverb propping a weak verb', edit.start, edit.end,
        q(a.w) + ' props up the weak verb ' + q(b.w) + ' instead of a verb that carries the claim.',
        edit.replacement));
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
        var edit = deletionEdit(text, a, b);
        out.push(finding(text, 'filler-phrase', 'Filler phrase', edit.start, edit.end,
          q(quote) + ' spends ' + words(key) + ' words and adds nothing the sentence needs.',
          edit.replacement));
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

  function ruleVeryIntensifier(text, ctx) {
    var out = [];
    scanDict(text, ctx.tokens, INTENSIFIERS, function (i, j) {
      var nextTok = ctx.tokens[j + 1];
      if (!nextTok || !isGapBlank(text, ctx.tokens[j].e, nextTok.s)) return;
      if (!looksAdjectival(nextTok.lw)) return;
      var a = ctx.tokens[i].s, b = ctx.tokens[j].e, quote = text.slice(a, b);
      var edit = deletionEdit(text, a, b);
      out.push(finding(text, 'very-intensifier', 'Empty intensifier', edit.start, edit.end,
        q(quote) + ' before ' + q(nextTok.w) + ' adds emphasis, not information.',
        edit.replacement));
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
        var t = tokens[list[k]];
        out.push(finding(text, 'repetition', 'Repeated word', t.s, t.e,
          q(t.w) + ' appears ' + count + ' times inside ' + REPETITION_WINDOW +
          ' words; vary it or cut the sentences that repeat it.', null));
        return; // one finding per word, at its first qualifying occurrence
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

  function critique(text, lensId) {
    text = toText(text);
    var rules = LENS_RULES.get(lensId);
    if (!rules) throw new Error('critic-loop: unknown lens "' + lensId + '"');

    var tokens = tokenize(text);
    var ctx = { tokens: tokens, sentences: sentencesWithTokens(text, tokens) };

    var raw = [], r, i, produced, k;
    for (r = 0; r < rules.length; r++) {
      produced = rules[r](text, ctx);
      for (k = 0; k < produced.length; k++) {
        produced[k]._order = r;
        raw.push(produced[k]);
      }
    }

    // Sort: earliest start wins, then the longer span, then the rule that comes
    // first in this lens's list. Then sweep left to right keeping only findings
    // that start at or after the end of the last one kept — the guarantee that
    // applyFindings can rewrite right-to-left without offsets colliding.
    raw.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      var la = a.end - a.start, lb = b.end - b.start;
      if (la !== lb) return lb - la;
      if (a._order !== b._order) return a._order - b._order;
      return a.rule < b.rule ? -1 : (a.rule > b.rule ? 1 : 0);
    });

    var findings = [], lastEnd = -1;
    for (i = 0; i < raw.length; i++) {
      if (raw[i].start < lastEnd) continue;
      if (raw[i].end <= raw[i].start && raw[i].replacement === null) continue; // empty pointer
      delete raw[i]._order;
      findings.push(raw[i]);
      lastEnd = raw[i].end;
    }
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

  function metrics(text) {
    text = toText(text);
    var wordCount = 0, m;
    NONSPACE_RE.lastIndex = 0;
    while ((m = NONSPACE_RE.exec(text)) !== null) {
      if (HAS_ALNUM_RE.test(m[0])) wordCount++;
    }
    // Sentence count = terminator runs that close a sentence, plus one for a
    // trailing unterminated fragment. Empty or whitespace-only text is 0.
    var sentenceCount = splitSentences(text).length;
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

  /* -------------------------------------------------------------------- run */

  function run(text, opts) {
    text = toText(text);
    var maxPasses = (opts && typeof opts.maxPasses === 'number') ? opts.maxPasses : 3;
    if (!(maxPasses > 0)) maxPasses = 0;
    maxPasses = Math.min(Math.floor(maxPasses), LENSES.length);

    var passes = [], current = text, converged = false, stoppedAt = null, i;
    // metrics() walks the whole text; the previous pass's "after" is this
    // pass's "before", so it is computed once per distinct draft, not twice.
    var mBefore = maxPasses > 0 ? metrics(current) : null;
    for (i = 0; i < maxPasses; i++) {
      var lens = LENSES[i];
      var before = current;
      var res = critique(before, lens.id);
      if (res.findings.length === 0) {
        passes.push({
          index: i, lens: lens.id, lensName: lens.name, findings: [],
          before: before, after: before, applied: 0,
          metricsBefore: mBefore, metricsAfter: mBefore
        });
        converged = true;
        stoppedAt = i + 1;
        break;
      }
      var applied = applyFindings(before, res.findings);
      var mAfter = applied.text === before ? mBefore : metrics(applied.text);
      passes.push({
        index: i, lens: lens.id, lensName: lens.name, findings: res.findings,
        before: before, after: applied.text, applied: applied.applied,
        metricsBefore: mBefore, metricsAfter: mAfter
      });
      current = applied.text;
      mBefore = mAfter;
    }
    return { passes: passes, converged: converged, stoppedAt: stoppedAt, finalText: current };
  }

  /* ----------------------------------------------------------------- export */

  global.CriticLoop = {
    LENSES: LENSES,
    critique: critique,
    applyFindings: applyFindings,
    metrics: metrics,
    diffWords: diffWords,
    run: run
  };
})(typeof window !== 'undefined' ? window : this);
