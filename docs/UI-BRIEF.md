# Dashboard UI — build brief

Written as a handoff so the UI can be built in a fresh session with no prior chat
context. Everything the front end consumes already exists, is committed, and has been
exercised against a live server. Nothing below needs backend work first unless it says
so explicitly.

**Repo state:** branch `feat/qa-platform`, 10 commits, nothing pushed. Typecheck clean,
24 unit tests passing. `origin` is configured as
`https://github.com/sankethn/qa-prototype`; the user pushes from a different account.

**Read first:** `README.md` for what the system does, `docs/CASES.md` for the demo
narrative, `docs/DEVELOPMENT-LOG.md` for the defects and why the design is shaped as it
is. The UI should make the reasoning in those documents visible.

---

## Decisions already made

Confirmed with the user; do not revisit without asking.

- **Single TypeScript service.** The dashboard is served by the same Node process that
  serves the API and the app under test. One port, one container, no CORS.
- **SSE, not WebSocket.** Everything streams one way. `EventSource` reconnects on its
  own and resumes correctly via `Last-Event-ID` — the server already honours it.
- **No live view of the application under test.** No iframe, no CDP screencast. The user
  explicitly rejected this: a mirrored viewport is unstable on a free host and competes
  with the console for attention. Instead, a heal shows **two still screenshots**.
- **Vite + React + Tailwind**, built into static assets and served by the Node process.
  Nothing exists yet — `web/` has not been created. Tailwind via the build, not a CDN.
- **Deployment target is Hugging Face Spaces, Docker, free tier.** Public repo.
- Professional visual design with scroll animations was explicitly requested. It should
  look like a product, not a debug page.

---

## What already works (do not rebuild)

Verified against a running server:

- Nine-step recorded baseline replays against seven fixture releases with correct
  verdicts throughout.
- Self-healing accepted, verified against the original recorded outcome, and written
  back with an audit trail. Revert works and is idempotent.
- Healing correctly **declines**: `no_candidate` on a removed feature, and is never even
  consulted for an application failure.
- Visual classification into four verdicts, at two viewports, with zero false positives
  on an unchanged app across two consecutive runs.
- Accessibility 10 → 100 across the remediation release; security 29 → 100 across the
  hardening release.
- Heal-proposal cache: first run makes live model calls, later runs make none and still
  heal and pass.
- Before/after heal screenshots, cropped and outlined, served over HTTP with a
  traversal-guarded route.

---

## Server contract

Start it with `npm run serve` → `http://127.0.0.1:7860`. A fresh database seeds itself
from committed data, so there is always a plan called `fixture-checkout` that is already
approved and already recorded.

### REST

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Active release, armed faults, queue state, concurrency |
| GET | `/api/fixture` | All seven releases with `id`, `displayName`, `story`, `demonstrates[]`, `accessibility`, `security`, `url` |
| POST | `/api/fixture/version` | `{"version":"v4"}` — **this is the "simulate a deploy" control** |
| POST | `/api/fixture/fault` | `{"kind":"serverError"\|"slow"\|"expireSession","on":true}` — fires once |
| GET | `/api/plans` | Summaries: status, step count, `hasBaseline`, `lastRunStatus`, `lastRunAt` |
| GET | `/api/plans/:id` | `{ plan, baseline: { steps[...] } \| null, runs[] }` |
| PATCH | `/api/plans/:id` | `{ plan }` — validated against the same schema the model's output is. Returns 400 with `issues[]` on failure. **Any edit returns the plan to DRAFT** |
| POST | `/api/plans/:id/approve` · `/unapprove` | The review gate |
| DELETE | `/api/plans/:id` | Deletes the baseline too |
| POST | `/api/baselines/:planId/steps/:stepId/revert` | Undo a heal. Returns `{reverted:boolean, reason?}` |
| GET | `/api/runs?planId=&limit=` | Run summaries |
| POST | `/api/runs` | `{planId, heal?, threshold?, strictVisual?}` → `202 {runId, queuePosition, stream}` |
| GET | `/api/runs/:id` | `{ summary, result, events[], artifacts[] }` — full history for a finished run |
| POST | `/api/runs/:id/cancel` | |
| GET | `/api/runs/:id/stream` | **SSE** |
| GET | `/api/stats?limit=` | `passRate`, `totalHeals`, `totalLlmCalls`, `avgDurationMs`, `trend[]` oldest-first |
| GET | `/artifacts/<relPath>.png` | Screenshots. Immutable, cached hard |

### SSE

`GET /api/runs/:id/stream`. Each frame carries `id:` (the sequence number) and `event:`
(the type), and `data:` is `{ seq, at, type, payload }`.

Events already persisted are **replayed on connect**, so a client that opens the stream
late — or reconnects — sees the whole run, not the remainder. The stream closes itself
after `STREAM_END`, and opening a stream against an already-finished run replays its
history and then closes.

Event types, in the order a run produces them:

| Type | Payload highlights |
|---|---|
| `RUN_QUEUED` | `position`, `ahead` |
| `RUN_STARTED` | `planId`, `startUrl`, `steps`, `healing`, `threshold`, `activeVersion`, `rebasedFrom` |
| `STEP_STARTED` | `stepId`, `action`, `index`, `total` — **use this to show a step in progress** |
| `STEP_PASSED` / `STEP_FAILED` | `stepId`, `action`, `status`, `durationMs`, `locator`, `usedFallback`, `outcomeChecked`, `failure:{kind,healable,message}` |
| `DRIFT_DETECTED` | `stepId`, `locator` — passed, but only via a fallback |
| `STEP_SKIPPED` | `stepId` |
| `HEALING_STARTED` | `stepId` |
| `HEAL_ACCEPTED` | `stepId`, `confidence`, `threshold`, `reason` (**the model's own words**), `verification`, `model`, `previousLocator`, `newLocator`, `candidatesProposed`, `candidatesTried`, `verifiedAgainstOutcome`, `proposalFromCache`, `shots:{baseline,found}` |
| `HEAL_REJECTED` | Same shape; `status` is one of `rejected` `below_threshold` `no_candidate` `unlocatable` `execution_failed` |
| `HEAL_ERROR` | `stepId`, `message` — the heal could not run; the step keeps its original classification |
| `HEAL_ESCALATED` | `healedSoFar`, `cap`, `message` — past 3 heals the healer is not consulted |
| `VISUAL_CAPTURED` | `pagePath`, `viewport`, `elementCount` — live, as each page is measured |
| `VISUAL_CHECKED` | `pagePath`, `viewport`, `cosmetic`, `layoutShift`, `missing`, `replaced`, `added`, `clean`, `absorbed`, `findings[{kind,severity,key,summary,movedBy,resizedBy,changes[]}]` |
| `VISUAL_COSMETIC_HEALED` | `pagePath`, `viewport`, `count`, `examples[]` |
| `VISUAL_LAYOUT_SHIFT` | `pagePath`, `viewport`, `count`, `strict`, `examples[]` |
| `A11Y_CHECKED` | `pagePath`, `score`, `passes`, `byImpact{critical,serious,moderate,minor}`, `violations[{id,impact,help,helpUrl,tags,nodeCount,samples}]` |
| `SECURITY_CHECKED` | `pagePath`, `score`, `bySeverity{high,medium,low,info}`, `findings[{id,severity,title,detail,evidence,remediation}]` |
| `RUN_COMPLETE` | `status`, `verdict`, `stepsTotal`, `stepsPassed`, `healed`, `healAttempts`, `escalated`, `unverifiedHeals[]`, `drifted[]`, `a11y{score,violations,pages}`, `security{score,findings,pages}`, `visual{pagesCompared,pagesRecorded,cosmeticAbsorbed,layoutShifts,missing,failed,strict}` |
| `RUN_ERROR` | `message`, sometimes `stepId` and `fatal:false` for a non-fatal inspection failure |
| `STREAM_END` | `null`. Close the stream on this |

**One ordering fact that affects the UI.** `A11Y_CHECKED`, `A11Y_STEP_CHECKED` and
`SECURITY_CHECKED` arrive **during** the walk, as each page and step is reached. Only
`VISUAL_CHECKED` is deferred to the end of the run, because visual classification cannot
be decided until every heal is known (see defect 7 in the development log).
`VISUAL_CAPTURED` fires live and is the only visual signal during the walk.

So the accessibility and security panels fill progressively; the visual panel should read
as pending until run end rather than as empty.

*(An earlier revision of this brief claimed all three were deferred. That was wrong, and
the UI implementation was right to handle both.)*

---

## Screens to build

### 1. Run console — the primary screen, build first

Two columns. **No app viewport.**

**Left: the step timeline.** Driven entirely by SSE.

Each step is a row: action, step id, status, duration, and the locator that was used
with its strategy named. A step in progress must be visibly in progress — that is what
`STEP_STARTED` is for, and it exists solely for this view. A run-level elapsed clock
ticks client-side from `RUN_STARTED`.

Row states worth distinguishing visually: passed · passed-via-fallback (**drift**, a
distinct state, not a pass) · healing in progress · healed · failed · skipped.

A failed row shows `failure.kind` prominently and, critically, **whether it was
healable** — that distinction is the product. `OUTCOME_NOT_MET` and `ELEMENT_NOT_FOUND`
should not look the same.

**A healed row expands into the heal card**, which is the centrepiece:

- `previousLocator` → `newLocator`, with both strategies named
- **the two screenshots side by side**, from `shots.baseline` and `shots.found`, loaded
  as `/artifacts/<relPath>`. Left is what the test was recorded against; right is what
  the healer chose. Label them that way. Both are cropped and outlined already — render
  the locator as selectable text beneath each, not on the image
- `confidence` against `threshold`, presented as an **admission filter, not proof**
- `reason` — the model's own words, verbatim
- `verification` — what the application confirmed afterwards
- `proposalFromCache` — say so when true; a reused answer presented as fresh overstates
  what happened
- `verifiedAgainstOutcome: false` — flag it. The heal rests on the model's judgement
  because the step had no post-condition
- a **Revert** button → `POST /api/baselines/:planId/steps/:stepId/revert`

**Right: the analysis panels.** Accessibility score, security score, visual summary.
Populate at run end. Each expands to per-page findings; security findings carry
`remediation`, accessibility violations carry `helpUrl`.

The accessibility panel should carry the argument explicitly, and it no longer has to
invent it: `A11Y_STEP_CHECKED` publishes the per-element findings for the control each
step drove, each carrying a `testabilityNote` in the payload. Render it verbatim.

Two checks distinguish cases that matter: `accessibleName` means the control has no name
at all, and `placeholderOnlyName` means its only name is a placeholder — which is copy,
and which disappears once the field has content.

### 2. Releases — the demo control

Seven cards from `GET /api/fixture`, each with `displayName`, `story` and
`demonstrates[]`. One is active. Switching it is `POST /api/fixture/version` and is the
single most important control in the demo: **same URL, same recorded test, different UI
underneath**. Frame it as "simulate a deploy", not as "change fixture".

Fault buttons for `serverError`, `slow`, `expireSession` with one line each on what
verdict they provoke.

Each release links to `/app/v1`…`/app/v7` so a viewer can open two side by side.

### 3. Plans and the approval gate

List from `GET /api/plans`. A `DRAFT` plan cannot be run — enforce that in the UI as
well as relying on the 409.

The editor is the human-in-the-loop gate and should feel like one: per-step editing of
action, target description, value or `valueRef`, and expected outcome. Save →
`PATCH /api/plans/:id`, which returns 400 with `issues[]` on a schema violation — render
those against the offending step. Make it clear that **saving an edit returns the plan
to DRAFT**, because the approval applied to what was reviewed.

Then Approve → run.

### 4. History and trends

`GET /api/stats` returns `trend[]` oldest-first, ready to plot. Pass rate, heals over
time, model calls, average duration. `GET /api/runs/:id` returns a finished run's whole
event list, so the console screen should render from history identically to how it
renders from the stream — build it to consume one array of events either way, and the
replay-a-past-run feature is free.

---

## Guidance on presentation

The system's distinguishing quality is that it is careful about what it claims. The
interface should carry that rather than undercut it:

- Never show a heal without showing what verified it.
- Never show a visual finding without its kind. `COSMETIC` and `LAYOUT_SHIFT` mean
  different things and a single "3 changes" badge destroys the whole point.
- Show the scores as the **worst page**, which is what they are, not as an average.
- `healable: false` deserves as much visual weight as a heal. Refusing to repair a
  broken application is the feature.

Good moment to design around: the v2 release. Accessibility climbs 10 → 100, and the
locator that broke was `css="#search-go"` — the least durable strategy available, and
only available because the control had no accessible name. The heal replaces it with
`role=button[name="Search products"]`, which is *more durable than the original*. The
accessibility fix is the reason the better locator exists. If the UI makes one thing
land, make it that.

---

## Practical notes

- `npm run serve` for the API; the Vite dev server should proxy `/api`, `/artifacts` and
  `/app` to `127.0.0.1:7860`.
- The Node server needs a static handler for the built `web/dist`, mounted last so it
  cannot shadow `/api`, `/artifacts` or `/app`. It does not exist yet — add it.
- `GET /api/health` is the cheapest liveness probe.
- A run takes roughly 30–60 seconds: nine steps plus five pages inspected at two
  viewports. Design for that, not for an instant response.
- Runs queue at concurrency 1. `RUN_QUEUED` carries the position — show it, or a waiting
  run looks broken.
- Baselines recorded before screenshot capture existed have no `shots.baseline`. Handle
  null; do not render a broken image.
- Free-tier model quota is per model per day and has bitten this project twice. The cache
  means a repeated demo costs nothing, but avoid any UI that fires a heal casually.

## Still outstanding after the UI

- **Dockerfile and HF deployment.** Base off `mcr.microsoft.com/playwright:v1.62.1-jammy`
  (browsers preinstalled). Multi-stage: build `web/`, copy into the Playwright image. HF
  needs `sdk: docker` and `app_port: 7860` in README front matter, `HOST=0.0.0.0` in the
  container, and `GEMINI_API_KEY` as a Space secret — never committed, the repo is public.
- Suite running, session reuse, and iframe/shadow-DOM traversal remain out of scope.
