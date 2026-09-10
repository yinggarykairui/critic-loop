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
             case that must not. It also loads app.js, for the one page function whose
             behaviour the engine's output depends on — splitChunks — because a copy of a
             function in a test proves only the copy.
```

The engine is separated from the page precisely so `tests.html` can drive it without a DOM, and
so live mode is a swap of one async function rather than a second code path through the UI. app.js
exposes `window.CriticLoopPage.splitChunks` for the suite and nothing else, and its wiring stands
down when there is no page around it.

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
- [x] F9 `tests.html`: group C12 kills all ten page-side mutants. 1,405 → 1,458.

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
  that case as it is rather than pretending otherwise.
- `verdict()`'s cap sentence now has two shapes, so "four outcomes, four sentences" is no longer
  the whole truth about it — four outcomes, five sentences, and the README says so.
