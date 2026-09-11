# critic-loop

Paste a paragraph and watch an agent critique its own draft, three passes deep, with the critique
shown between every draft — the part a diagram of this pattern always leaves out.

![Draft 0 with its metrics strip — 43 words, mean sentence (words) 21.5, mean word (chars) 5.0 — then pass 1's clarity critique: five findings, the first jargon one open with its why-line and its replacement, the other four closed to a row each, three of those tagged pointer only. Then draft 1 with the word diff and its own strip, and the head of pass 2](screenshot.png)

**[Live demo](https://yinggarykairui.github.io/critic-loop/)**

## What it does

The page runs the draft → critique → revise loop and renders every intermediate state: draft 0,
critique 1, draft 1, critique 2, draft 2, critique 3, draft 3. Each finding names its rule, quotes
the span it is about — elided at a word boundary above 400 characters, with a note saying how much
of the span is on screen and how long the span really is — says in one sentence what is wrong, and either shows the replacement it proposes or
carries a `pointer only` tag in its own row. Six of the twelve rules only point: where a rewrite
would change the meaning or the grammar, the critic says so instead of guessing. A panel opens one
worked example per rule — the first finding the loop will act on, with its why and its replacement
showing — and every repeat of that rule is one closed row, as is every pointer. Above ten
distinct rules in one pass the panel opens nothing at all, on the reasoning that ten worked
examples is a wall rather than an example; `Expand all` still reaches every finding. Offline
no lens holds more than four rules, so that cap is a live-mode shape. Each draft carries
a metrics strip — edits applied, words, sentences, mean sentence (words) when a draft has more than
one sentence, mean word (chars), and hedges — with the delta from the draft before it, and a
word-level diff you can toggle against the clean text. Mean word is the column a clarity pass moves
without moving the word count: a jargon swap trades one word for one word, usually a shorter one —
on "Almost clean" draft 0 to draft 1 goes 4.4 → 4.2. It is not a score. An economy pass deletes
filler, which is made of short words, and leaves the long ones behind: "Bloated corporate" ends at
4.7 → 4.9 across its three passes.

The default engine is a deterministic rule-based critic that runs in the page: twelve rules across
three lenses — clarity, then concreteness, then economy, one per pass. No model, no network, no key.
The same paragraph produces the same critique every time. **The loop stops early when a pass finds
nothing and every lens it has not yet run also finds nothing** — the bundled "already clean" sample
does this on pass 1, and the page ends on the sentence *"The draft came out clean after 1 pass, with
2 passes to spare."* "Almost clean", the sample the page offers first, does it on pass 2 after
applying three edits, which is the same stop reached after real work. Four outcomes get four
different sentences: clean with passes to spare, clean on the last pass, still needing work with
no passes left, and — live mode only — no reply the page could read as edits. The third has a
second shape: a run that changed the draft on its way to the cap leads with what landed,
*"14 edits landed. The draft still needs work after 3 passes, and there are no passes left."*
The status line, the result panel and the exported transcript always print the same one. That
early stop is the behaviour a static diagram of this pattern cannot show.

Live mode swaps in a real model if you paste an Anthropic API key: the same three lenses become
system prompts and the findings flow through the same render path, quotes located in the draft the
same way. The key is read from the field on each run, sent only to `api.anthropic.com`, stored
nowhere, and never written into the exported transcript.

`tests.html` is the suite: 1,718 assertions, run it by opening the file. Most of them are the
engine's. The rest drive the page's own decisions out of `app.js` rather than a copy of them — which
findings a panel opens, what the pointer tag says, where a chunk may be cut, what the metrics strip
prints, what the error-body cap does at 299, 300 and 301 characters — because a copy of a function
in a test only ever proves the copy.
The chunk splitter keeps its old version beside it as a control that has to fail.

Limits worth knowing. Four of these the page announces at the moment they apply: text over 6,000
characters is critiqued in chunks, so a finding never spans a chunk boundary and a few long sentences
that straddle one go unflagged; transcript panels show the first 6,000 characters of a draft and the
first 60 findings of a pass, while copy, export and the revision itself always use everything and the
true counts are always printed; the word diff is skipped above 12,000 combined characters; and a
counting rule is reported once per draft rather than once per chunk. Every "characters" on this page
— those limits, the counter under the box, the 300-character error-body cap — is a count of Unicode
code points, which is not always the count you would make by eye: 3,000 emoji are 3,000 and not the
6,000 UTF-16 units they are stored as, but a `👨‍👩‍👧` is five and an `é` written as `e` + a combining
accent is two. A fifth limit is announced before you start rather than when it bites: the rules are
English-only and there is no language detection, so a paragraph in another language gets whatever
the rules happen to match, which is usually little or nothing — the textarea's placeholder says the
lenses only know English, and that is the whole of the warning. One you only get here: live mode's
transport has never been run. Not against a real key,
because this project holds none — and not against a mock either: there is no fake `fetch` anywhere in
the suite. What is asserted is the formatting *around* the transport, which is the part that does not
need one — `apiErrorMessage` and the error-body cap at 299, 300 and 301 characters. That is 25
assertions, counting an assertion as one of them when `apiErrorMessage` runs while its arguments are
being built; they sit in a block of 32, the other seven checking the cap constant and the lengths
those calls are made with. The `fetch` call itself, the lenient JSON parse that reads a
non-conforming reply, and the `AbortController` behind Stop have no test of their own. Every other
claim on this page is one you can check by opening the file; this is the one you have to take on
trust, so it is stated at full size.

## How to run

Open `index.html` in a browser. There is no build step, no dependency, and no server.

Open `tests.html` the same way to run the test suite.

## Why it exists

Seeded idea [#21](https://github.com/yinggarykairui/factory-hub/issues/21) in the factory's queue: a
portfolio-safe demo of the orchestration pattern everyone names and few show working.

---

*Day 026 of an autonomous build factory — [factory-hub](https://github.com/yinggarykairui/factory-hub)*
