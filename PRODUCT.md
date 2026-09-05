# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: **QA engineers and product managers** who own a regression suite and pay for it in
maintenance rather than in authoring. The situation that matters is the one after a UI
change lands: the suite goes red, and someone has to work out for each failure whether the
application broke or the test merely went stale. That triage is the job the product takes
over.

Evaluation audience: hackathon judges, who will score the interface **through the QA
engineer / PM lens** rather than as visitors to a marketing page. So the surface is judged
as a working tool, not as a pitch: density, scanability, keyboard flow and whether a
verdict can be trusted at a glance all count. It has to hold up to someone who has been
paged by a flaky suite.

## Product Purpose

A test is written in plain English. The system explores the application, records how to
run it, and replays it on every commit. When the UI changes, it repairs the test itself —
but only when the *test* is stale, never when the *application* is broken.

Success is a suite that stops costing triage time without ever going quiet about a real
defect.

## Positioning

Every failure is asked one question: **did we fail to find the element, or did we fail to
get the expected result?** The first is a stale test and is repaired. The second is a
broken application and is escalated, never repaired.

The differentiator is the refusal, not the repair. A tool that heals everything will
eventually rewrite a suite until it passes, which is the precise opposite of what a suite
is for. Any competitor can claim self-healing; almost none can show a case where their
tool was offered a repair and declined it, name why, and prove the distinction was
mechanical rather than a guess. This product can, and does, on demand.

Value framing the team uses externally: it removes the QA maintenance burden. Recorded
here as framing, not as mechanism — the product deliberately keeps a human in the loop for
real defects, and overclaiming full replacement would be contradicted by its own
escalation behaviour in front of the exact audience most likely to test for it.

## Operating Context

- A run is replayed against a live application over SSE, so the interface is watched while
  it works, not only read afterwards.
- The demonstration substrate is a seven-release fixture of one shopping flow: legacy →
  accessible → hardened → redesign → broken login → feature removed → price change. It
  reads as a deployment history, and switching releases replays the same recorded test
  against a changed UI.
- The pivot is the second release: an accessibility fix gives an unlabelled icon button an
  accessible name, which breaks the recorded locator and forces a repair. The accessibility
  fix is the reason the better locator exists.
- Alongside functional replay, every page visited is reported on for visual change (and
  what *kind* of change), accessibility, and a passive security read.
- Deployment target is a free tier, so concurrency is capped at one and the filesystem does
  not survive a restart.

## Capabilities and Constraints

- Plan lifecycle is DRAFT → APPROVED. A draft cannot be run; approval is a trust gate and
  the server enforces it independently of the interface.
- Heals are capped at three per run. Past the cap the run is reported as needing review
  rather than as a pass.
- A repair is verified by the application's own behaviour where a post-condition exists. A
  repair accepted on the model's word alone is marked as such and is not treated as equal.
- Model proposals are cached, so a repeated demonstration costs no quota and produces the
  same result.
- Undecided: whether the interface should also serve practitioners adopting it day to day,
  beyond the evaluation window. Recorded as open rather than assumed.

## Brand Commitments

- Name: **ProofWright**. Binding. The interface, README and any deployed title use it.
- The verdict vocabulary must stay **semantically distinct**: pass, pass-via-fallback
  (drift), repaired (healed), failed, needs review, skipped. A pass and a pass-via-fallback
  must never read as the same state. The specific hues are not binding; the distinctions
  are.
- No claim may be made that the product cannot demonstrate. The documentation states its
  own limits plainly and the interface must not overstate what a run established.

## Evidence on Hand

- `docs/CASES.md` — every case handled, with the verdicts **actually produced** rather than
  the ones intended, and the limits stated plainly.
- `docs/DEVELOPMENT-LOG.md` — real defects found while building, symptom first, and what
  each taught.
- The seven-release fixture, runnable, with recorded baselines and cached proposals so a
  cold start demonstrates a repair with zero model calls.
- Real measured accessibility and security scores that move across releases (accessibility
  10 → 100 at the pivot; security 29 → 100 at the hardening release).
- No customers, testimonials, benchmarks or pricing exist. Future work must not invent any.

## Product Principles

1. **The refusal is the feature.** Anyone can repair. Declining to repair a broken
   application, and saying why, is what makes the repairs trustworthy.
2. **Never overstate what a run established.** A verdict reached without verification is
   labelled as such, not rounded up to a pass.
3. **Attribution before remedy.** A failure is first attributed correctly — stale test or
   broken application — and only then acted on. Misattribution sends someone to the wrong
   system, which costs more than the failure did.
4. **Show the evidence beside the claim.** A repair is shown with what verified it and with
   the before and after of the element that changed.
5. **Judged as a tool, not a pitch.** The audience arrives wearing a QA engineer's
   scepticism. Density and trustworthiness beat persuasion.

## Accessibility & Inclusion

WCAG 2.1 AA is a **product-specific requirement**, not a general aspiration. The product
audits accessibility and scores it as a headline number; an interface that fails the
standard it measures would discredit the measurement in front of the one audience most
likely to check. Concretely: text contrast at or above 4.5:1 on every surface it is used
on, a visible keyboard focus indicator on every interactive element, no meaning carried by
colour alone, and no path reachable by mouse but not by keyboard.
