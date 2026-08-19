# critic-loop

Paste a paragraph and watch an agent critique its own draft, three passes deep, with the critique
shown between every draft — the part a diagram of this pattern always leaves out.

![screenshot](screenshot.png)

**[Live demo](https://yinggarykairui.github.io/critic-loop/)**

## What it does

The page runs the draft → critique → revise loop and renders every intermediate state: draft 0,
critique 1, draft 1, critique 2, draft 2, critique 3, draft 3. Each finding names its rule, quotes
the exact span it is about, says in one sentence what is wrong, and either shows the replacement it
proposes or marks itself a pointer the loop will not auto-apply. Six of the twelve rules only point:
where a rewrite would change the meaning or the grammar, the critic says so instead of guessing.
Each draft carries a metrics strip — words, sentences, mean sentence length, hedges — with the delta
from the draft before it, and a word-level diff you can toggle against the clean text.

The default engine is a deterministic rule-based critic that runs in the page: twelve rules across
three lenses — clarity, then concreteness, then economy, one per pass. No model, no network, no key.
The same paragraph produces the same critique every time. **The loop stops early when the text is
clean under every lens it has not yet run**, and the page says `Converged after N passes`. The
bundled "already clean" sample converges on pass 1 — that early stop is the one behaviour of this
pattern a static diagram cannot show.

Live mode swaps in a real model if you paste an Anthropic API key: the same three lenses become
system prompts and the findings flow through the same render path, quotes located in the draft the
same way. The key is read from the field on each run, sent only to `api.anthropic.com`, stored
nowhere, and never written into the exported transcript.

`tests.html` is the engine's own suite: 567 assertions, run it by opening the file.

Limits worth knowing, all of which the page states while they apply. The rules are English-only, and
the page cannot detect that for you: a paragraph in another language gets whatever the rules happen
to match, which is usually little or nothing. Text over 6,000 characters is critiqued in chunks, so a
finding never spans a chunk boundary and a few long sentences that straddle one go unflagged.
Transcript panels show the first 6,000 characters of a draft and the first 60 findings of a pass;
copy, export and the revision itself always use everything, and the true counts are always shown. The
word diff is skipped above 12,000 combined characters. Live mode has been exercised against a mocked
transport — every error path, the lenient JSON parse, abort — but never against a real key, because
this project holds none.

## How to run

Open `index.html` in a browser. There is no build step, no dependency, and no server.

Open `tests.html` the same way to run the engine's test suite.

## Why it exists

Seeded idea [#21](https://github.com/yinggarykairui/factory-hub/issues/21) in the factory's queue: a
portfolio-safe demo of the orchestration pattern everyone names and few show working.

---

*Day 026 of an autonomous build factory — [factory-hub](https://github.com/yinggarykairui/factory-hub)*
