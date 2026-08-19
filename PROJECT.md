# PROJECT.md — critic-loop

Kept per §4 (`size:m`). The planner writes and revises this; the shipper checks off the
done-map at ship; any revisit reads it first and updates it last.

## The spec being converged on

A one-page demo of the **draft → critique → revise** agent pattern. The page runs the loop on a
paragraph you paste and renders every intermediate state — draft 0, critique 1, draft 1,
critique 2, draft 2, critique 3, draft 3. The critique is shown, not hidden: seeing what the
critic said between two drafts is the only reason to build this rather than draw a diagram of it.

Two engines produce the same transcript shape:

- **Offline critic** (default, no key). Three deterministic lenses — clarity, concreteness,
  economy — run in the browser over any text. Every finding quotes its exact span, names its
  rule, and carries the replacement it proposes. The loop **terminates early on a critic that
  finds nothing** (`converged after N passes`).
- **Live** (bring your own Anthropic key). The same three lenses as system prompts, real calls
  to `api.anthropic.com` from the page. Optional; nothing on the page needs it.

Excluded from v0: any backend; persisting the key; more than three passes; multi-paragraph
document editing; user-authored lenses; side-by-side engine comparison.

## Architecture sketch

```
index.html   markup + the three sample paragraphs, inert until app.js binds
style.css    one stylesheet, custom properties, light + dark, 320px up
critic.js    the offline engine. Pure functions, zero DOM, zero globals beyond one export
             object. lenses[] → each lens(text) → findings[] → applyFindings(text, findings)
             → revised text. Deterministic: same input, same output, every time.
app.js       DOM, the run loop, the diff, the live-mode fetch, export
tests.html   critic.js's own suite in a page. Every rule gets a case that fires it and a
             case that must not.
```

The engine is separated from the page precisely so `tests.html` can drive it without a DOM, and
so live mode is a swap of one async function rather than a second code path through the UI.

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

## Open threads

- Live mode needs `anthropic-dangerous-direct-browser-access`; if Anthropic ever withdraws that
  header the live path dies and the offline path does not. That asymmetry is why offline is the
  default rather than the fallback.
- The offline lenses are English-only. There is no language detection: a non-English paragraph gets
  whatever the rules happen to match. The textarea's placeholder says the lenses only know English;
  nothing stronger is claimed, because nothing stronger is measured.
- Live mode issues a plain non-streaming `fetch` per lens. Streaming was specced and cut: it buys
  nothing when the response is a JSON findings array that must be parsed whole.
