# Development log: defects found, and how

Every entry below is a real defect found by running the system, not a hypothetical.
Each one is recorded with the symptom first, because the symptom is what you
actually get, and in almost every case it pointed somewhere other than the cause.

The pattern worth noticing: **eight of the eleven defects were found by the fixture
releases, not by unit tests.** A test suite confirms the code does what you wrote.
Running a real browser against a real app that changed in a realistic way tells you
whether what you wrote was right.

---

## 1. A missing environment variable reported the application as unreachable

**Symptom.** A run came back with all nine steps `skipped` and a run-level failure
saying the application was never reachable. The application was running fine and
serving pages.

**Actual cause.** A plan refers to credentials by name (`valueRef: "TEST_PASSWORD"`)
so the value never enters a file or a prompt. Resolving that name happened *outside*
the per-step try block, so when the variable was unset the error escaped the step
entirely, escaped `runSteps`, and was caught by the outer handler whose job is to
classify "the app was never reachable".

**Why it mattered more than it looked.** This project's entire thesis is correct
attribution — deciding whether the *test* is stale or the *app* is broken. Here it
told you a third thing that was also false, and it sent you to check the wrong
system. The classifier had eleven failure kinds and none of them meant "the run was
misconfigured".

**Fix.** A twelfth kind, `CONFIGURATION_ERROR`, attributed to the step that needed
the value, and value resolution moved inside the step's error handling.

**Lesson.** A taxonomy needs a category for "neither of the things this tool
distinguishes". Without one, every unclassifiable failure gets forced into whichever
existing category the code path happens to reach.

---

## 2. Adding a schema field silently orphaned every stored artifact

**Symptom.** Cold-start seeding reported one plan loaded when two files existed. No
error, no warning.

**Actual cause.** `expectedValue` had been added to the step schema as
`z.string().nullable()`. In Zod, `nullable` requires the key to be *present* and
allow null — it does not make the key optional. Every plan written before that field
existed therefore failed validation, and the seed loader used `safeParse` and
skipped failures silently.

**Fix.** `.default(null)` on read, so an absent key reads as null. Generation stays
strict because the JSON-schema converter strips `default` before the schema reaches
the model, and the grounding rules still apply. Seed rejections now log the offending
field paths.

**Lesson.** `nullable` and `optional` are different, and the difference only shows up
against data written by an older version of your own code. Any field added to a
schema that reads persisted records needs a default.

---

## 3. The same mistake again, one layer down: silent data loss

**Symptom.** Visual comparison reported every page as "never seen before", on every
run, even immediately after recording had captured all of them.

**Actual cause.** `visualBaselines` was added to the baseline *schema* but never to
the baselines *table*. The insert statement did not mention the column, so the data
was dropped on write, and the schema default filled it back in as `[]` on read. The
round trip lost the data and then made it look intentional.

**Fix.** A `visual_json` column, plus a forward migration that tolerates its own
duplicate-column error so it is safe on every boot.

**Lesson.** This is defect 2 in a different clothing: a value that survives
validation but not persistence. Finding the first is the only reason the second was
recognised quickly. **A schema and its storage are two separate contracts and both
have to be changed.**

---

## 4. Committed baseline data was unusable the moment it was deployed

**Symptom.** Found by reasoning about the deployment target rather than by a failing
run, which is why it is here: it would have failed on the hosted instance and worked
on every developer machine.

**Actual cause.** Every baseline step records the URL it ran on, and the replay
refuses to act when the browser is somewhere else — the check that stops an expired
session being "healed" into pointing at a login form. That comparison includes the
origin. A baseline recorded at `http://127.0.0.1:7860` replayed on
`https://<space>.hf.space` would report every step as a page divergence.

**Fix.** Rebase the origin at run time, preserving every path, query and hash. Runs
target loopback rather than the public URL, because the browser is inside the same
container and the public origin is not knowable from inside without trusting a
forwarded header. Eight unit tests, and verified by recording on one port and
replaying on another.

**Lesson.** "The application moved" and "the application navigated somewhere
unexpected" look identical to an origin comparison and are completely different
events. Portable artifacts need the distinction made explicitly.

---

## 5. A filled field reported itself empty, and a stale locator became an app failure

**Symptom.** A step filled a search field successfully, then failed with `The field
was empty` and the verdict `OUTCOME_NOT_MET` — which is not healable, so the run
stopped.

**Actual cause.** The accessibility release renamed the field's accessible name (a
real `<label>` replacing a placeholder), so the recorded `role`-based locator broke
and a `css` fallback rescued the step. The fill landed on the correct element. But
the step's own post-condition — `inputFilled` — still pointed at the *recorded*
locator, which by definition no longer matched. The assertion was evaluated against
nothing and reported the field as empty.

**Why it was the worst one.** The message was the exact opposite of the truth, the
verdict was in the "never heal" category, and a stale locator was therefore reported
as an application defect. Everything downstream behaved correctly on a false premise.

**Fix.** An assertion about the step's own element is rebound to the locator that
actually found it. Assertions naming a *different* element — the destination heading
after a navigation — are left exactly as recorded, because their identity is not the
step's element. Six regression tests.

**Lesson.** A fallback locator is not just an alternative route to the element; it
changes the element's identity for everything else in that step. Anywhere a locator
is stored twice, the two copies can disagree.

---

## 6. Visual analysis overturned a healed, verified, passing run

**Symptom.** A run reported `9/9 steps passed, healed=1` and a verdict of `FAILED`.

**Actual cause.** Two independent problems behind one number.

First, double reporting. When an element a step depends on disappears, the step
already fails `ELEMENT_NOT_FOUND` and the run already stops. Failing *again* in the
visual layer added nothing and let the visual pass — which knows less — overturn the
functional verdict.

Second, it punished the remediation it exists to encourage. An element's visual
identity is partly its accessible name, so giving a control a proper label reads as
one element vanishing and another appearing. The accessibility release failed on
twenty "missing" elements that were all still present under better names.

**Fix.** Visual findings report by default and gate only in explicit strict mode. The
functional layer decides verdicts.

**Lesson.** When two analyses can both fail a run, decide which one owns the verdict
before shipping either. Otherwise the less-informed one wins whenever it is stricter.

---

## 7. Healing and visual analysis contradicted each other about one change

**Symptom.** The basket page reported its checkout link as missing content while, a
moment later, the healer identified what had replaced it and proved the flow still
worked. Two subsystems, one change, opposite conclusions.

**Actual cause.** Two separate bugs, found one after the other.

The first was ordering. A page is inspected when a step on it passes, but the heal
that explains a vanished control happens on a *later* step. Classifying as each page
was reached meant deciding without information that had not arrived yet.

The second was the reconciliation key. It matched on role and accessible name, which
missed the one case that matters: a control with **no** accessible name keys on its
id instead — and a control with no accessible name is precisely what an accessibility
remediation replaces.

**Fix.** Capture stays live, because a page only looks like that while the run is
standing on it; classification waits until every heal is known. Reconciliation
mirrors the signature's own identity precedence, and *any* element a step located by
any means — primary, fallback or heal — is reconciled, because locating it at all
proves it is still there.

**Lesson.** Two analyses that observe the same event will disagree unless one is
explicitly told what the other concluded. And a shared identity function must be
shared in fact, not reimplemented in each place.

---

## 8. A pixel diff cannot express the requirement

**Symptom.** Not a crash — a requirement that could not be met by the intended
design. "A button's colour change should not fail the test" and "a button that moved
should be reported" are the same measurement to a pixel diff: N pixels differ.

**Fix.** Compare geometry and computed style separately, with style properties split
by whether they are *capable* of moving anything. A diff confined to colour, weight,
radius and shadow is then cosmetic by construction rather than by a guess about which
properties probably matter. Four verdicts instead of a percentage.

Nearly free to build: the extractor already called `getBoundingClientRect` and
`getComputedStyle` on every element for its visibility test, and discarded both.

**Lesson.** When a metric cannot distinguish two cases you must treat differently, no
threshold on that metric will help. Change what you measure.

---

## 9. Excluding a volatile region is only half a fix

**Symptom.** Six layout shifts reported on a login form nobody had touched — at mobile
width only.

**Actual cause.** The fixture's own banner names the version being served, and that
text is longer in some releases. At 390px it wrapped to a second line and pushed the
entire page down 58px. Those elements genuinely had moved.

Marking the banner as ignored stopped it being *compared* but could not stop it
*occupying space*.

**Fix.** Scaffolding was given a version-independent height. The limitation is now
documented where the ignore attribute is defined, because it applies to every
volatile region a real user will exclude — a timestamp, an ad slot, a build label.

**Lesson.** An exclusion list removes an element from your analysis, not from the
layout. Anything that changes height still moves everything below it.

---

## 10. A transient 503 silently cost a run its repair

**Symptom.** Two runs against releases with identical accessibility: one healed, one
did not. Nothing in the code differed.

**Actual cause.** The model returned `503 high demand`. The system handled it
*correctly* — emitted `HEAL_ERROR`, kept the step's original `ELEMENT_NOT_FOUND`
classification, and refused to relabel an infrastructure problem as an application
fault. But there was no retry, so a single transient error made healing a coin flip.

**Fix.** Exponential backoff with jitter on 429/500/502/503/504. Jitter matters
because a run heals several steps in quick succession and identical backoff sends
every retry into the same congested moment.

**Lesson.** Correct handling of a transient failure is not the same as resilience to
it. The diagnosis was right and the outcome was still useless.

---

## 11. The free tier allows twenty requests a day, and says so only once you hit it

**Symptom.** Healing stopped working entirely. `429 RESOURCE_EXHAUSTED`,
`limit: 20, model: gemini-3.7-flash`.

**Actual cause.** Free-tier quota is per model, per day, and the default model
allowed twenty generate-content requests in twenty-four hours. Enough to develop
against; not enough to demonstrate with.

A second-order bug fell out of fix 10: the new retry treated 429 as transient, so a
*daily* ceiling burned four attempts and several seconds of backoff to arrive at the
identical error.

**Fixes, three of them.**

- A different model, chosen for its ceiling rather than its version number. A probe
  tool (`npm run models`) reports what a key can actually reach, because the ceiling
  is invisible until it is hit.
- Retry distinguishes a burst limit from a per-day ceiling by the quota id in the
  error body. A per-day ceiling is not retried.
- A **proposal cache**. The same failure asked twice gets the same answer at the cost
  of a request against a daily quota. Verified: the first run makes two live calls,
  every subsequent run makes none and still heals and passes.

**Why the cache is safe.** A proposal is a *suggestion*. Every cached proposal is
still resolved to a locator against the live page, still executed, and still judged by
the step's original recorded outcome. Reusing one cannot make a wrong heal pass — it
only skips the asking. Runs report whether a proposal was cached, because a reused
answer presented as a fresh one would overstate what happened.

**Lesson.** Quota is a design constraint, not an operational detail. It shaped the
architecture, and the architecture happened to absorb it well: replay needs no model
at all, so the expensive path is the rare one.

---

## 12. The cache stored a value that only meant something inside one session

**Symptom.** A cache hit resolved to nothing. The heal was reported `unlocatable`
while the element sat plainly on the page.

**Actual cause.** A proposal names elements by the extractor's `ref` — `s1e12` means
"the twelfth element of the first extraction pass" and nothing more. Cached and
replayed, it pointed at whatever happened to be twelfth next time, or at nothing.

**Fix.** Candidates are stored by a stable identity (role, accessible name, test id,
tag) and re-bound to the live page on a hit. A stored candidate whose identity is gone
is dropped rather than guessed at; if that empties the list the caller gets a miss and
the model is asked afresh, because a cache that can silently turn a real answer into
"no candidate" is worse than no cache.

**Lesson.** Before persisting a value, ask what its identifiers are scoped to. A
session-local handle is not data.

---

## 13. A later feature silently invalidated an invariant an earlier one relied on

**Symptom.** Exposing baseline recording over HTTP, every step failed with *"matched
element [s0e0] but could not derive a locator that uniquely selects it — the element has
no test id, accessible name, label or stable id to anchor on."* The element was a login
field with a test id, an accessible name, an id, a name attribute and a placeholder. The
probe tool, run against the same page, listed five verified locators for it.

**Actual cause.** `extractPage` does not only read the DOM — it **stamps** every element
it saw with a `data-qa-ref`, and `resolveLocators` proves a candidate by matching that ref
back through the page. Two extractions therefore interfere: the second renumbers
everything the first recorded.

Visual capture, added much later, performs its own extraction — twice, once per viewport.
In the recorder it ran immediately after the initial snapshot, so that snapshot held
pass-0 refs while the page carried pass-2 ones. Every candidate failed its own
verification, and the error message — which is constructed from what *should* have been
available rather than from what was observed — confidently described the opposite of the
truth.

**Fix.** The snapshot used for resolution is always the most recent extraction: the visual
capture runs first, and the carried-forward snapshot is refreshed whenever a capture
re-stamped the page.

**Lessons, three.** A read that mutates is not a read, and `extractPage` should probably
say so in its name. A feature can invalidate an invariant it has never heard of — nothing
in the visual module mentions locator resolution, and nothing in the recorder mentions
visual capture. And a constructed error message will confidently mislead: this one listed
four attributes the element demonstrably had, because it described the expected reason for
failure rather than the observed one. The probe tool disproved it in one command.

---

## What the pattern says

Three of these — 2, 3 and 12 — are the same underlying mistake: **a value that
survives one boundary and not the next.** Schema validation but not persistence. One
session but not the next. Recognising the second and third quickly was entirely
because of the first.

Two more — 5 and 7 — are the same mistake in a different dimension: **the same fact
stored in two places, and the copies disagreeing.** A locator held on the step and
again inside its assertion. An element identity computed by the visual signature and
recomputed by the reconciliation.

And the most valuable single finding, defect 6, was not a crash at all. The system
did exactly what it was told; what it was told was wrong. It took running a realistic
release to notice, because a unit test would have asserted the behaviour I had
intended.
