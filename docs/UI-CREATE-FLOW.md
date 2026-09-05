# UI addendum: the create flow

The dashboard is missing its entry point. Everything below is built, committed and
verified against the running server; this is what the front end needs to add.

Read with `docs/UI-BRIEF.md`. Nothing in that brief changes — this adds a screen in
front of it.

---

## The flow

```
   describe in English  ──►  review the steps  ──►  record against the app
        (LLM)                  (edit freely)          (finds the locators)
                                                            │
                                                            ▼
                                              review the resolved locators
                                                            │
                                                        approve
                                                            │
                                                            ▼
                                                          run
```

One decision worth understanding, because it differs from the original brief.
**Recording is allowed on a `DRAFT` plan.** Gating recording but not running was
incoherent — both execute against the application. The distinction that matters is
supervision: recording is exploratory with a person watching, and it is what reveals
which locators the plan actually resolves to. Reviewing abstract steps without them is a
much weaker review. Running, the unattended and repeated action, stays gated on
approval.

So the review that matters happens **after** recording, with locators visible.

---

## `POST /api/plans` — English to plan

Synchronous, a few seconds. Show a spinner, not a stream.

```jsonc
// request
{
  "instruction": "Log in with my test account, search the catalogue for a cable, open the first product and confirm its price is shown.",
  "targetUrl": "http://127.0.0.1:7860/app/",   // optional, defaults to the bundled app
  "planId": "judge-demo"                        // optional, derived from the plan name
}
```

`201` on success:

| Field | Use |
|---|---|
| `plan` | The stored plan, `status: "DRAFT"`. `plan.plan.steps[]` is the step list |
| `model` | Which model produced it |
| `validatorAttempts` | How many tries the rules needed. **Surface this.** A plan accepted first time deserves less scrutiny than one that took three |
| `rejections[]` | `{attempt, errors[]}` — what the validator rejected on the way. Worth showing behind a disclosure; it is the most convincing evidence that generation is constrained rather than trusted |
| `warnings[]` | Non-fatal concerns about the generated plan |
| `requiredValueRefs[]` | Environment variables the plan refers to **by name**. Show these — it is how a reviewer knows no password is stored in the plan |

`400` for an instruction under 8 characters or an unparseable URL, with `error`.
`502` for a model failure or quota — deliberately not 400, since the caller did nothing
wrong and a 400 sends someone to fix the wrong thing.

### Rendering the steps

Each step carries `sourcePhrase`, which is **checked as a literal substring of what the
user typed**. Show it under each step. It is the answer to "did the model invent this?" —
a step that cannot quote the instruction is never emitted, and showing the quote makes
that visible rather than merely claimed.

Also worth distinguishing in the UI: `value` is a literal, `valueRef` is the *name* of an
environment variable. A step showing `$TEST_PASSWORD` rather than a password is the
security property made legible.

`expectedValue` is `null` unless the user named a literal value. That is not an omission —
it decides whether a later data change is a pass or a failure, so a plan asserting a
specific total should look different from one asserting that a total is shown.

---

## `POST /api/plans/:planId/baseline` — record it

Returns `202 { jobId, queuePosition, stream }`. Queued behind any active run, so
`queuePosition > 1` must be shown or a waiting recording looks broken.

Stream it at `GET /api/jobs/:jobId/stream`. Identical SSE framing to a run: `id:`,
`event:`, and `data:` of `{ seq, at, type, payload }`, with history replayed on connect,
so a reload mid-recording catches up. Close on `STREAM_END`.

| Event | Payload |
|---|---|
| `RUN_QUEUED` | `position`, `ahead` |
| `RECORD_STARTED` | `planId`, `name`, `startUrl`, `steps`, `status` |
| `RECORD_PAGE` | `url`, `elementCount`, `truncated` — the recorder reached a new page |
| `RECORD_STEP_RESOLVED` | Fires up to three times per step: with `matched`/`confidence`/`reason` when the model picks an element, with `locator`/`fallbacks` when one is derived, then with `outcome` once executed |
| `RECORD_WARNING` | `stepId`, `message` — a step with no post-condition, a positional locator, an unreachable iframe |
| `RECORD_COMPLETE` | `steps[]` with `locator`, `strategy`, `fallbacks`, `confidence`, `assertions[]`; plus `warnings.withoutPostCondition[]` and `warnings.locatedPositionally[]` |
| `RECORD_ERROR` | `message`, `aborted` |

`GET /api/jobs/:jobId` returns `{ job, events[] }` for a finished recording, so — exactly
as with runs — the same component can render live or replayed from one array.

Cancel with `POST /api/jobs/:jobId/cancel`. List with `GET /api/jobs?planId=`.

### What the review screen should make obvious

This is the screen that earns trust, because it shows the machine's work rather than its
conclusion.

**The locator strategy per step, named.** `testId` and `role` + accessible name are
durable; `css` and `text` are not. A run recorded mostly on `css` is fragile and the
reviewer should be able to see that at a glance. Colour or badge by durability tier —
the order is `testId`, `role`, `label`, `labelledBy`, `placeholder`, `altText`, `css`,
`text`.

**The fallback count.** A step with three verified fallbacks survives more change than one
with none. In the verified example, `step-5` resolved to `css="#search-go"` with **zero**
fallbacks — and that is precisely the step that later needed healing. Making that visible
before the first run is the whole value of this screen.

**The warnings, not buried.** `withoutPostCondition` means a step has nothing to verify a
future heal against; `locatedPositionally` means a locator says "the third thing that
looks like this" and will silently retarget if the page reorders.

**What each step checks.** `assertions[]` is already formatted for display
(`urlContains "/app/catalog"`, `inputFilled`).

Then: **Approve** → `POST /api/plans/:id/approve` → **Run**.

---

## Worked example, from the verified run

Instruction: *"Log in with my test account, search the catalogue for a cable, open the
first product and confirm its price is shown."*

Seven steps generated, one validator attempt, requiring `TEST_EMAIL` and `TEST_PASSWORD`.
Recorded across four pages:

```
step-1  fill    testId="login-email"                    +4 fallbacks
step-2  fill    testId="login-password"                 +4 fallbacks
step-3  click   testId="login-submit"                   +3 fallbacks
step-4  fill    role=searchbox[name="Search products"]  +3 fallbacks
step-5  press   css="#search-go"                        no fallbacks   ← fragile
step-6  click   role=link[name="View"]                  +2 fallbacks
step-7  assert  after label "30m industrial reel."      +2 fallbacks
```

Refused a run while `DRAFT`. Ran 7/7 once approved. Then, with the release switched to
the redesign, `step-5` broke exactly as its missing fallbacks predicted — and healed to
`role=button[name="Search products"]`.

That sequence is the demo: *the user wrote the test, the screen warned which step was
fragile, and the tool repaired that step when it broke.*

---

## Small things

- `targetUrl` defaults to the bundled app, so the flow works without knowing a URL. If
  you expose the field, prefill it and explain that an arbitrary URL is allowed.
- Generation costs model calls; recording costs one per step. Both count against a
  per-day free-tier quota, so avoid firing either on a keystroke or a retry loop.
- A recording overwrites the plan's existing baseline. If one exists, say so before
  starting — heal history on the old baseline is lost with it.
