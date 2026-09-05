# Cases this system handles

Everything here has been run and observed. The verdict column is what the tool
actually reported, not what it is designed to report.

The organising idea is a single question asked of every failure: **did we fail to
find the element, or did we fail to get the expected result?** The first is a stale
test. The second is a broken application. A tool that gets this wrong in the
optimistic direction will eventually rewrite a suite until it passes, which is the
precise opposite of what a suite is for.

---

## The headline: an accessibility fix breaks a test, and the test repairs itself

This is the case worth leading with, because it is the one that changes how people
think about the tool.

A team ships a login and catalogue page where the search control is an icon button
with no accessible name. A screen reader announces nothing. The recorded test can only
find it by its `id`, the least durable locator available.

The team then does the right thing and remediates: a real `<label>`, a semantic
`<button>`, an `aria-label`, and the JS hook `id` is no longer needed so it goes.

| What happened | Reported as |
|---|---|
| Accessibility score on the catalogue | **10 → 100** |
| `css="#search-go"` no longer matches | `ELEMENT_NOT_FOUND`, healable |
| Model proposes the newly-named button | `role=button[name="Search products"]`, confidence 0.95 |
| Candidate executed, original outcome re-checked | `urlContains "?q=cable"` held |
| Verdict | **PASSED**, 1 heal |
| Contrast change on every page | `COSMETIC`, absorbed |

Two things make this more than a trick. The heal replaced a fragile locator with a
**more durable one** — an id-based match became a role-and-name match, which is second
only to a test id for surviving change. And the accessibility fix is the *reason* the
better locator exists.

The argument: a tool that goes red when a team improves accessibility teaches them not
to. This one goes green and reports the improvement.

---

## Self-healing: what is repaired and what is refused

| Case | Fixture | Classification | Healed? | Why |
|---|---|---|---|---|
| Control renamed, no fallback survives | v4 | `ELEMENT_NOT_FOUND` | **yes** | Nothing was found on a settled page; a candidate satisfied the original outcome |
| Control gained an accessible name | v2 | `ELEMENT_NOT_FOUND` | **yes** | Same, and the replacement locator is more durable than the original |
| Control renamed but a fallback matches | v2 `fill-search` | passes | no heal needed | Passed via fallback and reported as **drift** — one change away from needing repair |
| Login stops authenticating | v5 | `OUTCOME_NOT_MET` | **never** | The button was found and clicked; only the result was wrong |
| Feature deleted outright | v6 | `ELEMENT_NOT_FOUND` → `no_candidate` | **no** | The healer was asked and correctly answered that nothing serves the intent |
| Locator now matches two elements | fault-drill | `LOCATOR_AMBIGUOUS` | yes | Was unique when recorded, so the page changed |
| Server returns 500 | fault route | `HTTP_ERROR` | **never** | Every element is missing, but the status code says why |
| Route removed | fault route | `HTTP_ERROR` (404) | **never** | Not a stale locator |
| Session expires mid-flow | fault route | `PAGE_DIVERGED` | **never** | Caught before any element lookup — a login form has plausible inputs and this is the most damaging false heal available |
| Slow API, element not yet rendered | fault route | `PAGE_NOT_READY` | **never** | Page reported itself busy, so this is a timeout; the healer is never shown loading skeletons |
| Application unreachable | fault-drill | run-level `NETWORK_ERROR` | **never** | Nothing was tested, and the report says so |
| Environment variable unset | — | `CONFIGURATION_ERROR` | **never** | Neither the app nor the test is at fault |

**Three heals per run, then it escalates.** Each heal is independently verified, so
three are individually sound — but a run where most steps needed repairing is not a
stale locator, it is a different application. Past the cap the healer is not consulted
at all, because asking and discarding the answer spends a model call to reach the same
verdict.

**A heal that cannot be verified is flagged, not hidden.** A step with no recorded
post-condition gives the healer nothing to check against, so its outcome "held" only
because there was nothing to hold. Those runs are marked `needs_review` rather than
presented as confirmed.

---

## Design intelligence: four verdicts, not a percentage

A pixel diff produces one number, and a recoloured button and a button that moved 50px
produce the same number. Geometry and computed style are compared separately, with
style properties split by whether they can move anything.

| Change | Verdict | Consequence |
|---|---|---|
| Colour, font, weight, radius, shadow, opacity — box unchanged | `COSMETIC` | Passes; the stored signature updates so the same restyle is not reported forever |
| Moved beyond 4px, resized beyond tolerance, or a layout property changed | `LAYOUT_SHIFT` | Reported with the delta; gates only in strict mode |
| Present in the baseline, absent now | `CONTENT_MISSING` | Reported; never absorbed |
| Absent before, present now | `CONTENT_ADDED` | Reported |
| Text changed | `TEXT_CHANGED` | Reported; whether it *fails* is decided by the step's assertions, not here |
| Gone, but the healer identified the replacement | `CONTENT_REPLACED` | Reported, not failed — and still not absorbed, because a replaced control is worth a human's eye |

Observed on the redesign release:

```
COSMETIC      heading "Checkout" restyled: color rgb(31,41,51) -> rgb(45,41,38),
              fontFamily Arial -> Georgia. Position and size unchanged.
LAYOUT_SHIFT  heading "Order summary" moved by -600, +0px; resized by +600 x +0px.
LAYOUT_SHIFT  button "Place order" moved by +0, +219px.
```

Named and actionable, rather than "3.2% of pixels differ".

**Two viewports**, 1280×800 and 390×844, classified independently. A change that is
cosmetic on desktop can be a broken layout at mobile width, and a suite that only ever
looks at one width cannot see it.

**No false positives on an unchanged app**: 10 page-viewport pairs compared, zero
findings, twice in a row.

**The tolerance is deliberately generous on size.** Changing a font family is cosmetic
by any reading but genuinely re-measures every piece of text — a button that has not
moved still gets three pixels wider. A tolerance that could not absorb that would
report every restyle as a reflow, which is exactly the false positive that gets visual
testing switched off.

---

## Accessibility

Two layers, both reported, neither gating.

**Page level** — axe-core, WCAG 2.0/2.1 A and AA only. AAA is a policy choice most
teams have not made, and reporting it as failure buries the ones they have.

Observed on the legacy release: `button-name` (critical), `label` (critical),
`image-alt` (critical ×3), `color-contrast` (serious ×16). Score 10.

**Per element** — for the specific controls the test drives, published live as
`A11Y_STEP_CHECKED`: whether the control has an accessible name at all
(`accessibleName`), whether its only name is a placeholder (`placeholderOnlyName`),
whether it has an announceable role, whether it is enabled, and its contrast ratio
against the nearest opaque ancestor background.

Observed on the legacy release: three fields named only by a placeholder, and one icon
button with **no name at all** — which is the control that goes stale and heals when the
remediation names it.

That second layer carries a `testabilityNote`, and it is the point:

> Locators rank role plus accessible name second only to a test id. With no name, this
> control can only be found by its raw text or its position — both of which break on
> the next copy edit or reorder, and both of which give a healer less to work from.

**Accessibility quality and test durability are the same property measured twice.** An
element that is easy to describe to a screen reader is easy to describe to a locator.
That is not a slogan; it is why the v2 heal produced a better locator than the one it
replaced.

Score is the **worst page**, not an average. Averaging lets one unusable page hide
behind four good ones, and the unusable page decides whether the journey works.

---

## Security — passive only, and deliberately so

Everything is read from responses the run was making anyway and the DOM it was
rendering anyway. Nothing is injected. Nothing is fuzzed.

That is a designed limit. The moment a QA tool starts probing it becomes a scanner,
and a scanner pointed at a URL somebody typed into a text box is a tool for attacking
third parties.

| Check | Severity | What its absence allows |
|---|---|---|
| `Content-Security-Policy` | high | Any injected markup that reaches the page can execute |
| Session cookie without `HttpOnly` | high | One injection is enough to take the session |
| Credential shapes in page source | high | Anyone who loads the page has it; rotation is the only remedy |
| Form posting over `http` | high | Everything typed, including credentials, sent in the clear |
| `Strict-Transport-Security` | medium | The first request can be intercepted before the redirect |
| Clickjacking protection | medium | The page can be framed under an invisible overlay |
| Mixed content on a secure page | medium | A subresource can be replaced in transit |
| `X-Content-Type-Options` | low | An upload may be treated as script |
| `Referrer-Policy` | low | Full URLs leak to every third party linked |
| Password field autocomplete | low | Browser may refill on a shared machine |
| `target="_blank"` without `noopener` | low | The opened page can navigate this one |

Observed: legacy release **29** with 33 findings; hardened release **100** with none,
and no functional or visual change whatsoever — proof the analyses are independent.

Credential findings print a truncated match (`AIzaSyD3mo...`), never the value. A
finding that prints the secret has copied it into the run record and every log that
record reaches.

---

## The case that shows why the identity model matters

The price release changes every price and nothing else. What happens depends entirely
on what the test asked for, and **both answers are correct**:

| The test says | Result | Why |
|---|---|---|
| "confirm the order total is shown" | **passes** | The amount is located by the inert "Total" label beside it, so its identity survives a data change, and a total is still displayed |
| "confirm the total is £49.00" | **fails** `OUTCOME_NOT_MET` | The value was asserted, so a different value is a real failure — and it is never healed |

The important part is that **neither reaches the healer**. The value lives in the
assertion and the identity lives in the label, so a data change cannot arrive as
`ELEMENT_NOT_FOUND` and be quietly repaired into the new number. Without that
separation, a pricing regression would be indistinguishable from a rename — and the
"repair" would be to accept the wrong price.

This is what the `labelledBy` locator strategy exists for:

```
xpath=//*[normalize-space(text())="Total"]/following-sibling::*[1]
```

---

## Human in the loop

| Gate | When | Behaviour |
|---|---|---|
| Plan approval | After English → steps | **Mandatory.** Nothing can be recorded or replayed from a `DRAFT` plan. Full editing of action, target and value |
| Any edit | On save | Returns the plan to `DRAFT` — the approval applied to what was reviewed, not to what it became |
| Baseline review | After recording | Optional: inspect resolved locators, confidence and warnings |
| Heal acceptance | On accept | Automatic, with full audit trail and one-click revert. Justified because the original recorded outcome already held against the live app |
| Visual cosmetic | On absorb | Automatic and revertable |

The gate is enforced in the API **and** the CLI. A gate one interface can walk around
is not a gate.

Revert restores the previous locator and fingerprint from `healHistory` and clears the
fallbacks — those described the *healed* element, so keeping them could silently rescue
the step with a locator for the wrong thing. That costs a drift warning on the next
run, which is the honest outcome.

---

## Robustness worth mentioning

- **Replay makes zero model calls.** Only plan generation, baseline recording and
  healing cost anything. A judge clicking Run on a green test costs nothing at all.
- **Proposal cache.** The same failure asked twice reuses the answer. First run: two
  live calls. Every run after: none, still healing, still passing. Correctness is
  unchanged because the candidate is still executed and still judged by the recorded
  outcome — only the asking is skipped, and runs report which happened.
- **Retry with jittered backoff** on transient model failures; no retry on a per-day
  quota, which is not transient.
- **A heal that cannot run never becomes the verdict.** An API error, a quota, a failed
  state rebuild — the step keeps its original honest classification and the heal
  failure is reported separately.
- **An analyser that throws never becomes the verdict.** A step that passed against the
  application did pass.
- **Runs queue at concurrency one.** Each drives a real browser at two viewports; on a
  small container unbounded concurrency does not degrade, it gets the container killed.
- **Events are persisted before delivery** and replayed on connect, so a viewer who
  joins mid-run sees the whole run rather than the remainder.

---

## Known limits, stated plainly

- **Iframes and shadow DOM are not traversed.** Payment fields and most web-component
  design systems are invisible. Counted and warned about at record time, so a baseline
  recorded against such a page says so rather than quietly looking complete.
- **No assertion for the absence of something.** "No error banner appeared" cannot be
  recorded, so a step that succeeds while an inline validation error shows still passes.
- **Visual absorption is per page, all or nothing.** A page with one layout shift does
  not absorb its cosmetic changes either, so those are re-reported next run.
- **An ignored region still occupies space.** Excluding a volatile region stops it being
  compared, not from pushing everything below it when its height changes.
- **A run halts at the first failure**, so later stale steps in the same run go
  unreported — and two failure kinds cannot be demonstrated by one plan on one release.
- **The accessibility and security scores are not conformance measures** and are not
  presented as such. They are weighted counts, so "did this get better or worse" has an
  answer.
