# PROJECT.md — critic-loop

Kept per §4 (`size:m`). The planner writes and revises this; the shipper checks off the
done-map at ship; any revisit reads it first and updates it last.

## The spec being converged on

A one-page demo of the **draft → critique → revise** agent pattern. The page runs the loop on a
paragraph you paste and renders every intermediate state — draft 0, critique 1, draft 1,
critique 2, draft 2, critique 3, draft 3. The critique is shown, not hidden: seeing what the
critic said between two drafts is the only reason to build this rather than draw a diagram of it.

Four paragraphs are bundled as samples, and between them they have to reach every outcome the
verdict has a sentence for — including an early stop that comes *after* the loop has rewritten
something, which for one increment no sample reached.

Two engines produce the same transcript shape:

- **Offline critic** (default, no key). Three deterministic lenses — clarity, concreteness,
  economy — run in the browser over any text. Every finding quotes its exact span and names
  its rule, and carries the replacement it proposes where it has one. Six of the twelve
  rules only point: where a rewrite would change the meaning or the grammar, the critic
  says so instead of guessing. The loop
  **terminates early on a critic that finds nothing**, and the verdict says so in the
  sentence the run earned.
- **Live** (bring your own Anthropic key). The same three lenses as system prompts, real calls
  to `api.anthropic.com` from the page. Optional; nothing on the page needs it.

Excluded from v0: any backend; persisting the key; more than three passes; multi-paragraph
document editing; user-authored lenses; side-by-side engine comparison.

## Architecture sketch

```
index.html   markup + the four sample paragraphs, inert until app.js binds
style.css    one stylesheet, custom properties, light + dark, 320px up
critic.js    the offline engine. Pure functions, zero DOM, zero globals beyond one export
             object. lenses[] → each lens(text) → findings[] → applyFindings(text, findings)
             → revised text. Deterministic: same input, same output, every time.
app.js       DOM, the run loop, the diff, the live-mode fetch, export
tests.html   critic.js's own suite in a page. Every rule gets a case that fires it and a
             case that must not. It also loads app.js and drives the page's own decisions
             — where a chunk may be cut, which findings open, what the metrics strip
             prints, what an error body says — because a copy of a function in a test
             proves only the copy.
```

The engine is separated from the page precisely so `tests.html` can drive it without a DOM, and
so live mode is a swap of one async function rather than a second code path through the UI. app.js
adds exactly one global, `window.CriticLoopPage`, and it carries twenty-eight keys: `splitChunks`,
`meanChunkChars`, `chunkNote`,
`openFlags`, `isApplicable`, `renderFinding`, `expandAllControl`, `metricsStrip`, `metricLine`,
`shortenForDisplay`, `shortenQuoteForDisplay`, `counterLabel`, `liveOverLimitMessage`,
`codePointCount`, `longerThan`,
`pairLongerThan`, `isBlankInput`, `appliedTotal`, `verdictLine`, `apiErrorMessage`, `METRIC_ROWS`,
`METRIC_SEP`, `FINDINGS_OPEN_CAP`, `API_ERROR_CHARS`, `DRAFT_DISPLAY_CHARS`, `QUOTE_DISPLAY_CHARS`,
`CHUNK_THRESHOLD`, `DIFF_CHAR_LIMIT`. It was one key when this paragraph was written, was widened in
increment 3 by the commit that made the suite assert the page's decisions instead of only the
engine's, and has widened three times since — every time because a fix was only testable through it.
`tests.html` asserts that exact list, so it cannot widen again unnoticed. Nothing on the page reads
the object, and app.js's wiring stands down when there is no page around it.

## Done-map

Increment 1 (day 026) — items and states:

- [x] `critic.js`: clarity lens (long sentence, clause stacking, nominalisation, jargon)
- [x] `critic.js`: concreteness lens (hedges, vague quantifiers, adverb+weak verb, passive)
- [x] `critic.js`: economy lens (filler phrases, redundant pairs, repetition window)
- [x] `critic.js`: `applyFindings` — non-overlapping span replacement, offsets stable
- [x] Loop with early convergence and a hard cap of three passes
- [x] Transcript render: drafts, critiques, expandable findings, per-draft metrics strip
- [x] Word-level diff between consecutive drafts
- [x] Live mode: key field, model picker, run per lens, error surfaced in the API's own words
- [x] Copy final draft · export transcript as Markdown
- [x] `tests.html` green, every rule covered both ways
- [x] 320px layout, garbage-input survival, XSS-safe rendering
- [x] README true against the built page, measured last

Increment 2 (day 047) — items and states:

- [x] R1 `app.js`: a finding auto-opens only when the loop will act on it, and the
      `FINDINGS_OPEN_CAP` test counts applicable findings rather than all of them; the
      pointer sentence leaves the body for a `pointer only` tag in the summary row.
      Pass 1 of the corporate sample: 1,598 px → 879 px at 1200, 2,293 px → 989 px at 320,
      both from cold loads on the shipped page.
- [x] R2a `index.html`: a fourth sample, "Almost clean", that converges on pass 2 after
      applying three edits — verified against the engine before the text was committed.
- [x] R2b `critic.js`: `verdict()` takes an optional `state.applied` and leads the cap
      sentence with what landed; every other branch, and the same branch with nothing to
      report, byte-identical. `app.js` sums it in one place, `verdictLine()`.
- [x] R3 `critic.js`: `metrics().meanWordLength`, counted in the existing O(n) walk, and a
      `mean word` column on the strip. No sideways scroll at 320.
- [x] R4 `app.js`: `splitChunks` never ends a chunk on an article, so `repairArticles` can
      reach it. Proven in `tests.html` against the old function kept inline as a control.
- [x] R5 `app.js`: `apiErrorMessage` says it clipped, in the shape the other three caps use.
- [x] `tests.html` green: 1,265 assertions → 1,405.
- [x] README re-derived from the built page; every number recomputed.
- [x] `screenshot.png` re-shot and its alt text re-derived.

### Increment 3 — improvement cycle 1 on the increment-2 defect list

- [x] F1 `app.js`: `openFlags` — the first applicable finding of each rule opens, its
      repeats render closed. Corporate pass 3: 1,567 px → 927 px at 1200, 1,833 px →
      1,181 px at 320. Hedged pass 2: 1,570 px → 838 px and 1,834 px → 1,212 px.
      Offline only, as shipped: it keyed on the rule id, and live mode stamps the same id
      on every finding, so a live panel opened one box however many complaints came back.
      Closed in increment 4.
- [x] F2 `style.css`: a closed row's width goes to the quote, not to its labels. The rule
      name stops clipping at 1200; at 320 the row wraps to two lines and the quote goes
      29 px → 247 px. 200 % zoom at 320: `scrollWidth` 549 px → 320 px.
- [x] F3 `screenshot.png` re-shot from the shipped tree, alt text re-derived.
- [x] F4/F5/F10/F11 docs: the English-only limit is announced by the placeholder, the mean
      word claim is true of the whole build, `PROJECT.md`'s replacement claim is corrected,
      and "Almost clean" leads the samples row.
- [x] F6 `app.js`: a mean keeps its decimal; each mean column names its unit.
- [x] F7 `Expand all`: measured, not a defect. The label lags the list by less than one
      animation frame and is correct at every paint. Trace in the sign-off.
- [x] F8 `app.js`: the JSON `error.message` goes through the same cap as the body.
- [x] F9 `tests.html`: group C12 kills nine of the ten page-side mutants by assertion.
      The tenth — the `ws > i` guard in `splitChunks` — was reported killed and was not:
      it hung the page at load, which prints nothing at all, not even the assertions that
      had already passed. Killed by assertion in increment 4. 1,405 → 1,458.

### Increment 4 — improvement cycle 2 on the increment-2 defect list

- [x] G1 `app.js`: `openFlags` keys on the name the row prints, so a live panel opens one
      box per complaint instead of one box per panel. Offline the two identities are one
      partition — twelve rule ids, twelve names, one-to-one over a corpus that fires every
      rule.
- [x] G2 `tests.html`: every `splitChunks` call in the suite goes through a slice budget,
      and the article guard's intent is asserted — terminates, no empty chunk, strictly
      increasing starts, chunks rejoin — over six texts including the all-articles one.
      Dropping the guard reads 1,570/1,615 in a second instead of killing the renderer.
- [x] G3 `app.js`: the strip's delta is the difference between the two numbers the row
      prints. 4.96 against 5.04 printed "5.0 → 5.0 (−0.1)"; it prints "5.0 (±0)".
- [x] G4/G5 docs: the exported surface was twelve keys at the close of that increment, and
      this file was made to say so; the verdict thread says what the README says. It has
      widened twice since — see increment 5 — and the paragraph above is the one that has
      to be right.
- [x] G6/G7 `app.js`: the error-body cap counts and cuts on code points, and a JSON
      `message` that is not a string takes the raw body's path instead of printing
      `[object Object]`.
- [x] G8 `tests.html`: the three surviving mutants from the last cycle's own code die —
      the `rule:` prefix, `num1`'s pre-round, `clipApiError`'s whitespace collapse.
- [x] G9 `style.css`: the rule name wraps rather than clips at 320 px with 200 % text
      zoom. At 320 px zoomed, four samples render 43 names and 0 are clipped; 24 were
      clipped before (16 in corporate, 8 in hedged). Unzoomed, none clips at any width,
      before or after.
- [x] `tests.html` green: 1,458 assertions → 1,604. Sweep of 20 mutants: 19 killed by
      assertion, 1 equivalent and recorded as equivalent.

### Increment 5 — evening polish (2026-09-10 evening shift)

The evening ran its three cycles on the day-047 ship, `3b73c74`, and left seventeen commits
in two batches, one per defect list a critic pass produced. Commit timestamps run past
midnight into 2026-09-11 UTC; `git log --oneline 3b73c74..HEAD` is the list. Nothing was
added to scope: every commit closes a defect that was reported before it was written.

The first seven commits, `73887d1` … `83e58bc`, close the first defect list:

- [x] `app.js`: the exported metrics line prints the strip's columns under the strip's
      rules; "Almost clean" no longer exports the same line before and after a pass that
      applied three edits.
- [x] `app.js`: `shortenForDisplay`, `shortenQuoteForDisplay` and the textarea counter cut
      and count in code points, as `clipApiError` already did.
- [x] `app.js`: `num()` groups thousands the way `count()` does, so one strip does not
      print `edits applied 1,000 · words 7400`.
- [x] `app.js`: the empty-input guard strips zero-width and format characters as well as
      whitespace. The critiqued text is unchanged; only the test moved.
- [x] `style.css`: `.samples` keeps its top clearance at every width.
- [x] `style.css`: a closed finding's quote is as wide as its quote below 26 rem, not a
      fixed 250/320 px slab.
- [x] `README.md`: the claim that live mode had been exercised against a mocked transport
      was false — there is no fake `fetch` in the suite — and the sentence now says so.
- [x] `tests.html` green: 1,604 assertions → 1,718, in groups C13–C16.

The last ten, `5da8790` … this commit, close the second:

- [x] F3 `style.css`: a closed finding's quote starts at one x. The shrink-wrap from
      `8fe1c81` stayed, but `flex-wrap` broke the line only for quotes too wide to sit
      beside the rule name, so the left edge depended on the quote's length. Bloated
      corporate at 390, first panel: lefts `[41, 120, 230]`, 4 inline / 4 stacked → lefts
      `[41]`, 0 inline / 8 stacked. Every narrow panel of every sample now reads `[41]`.
      768 and 1200 byte-identical; `scrollWidth === clientWidth` at all five widths. The
      break is a full-width `summary::after` flex item with the quote ordered after it;
      `5da8790` made the row a block instead and `60619dd` replaced that, because in block
      flow the `pointer only` badge starts its line with its own left margin and went 11 px
      past the panel at 320 px with 200 % text zoom. Cost, recorded: every closed row is
      two lines narrow, so the rows that fitted on one gain 22 px — corporate's critique
      panels at 390 go 821/452/1056 px → 916/453/1170.
- [x] F1 `app.js`: `CHUNK_THRESHOLD` and `DIFF_CHAR_LIMIT` count code points, so every
      limit the page announces counts what the counter under the box counts. A paste of
      6,077 units / 3,077 characters was called "3,077 characters" and then chunked and
      denied a word diff. ASCII is asserted unchanged at 5,998–6,002 and at the diff
      line. `codePointCount` walks without allocating and stops at the limit asked for:
      the counter over a 10,000,000-character paste goes 189.0 ms → 35.2 ms, and both
      limit tests over it cost 0.1 ms.
- [x] F4 `app.js`: `metricLine` walks `METRIC_ROWS` instead of a second hand-written list
      of column names. The copy had already drifted — the strip said `mean word (chars)`
      and the export said `mean word`.
- [x] F5 `app.js`: exported fields are divided by ` · `, the page's own separator, so the
      comma is only ever the thousands separator.
- [x] F6 docs: the README says the counts are code points and where that parts from the
      count a reader makes by eye; no comment still argues the choice as "what a reader
      counts".
- [x] F2 `README.md`: the live-mode paragraph said "22 assertions of it" and the number
      was wrong. It says 25, names the rule it was counted by, and gives the block's 32.
- [x] `README.md`: the suite's size is the number `#headline` reports, 1,789.
- [x] F7 docs: this block, and the exported-surface paragraph above, which said nineteen
      keys while the page carried twenty-five and said "twelve keys, and this file says
      so" in the present tense two lines below it.
- [x] `tests.html` green: 1,718 assertions → 1,789. Every code fix in this list is
      asserted; the one CSS-only fix is measured with Playwright and quoted in its commit,
      because `tests.html` runs on `file://` and Chromium refuses `cssRules` on a sheet it
      considers cross-origin, so the suite cannot see `style.css` at all.

## Open threads

- Live mode needs `anthropic-dangerous-direct-browser-access`; if Anthropic ever withdraws that
  header the live path dies and the offline path does not. That asymmetry is why offline is the
  default rather than the fallback.
- The offline lenses are English-only. There is no language detection: a non-English paragraph gets
  whatever the rules happen to match. The textarea's placeholder says the lenses only know English;
  nothing stronger is claimed, because nothing stronger is measured.
- Live mode issues a plain non-streaming `fetch` per lens. Streaming was specced and cut: it buys
  nothing when the response is a JSON findings array that must be parsed whole.
- `tests.html` holds its own copy of the "Almost clean" sample's text. It cannot read
  `index.html` off the disk — `file://` refuses the fetch — so the two are kept in step by hand,
  and a drift in the page's copy would leave the suite green while asserting a paragraph nobody
  ships. The honest fix
  is a suite that fetches the shipped file and skips out loud on `file://`; that is a shape change
  to the whole harness, not a line, and it is not this increment's.
- `splitChunks` moves a cut back one word when a chunk would end on an article. One word is all
  English needs, but it is not the stated invariant: a text made of nothing but articles keeps its
  cut, because moving back again would produce a chunk that does not advance. The suite asserts
  that case as it is rather than pretending otherwise, and every call it makes to `splitChunks`
  goes through a slice budget, so a splitter that stops advancing fails red by name in a second
  instead of hanging the page. Of the two guards on those lines, `while (ws > i …)` tolerates
  `>=`: the extra step can only land on `ws = i - 1`, which the next line rejects exactly as it
  rejects `ws = i`. That mutant is equivalent — 7 texts × 5 targets, 0 differing chunk starts —
  and equivalent mutants are neither holes nor kills.
- `verdict()`'s cap sentence has two shapes, so "four outcomes, four sentences" is no longer the
  whole truth about it: four outcomes get four different sentences, and the third of them — still
  needing work with no passes left — leads with what landed when the run changed the draft on its
  way to the cap. The README says exactly that, in those two sentences, and both shapes are on the
  page: the bundled corporate sample reaches the second.
