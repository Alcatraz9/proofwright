# Remaining work, and what must not be broken

Continuity document. Written so that the reasoning behind decisions in this project
survives a context reset — the failure mode being a later session that rebuilds something
carefully considered into something mediocre because the reason was never written down.

Read alongside `docs/UI-BRIEF.md` (the dashboard, being built separately),
`docs/DEVELOPMENT-LOG.md` (defects and their lessons) and `docs/CASES.md` (demo material).

**State at time of writing:** branch `feat/qa-platform`, 11 commits, nothing pushed.
Typecheck clean, 24 unit tests passing. Verified against a live server end to end.

---

## Part 1 — Remaining work, in priority order

### A. Demo-readiness gaps (do these before deployment)

Both were confirmed by simulating a cold container, not assumed.

#### A1. A fresh container has no baseline screenshots

`seedIfEmpty()` restores the plan and baseline from committed JSON. It does **not**
restore the baseline element screenshots, which are written to `DATA_DIR/artifacts` at
record time — and `data/artifacts/` is gitignored.

Consequence: on a fresh Hugging Face container the first heal reports
`shots.baseline: null`, so the heal card — the single most persuasive thing in the
interface — has no "before" image. The "after" still works, because it is captured
during the run.

**Fix.** Introduce committed seed artifacts, parallel to the existing seed JSON:

- Write baseline shots to `data/seed-artifacts/baselines/<planId>/<stepId>.png` when
  `record:fixture --export` is used, and commit them. Nine PNGs, roughly 5KB each.
- On cold start, copy `data/seed-artifacts/` into `PATHS.artifacts`, or have the serving
  route fall back to the seed location when a file is absent from the writable one. The
  copy is simpler and keeps the serving route's single containment check intact — prefer
  it.
- Keep `data/artifacts/` gitignored. The seed directory is *source*; the artifacts
  directory is *state*. That distinction already exists for `SEED_PATHS` versus
  `DATA_DIR` and was itself the fix for a real defect (see log entry 4) — do not collapse
  them again.

#### A2. A fresh container has an empty heal cache

Same shape of problem. The cache lives only in the database, so a fresh container pays a
model call for the first heal of every scenario. On a key with a twenty-per-day ceiling
that is the difference between a demo that works all afternoon and one that stops.

**Fix.** Export cache entries to `data/seed-heal-cache.json` and import them during
seeding. The signature already includes the identities of every element on the page, so a
committed entry hits only while the fixture is unchanged — and if the fixture changes the
signature changes, the cache misses, and the model is asked afresh. That is the correct
failure direction and it is already the implemented behaviour.

Committing model output is honest here **provided the interface keeps reporting
`proposalFromCache: true`**. A reused answer presented as a fresh one would overstate what
happened, which is exactly the sort of small dishonesty this project has otherwise avoided.

#### A3. The price-change release can only demonstrate half its point

`v7` exists to show that one application change produces two opposite and equally correct
verdicts:

| The test says | Result |
|---|---|
| "confirm the order total is shown" | passes — identity comes from the label beside the amount |
| "confirm the total is £49.00" | fails `OUTCOME_NOT_MET`, never healed |

Only the first is demonstrable today, because `fixture-checkout` deliberately records
`expectedValue: null`. The second needs a second plan that asserts the literal value.

**Fix.** A `fixture-checkout-strict` plan, identical but with `expectedValue: "£49.00"` on
the `assert-total` step, recorded and committed the same way. Running both against `v7`
side by side is one of the strongest things this system can show: **the tool did not
decide whether a price change is a failure — the test author did.**

Note this cannot be done by editing the JSON by hand and hoping. `expectedValue` is
grounded against the instruction text during generation, so the plan's `sourcePhrase` and
instruction must actually contain the literal. Extend `record-fixture.ts` with a second
recipe set rather than post-editing.

---

### B. Deployment

Nothing here is built. The design is settled; these are the details that will otherwise be
rediscovered painfully.

#### Dockerfile

Base off `mcr.microsoft.com/playwright:v1.62.1-jammy` — the browsers are preinstalled,
which avoids a ~115MB download and the apt dependency dance at build time. Match the tag
to the `playwright` version in `package.json` or the browser and the client disagree.

Multi-stage: build `web/` with a node image, then copy `web/dist` into the Playwright image
alongside `src/` and `node_modules`. The server runs through `tsx`, so no compile step is
needed for the backend.

#### Hugging Face Spaces specifics

- `Dockerfile` at the repo root, and YAML front matter in `README.md` with `sdk: docker`
  and `app_port: 7860`. Without the front matter the Space will not build as Docker.
- `HOST=0.0.0.0` **in the container only.** The default is `127.0.0.1` deliberately, so a
  developer machine does not expose a browser-driving service to its network. Do not change
  the default to make the container work.
- `GEMINI_API_KEY` as a Space **secret**. The repo is public. Never commit `.env` — it is
  gitignored, keep it that way.
- The filesystem is writable but **ephemeral**: a restart is a cold start. That is why
  seeding exists, and why A1 and A2 matter.
- Cold start on a Playwright base image is slow. Warm the Space before judging.
- `RUN_CONCURRENCY` stays at 1. Each run drives a real Chromium at two viewports; raising
  it does not degrade gracefully on a small container, it gets the container OOM-killed the
  first time two people press Run.

#### Static serving

The Node process must serve `web/dist`, mounted **last** so it cannot shadow `/api`,
`/artifacts` or `/app`. Route order in `createServer` is currently `api` → `artifacts` →
`fixture` → 404; the static handler goes immediately before the 404, with an SPA fallback
to `index.html` for unmatched non-file paths.

---

### C. Optional depth, if time allows

- **Playwright trace viewer per run.** `context.tracing.start({ snapshots: true,
  screenshots: true })` produces a professional DOM-level time-travel debugger for about an
  hour of work. It will not match the dashboard's design, which is why it belongs behind an
  "Open full trace" link rather than in the main flow. Excellent depth-on-demand for a
  technical question during judging.
- **Pixel diff as a supporting number.** `pixelmatch` + `pngjs`, both pure JS. Deliberately
  deferred: the structural comparison is the verdict and a percentage adds nothing to it.
  If added, present it as corroboration, never as the classification.
- **CI.** `npm run typecheck && npm test && npm run drill` is the natural gate. `drill`
  needs a running server, so it needs the fixture app up first.

---

## Part 2 — Invariants. Breaking any of these degrades the product

Each of these exists because of a specific failure. They are cheap to break by accident
and expensive to notice.

### Tests must target `/app`, never `/app/vN`

Every baseline step records the URL it ran on, and the replay refuses to act when the
browser is elsewhere — the check that stops an expired session being "healed" into
pointing at a login form. `samePageShape` normalises numeric and UUID segments but `v1`
and `v2` are ordinary words, so a baseline recorded against `/app/v1` and replayed against
`/app/v2` reports `PAGE_DIVERGED` on every step and **healing is never attempted at all**.

`/app` serves the active release; `/app/v1`…`/app/v7` exist for humans to compare. If a
future change puts the version into the tested URL, the headline demo silently dies.

### The visual pass reports; the functional layer decides

Visual findings must not fail a run outside `strictVisual` — and today they do not:
`shouldFail()` returns false unless strict, so **nothing visual fails a run in the default
mode**, missing content included. Two reasons, both learned the
hard way (log entry 6): when an element a step needs disappears, the step already fails, so
failing again lets the less-informed analysis overturn a healed, verified, passing run —
and because an element's visual identity includes its accessible name, a *correct*
accessibility fix reads as elements vanishing. Making visual findings gate by default
punishes the remediation the tool exists to encourage.

### Any new field on a persisted schema needs a default

This project hit the same bug three times in different clothing (log entries 2, 3, 12): a
value that survives one boundary and not the next. `z.nullable()` requires the key to be
present; it does not make it optional. Adding a required field to `baselineStepSchema` or
`intentPlanSchema` makes every previously stored artifact silently unparseable, and
`safeParse` in the seed loader will skip it without a word.

Use `.default(...)`. And remember a schema and its **storage** are two separate contracts:
`visualBaselines` was added to the schema but not to the `baselines` table, so it was
dropped on write and defaulted back on read.

### An assertion about a step's own element follows the locator that found it

If a fallback rescues a step, the assertion must be rebound (`rebindOutcomeToUsedLocator`).
Without it a successfully filled field reports itself empty, classifies `OUTCOME_NOT_MET`
— which is not healable — and a stale locator becomes an application failure that stops the
run. Six regression tests cover this; do not delete them.

### Healing and the visual pass must agree

Any element a step located **by any means** — primary, fallback or heal — is reconciled into
the visual pass, because locating it proves it is still present. Reconciliation must use the
same identity precedence as `stableKey` (via `stableKeyFromFingerprint`), not a
reimplementation: keying on role and accessible name alone misses the one case that matters,
a control with no accessible name, which is precisely what accessibility remediation
replaces.

And visual verdicts are computed at the **end** of a run, not as each page is reached,
because the heal that explains a vanished control happens on a later step.

### A heal that cannot be verified is flagged, not hidden

A step with no recorded post-condition gives the healer nothing to check against, so its
outcome "held" only because there was nothing to hold. Those runs are `needs_review` and the
event carries `verifiedAgainstOutcome: false`. Presenting such a heal as confirmed would be
the one claim this system must never make loosely.

### Credentials are referenced by name, never by value

Plans store `valueRef: "TEST_PASSWORD"`. The value never enters a plan file, a prompt, or a
log line. Security findings that match a credential print a truncated sample
(`AIzaSyD3mo...`) because a finding that prints the secret has copied it into the run record
and every log that record reaches.

### The security audit stays passive

No injection, no fuzzing, no probing. The moment this becomes active it is a scanner, and a
scanner pointed at a URL somebody typed into a text box is a tool for attacking third
parties. If active checks are ever wanted they need an explicit ownership gate, not a flag.

### Re-record the baseline after changing the fixture app

The committed baseline is recorded against `v1`. Changing markup, ids, labels or layout in
`src/fixtures/` without re-running `npm run record:fixture -- --base ... --export` leaves a
baseline that fails for reasons unrelated to anything being demonstrated. This will look
like a broken product.

### `v6` keeps `duplicateCatalogue: false`

A run halts at its first failure. Duplicating the catalogue makes an earlier step's locator
ambiguous, which masks the removed-feature case `v6` exists to show — the healer being asked
and correctly declining. `LOCATOR_AMBIGUOUS` is covered by `npm run drill`, which mutates a
baseline in memory and can isolate one verdict at a time.

---

## Part 3 — Operational knowledge worth not rediscovering

**Model quota is the binding constraint.** It is per model, per day. `gemini-3.7-flash`
allows **20** generate-content requests a day, which is enough to develop against and not
enough to demonstrate with, and the ceiling is invisible until it is hit — at which point
healing simply stops working mid-run. `gemini-2.5-flash` and `gemini-flash-latest` have
their own buckets and work. `npm run models` probes what a key can reach; each probe costs
one request against the model it probes.

Retry distinguishes a burst limit from a daily ceiling by the quota id in the error body. A
daily ceiling is not retried, because it is not transient.

**Replay costs nothing.** Only plan generation, baseline recording and healing call the
model. A viewer pressing Run on a green test is free. This is the architecture absorbing the
constraint well, and it is worth saying out loud during judging.

**Runs execute in-process**, not in a child process. `queue.ts` calls `executeRun` directly.
An earlier plan said child-process isolation; the implementation does not do that. It means a
crash in a run can take the server down, which is a known and accepted trade for the
hackathon.

**Development environment.** Node 22.18 (`node:sqlite` works without a flag, emitting an
experimental warning). Chromium installed at `~/.cache/ms-playwright` via
`npx playwright install chromium`.

**Managing dev servers.** Do not use `pkill -f "tsx src/server/main.ts"` — the pattern
matches the shell running the command and kills it. Find the process by PID from
`ps -eo pid,args | grep server/main` instead.

**Isolating fixture tests.** Heals mutate the baseline, so running releases back to back
lets one release's repair leak into the next and produces confusing results. Re-record
between runs when comparing releases.

---

## Part 4 — Explicitly out of scope

Stated so nobody spends hackathon time on them:

- Suite running. One plan per run, no parallelism, no aggregate report.
- Session reuse. Every run starts cold, so a long flow repeats its login.
- Iframe and shadow-DOM traversal. Counted and warned about at record time, not solved.
- Assertions for the absence of something ("no error banner appeared").
- Per-element visual absorption. Absorption is per page and all-or-nothing, so a page with
  one layout shift re-reports its cosmetic changes next run.
- Authentication and multi-user. Single shared anonymous instance is sufficient.
- PostgreSQL or any server database. SQLite is a file and that is the point.

---

## Part 5 — Suggested demo run-of-show

Roughly six minutes, ordered so each beat builds on the last.

1. **Write a test in English.** Show the generated plan as `DRAFT`, edit a step, point out
   that editing returned it to `DRAFT`. Approve. *The human decides what the test means.*
2. **Run it against v1.** Nine steps green. Note the scores: accessibility **10**, security
   **29**. *The test passes and the application is still poor.*
3. **Switch the active release to v2 — "we shipped an accessibility fix."** Accessibility
   **100**. One step went red and healed itself. Open the heal card: `css="#search-go"` →
   `role=button[name="Search products"]`, the two screenshots side by side, the model's
   reason, and what the application confirmed afterwards.
   *This is the argument.* The fix gave the control a name; the old locator had nothing
   better to match on; the replacement is **more durable than the original**. A tool that
   went red here would teach the team not to fix accessibility.
4. **Switch to v3 — "we hardened it."** Security **29 → 100**, and nothing else moves. *The
   analyses are independent.*
5. **Switch to v4 — the redesign.** Two heals. The restyle is absorbed as cosmetic; the
   moved summary panel is reported as a layout shift with the pixel delta. *A colour change
   is not a failure; a moved panel is worth knowing about. A pixel diff cannot tell those
   apart.*
6. **Switch to v5 — broken login.** Red, `OUTCOME_NOT_MET`, and healing is **on**. The
   healer was never consulted. *This is the part that matters. A self-healing tool that
   repairs everything eventually rewrites your suite until it passes.*
7. **Switch to v6 — checkout removed.** The healer is asked and returns nothing.
   *Declining is a correct answer.*
8. **Close on v7 if time allows**, with both plans: same price change, one passes and one
   fails, and the tool did not decide which — the test author did.

Keep step 6 even if time is short. It is the credibility beat.
