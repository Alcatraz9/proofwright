---
title: EdgeForge
emoji: 🔧
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: Autonomous test orchestration — a URL in, a working suite out
---

# EdgeForge

**Point it at a web application. It plans the tests, writes them, runs them, repairs
the ones the interface broke, and tells you what it could not cover.**

```bash
curl -X POST http://localhost:7860/api/missions \
  -H 'content-type: application/json' \
  -d '{"targetUrl": "https://your-app.example.com"}'
```

A URL is the only required input. What comes back is a working test suite, executable
Playwright files on disk, and a report that is honest about its own gaps.

---

## The distinction the product is built on

Every failure is asked one question: **did we fail to find the element, or did we fail
to get the expected result?**

- Could not *find* it → the test is stale → repair it.
- Acted, and the *outcome* did not follow → the application is wrong → escalate, never
  repair.

A self-healing tool that repairs everything eventually rewrites your suite until it
passes, which is the opposite of what a suite is for. **The refusal is the feature.**

That split is deterministic, not a guess: two failure kinds are healable, twelve are
not, and application health is classified *before* any locator reasoning — so a 500
that empties a page is never diagnosed as a renamed button. Every classification keeps
the evidence it was made from.

---

## What a mission does

Six stages, driven by one orchestrator, with no human in between:

| Stage | What happens |
|---|---|
| **Explore** | Crawls the application breadth-first, signs in when it finds a login form, and describes every form it finds — including the negative tests each one invites. Makes no model calls. |
| **Plan** | Turns your intent, a requirements document, or the crawl itself into a step plan where every step traces to something observed. |
| **Evaluate coverage** | Scores what the plans miss, then sends itself *back* to plan for the gaps. Deterministic and reproducible. |
| **Generate** | Resolves every step against the live DOM. A locator is written only once proven to match exactly one element; an assertion only once the browser was observed to satisfy it. |
| **Execute** | Replays deterministically and heals stale locators, verifying each repair against the application's own response. |
| **Report** | Synthesises scenarios, verdicts, repairs, remaining gaps, untested-flow risk, and a quality score that always shows its parts. |

The orchestrator records what it decided at every boundary and why. On the bundled
fixture a typical mission looks like this:

```
[explore]           ok      2887ms   Mapped 5 pages, 3 forms, 3 negative-path opportunities
[plan]              ok      3717ms   Planned 4 steps as "sign-in-flow"
[evaluate_coverage] ok               Scored coverage 0.10 with 8 gaps
[evaluate_coverage] retried 2932ms   Re-planned for 3 gaps as "sign-in-validation-tests"
[evaluate_coverage] ok               Scored coverage 0.55 with 5 gaps
[generate]          ok     43484ms   Resolved 4 steps against the live application
[execute]           ok     33981ms   "sign-in-flow" finished as passed
[execute]           ok      5237ms   "sign-in-validation-tests" finished as passed
[report]            ok               Reported 2 scenarios at quality 0.75

VERDICT: passed
```

Coverage rising across re-plan rounds is the orchestrator deciding it was not finished.

---

## What you get back

**A quality report**, as JSON or markdown:

- Every scenario, its kind (primary journey, refusal path, boundary value), and its verdict
- Repairs made, with confidence, what changed, and how the repair was verified
- **Coverage gaps remaining** — what the application affords that nothing tests
- **Untested flows ranked by risk**, each carrying the arithmetic behind its score
- A quality score that never appears without the parts it was computed from

**Executable Playwright specs** in `tests/generated/`, which run standalone:

```
✓  tests/generated/sign-in-flow.spec.ts › Sign In Flow (232ms)
✓  tests/generated/sign-in-validation-tests.spec.ts › Sign In Validation Tests (313ms)
2 passed
```

The locators in those files were proven against the running application, and the
assertions were derived from what the browser actually did. Most generated suites ship
selectors nobody executed.

**Per-page analysis** beyond pass and fail: what changed visually and *what kind* of
change it was, an accessibility score, and a passive security read.

---

## Run it locally

```bash
git clone <this repo> && cd edgeforge

cp env.example .env          # add SARVAM_API_KEY — see Configuration below
npm install
npm run web:install
npm run web:build

npm run llm:check            # confirms the key, the model, and schema enforcement
npm run serve                # http://127.0.0.1:7860
```

Requires **Node 22.13.0 or newer** (see `.nvmrc`; run `nvm use`). Two separate
things set that floor:

- The server imports the `node:sqlite` builtin, which is unflagged only from
  22.13.0. It was never backported to Node 20, so no Node 20 release can run it.
- Vite 8 and its `rolldown` native bindings require `^20.19.0 || >=22.12.0`. On an
  older 22.x, npm silently skips optional dependencies whose `engines` do not match
  the running Node, so the build fails later with `Cannot find native binding`
  rather than at install time.

Both packages declare the floor, so a mismatch says so plainly.

If `npm install` fails on your platform with a missing package it cannot find in
the lockfile, delete both lockfiles and install again; npm prunes
platform-specific subtrees it does not need on the machine that wrote them:

```bash
rm package-lock.json web/package-lock.json
npm install && npm run web:install && npm run web:build
```

Open `http://127.0.0.1:7860` and start a mission from the dashboard, or:

```bash
# The bundled fixture app is served by this same process, so this works immediately
curl -X POST http://127.0.0.1:7860/api/missions \
  -H 'content-type: application/json' \
  -d '{"targetUrl": "http://127.0.0.1:7860/app/"}'
```

A mission takes a few minutes on a free API tier. Poll it, or watch it in the dashboard:

```bash
curl http://127.0.0.1:7860/api/missions/<missionId>
curl http://127.0.0.1:7860/api/missions/<missionId>/report.md
```

### With Docker

```bash
docker build -t edgeforge .
docker run -p 7860:7860 --env-file .env edgeforge
```

---

## Optional inputs

`targetUrl` is the only required field. Each of these narrows or informs the work:

```jsonc
{
  "targetUrl": "https://your-app.example.com",
  "instruction": "focus on checkout and authentication",  // plain-English scope
  "prd": "Shoppers must be able to...",                   // requirements document
  "credentials": { "TEST_EMAIL": "...", "TEST_PASSWORD": "..." },
  "mode": "autonomous"                                     // or "supervised"
}
```

Given a `prd`, the report also says which **stated requirements** nothing verifies —
a different question from what the application affords and nothing exercises.
Requirements a browser test cannot settle, such as a latency budget, are reported as
such rather than as gaps.

`mode: "supervised"` stops after planning and waits for a human to approve, which is
the original workflow and still available.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/missions` | Start a mission. Returns a `missionId` immediately. |
| `GET` | `/api/missions` | Recent missions, newest first. |
| `GET` | `/api/missions/:id` | Status, current stage, and the full decision log. |
| `POST` | `/api/missions/:id/cancel` | Stop a running mission. |
| `GET` | `/api/missions/:id/report` | The quality report, as JSON. |
| `GET` | `/api/missions/:id/report.md` | The same report, as markdown. |

Per-run endpoints (`/api/runs`, `/api/runs/:id/stream`) drive the live run view and
stream events over SSE. `/api/health` reports server, queue and dashboard state.

---

## The application under test ships with it

Seven versions of a deliberately fragile shop are served from the same process, so the
healer can be demonstrated without needing a second application:

| Version | What changed |
|---|---|
| v1 | The baseline everything else diverges from |
| v2 | Accessibility improvements |
| v3 | Hardened markup |
| v4 | A redesign that renames and moves things |
| v5 | Broken login — a real defect, which must **not** be healed |
| v6 | A removed feature |
| v7 | A price change — a data regression, not a locator problem |

Switch versions from the dashboard, then re-run a mission and watch what gets repaired
and what gets escalated. That contrast is the demo.

---

## Configuration

Everything lives in `.env` — see `env.example`, which documents each value.

**Model provider.** Sarvam is the default. It is the only one of the three whose
ceilings are per *minute* rather than per day — 40 requests a minute on the starter
tier — and its 128K context is the only one that fits a requirements document
alongside a site map.

```bash
LLM_PROVIDER=sarvam
SARVAM_API_KEY=sk_...
SARVAM_MODEL=sarvam-105b
```

Either Sarvam chat model constrains structured output, so `SARVAM_MODEL` can be changed
without losing the planner's guarantee that it cannot emit an invalid action:
`sarvam-105b` (128K) or `sarvam-105b-conversations` (32K, dialogue-tuned).
`SARVAM_REASONING_EFFORT` (`low` by default) bounds how much of the completion budget
the model spends thinking before it writes any JSON — every call here is extraction
against a schema, and reasoning tokens come out of the same budget as the output.

Two alternatives, both worse for this workload:

```bash
LLM_PROVIDER=groq   GROQ_API_KEY=gsk_...  GROQ_MODEL=openai/gpt-oss-20b
LLM_PROVIDER=gemini GEMINI_API_KEY=...    GEMINI_MODEL=gemini-2.5-flash
```

Groq caps a request at 8,000 tokens — a full PRD plus a full map exceeds it and is
refused with a 413 that no retry helps — and `GROQ_MODEL` must stay on one of
`openai/gpt-oss-20b`, `openai/gpt-oss-120b` or `qwen/qwen3.8-27b`, the only models
whose structured output is constrained rather than best-effort. Gemini's free tier
allows **20 requests per day** against a mission that spends 10–15.

`npm run llm:check` reports which provider, model and decoding mode you are actually
in — run it before a demonstration, not during one.

### Deploying to Hugging Face Spaces

The YAML front matter at the top of this file declares `sdk: docker` and
`app_port: 7860`. Set these as Space **secrets**, not files:

| Secret | Why |
|---|---|
| `SARVAM_API_KEY` | Planning, locator resolution, and healing |
| `TEST_EMAIL`, `TEST_PASSWORD` | The fixture's login. Without them the crawl stops at the sign-in form. |

The container filesystem is writable but ephemeral, so a restart is a cold start —
which is why the repository ships a seeded plan, baseline and repair cache. Cold start
on a Playwright base image is slow; warm the Space before demonstrating it.

---

## Commands

| Command | What it does |
|---|---|
| `npm run serve` | Start the server and dashboard |
| `npm run llm:check` | Verify the API key, model, and schema enforcement |
| `npm run explore -- --url <url>` | Crawl a URL and print the site map. Makes no model calls, so it is free to run repeatedly |
| `npm test` | Unit tests |
| `npm run web:build` | Rebuild the dashboard |
| `npx playwright test` | Run the specs a mission generated |

The server preloads the dashboard bundle at boot, so restart it after `web:build`.

---

## Further reading

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the orchestration flow between
  sub-agents, the heal-or-escalate decision, and the layout of the code
- **[docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md)** — requirements mapped to what the
  code does, with the measured free-tier limits
- **[docs/CASES.md](docs/CASES.md)** — every case handled, with the verdicts actually
  produced
- **[docs/DEVELOPMENT-LOG.md](docs/DEVELOPMENT-LOG.md)** — the real defects found while
  building this, and what each one taught
- **[DESIGN.md](DESIGN.md)** — the dashboard's design system

---

## Limits

Stated plainly, because a testing tool that overstates itself is worth nothing:

- **A mission takes minutes, not seconds**, on a free API tier. Most of that is waiting
  on rate limits.
- **Coverage matching is a heuristic.** Plans describe their targets in prose, which
  does not join cleanly to a DOM inventory, so a plan that tests something in different
  words can read as uncovered. The report discloses how it matched, and errs toward
  reporting a gap rather than claiming coverage.
- **The crawl reads and never acts.** It describes forms without submitting them and
  records destructive controls without operating them, so what sits behind a
  multi-step flow may go unmapped.
- **A scenario can end `not_run`** — no executable baseline was produced. That is not a
  failure of the application, and the report says so.
- **One run at a time** by default. Each run drives a real browser at two viewports.

## Provenance

The original prototype — intent plans, baselines, replay and healing — was written by
[@sankethn](https://github.com/sankethn), and those commits open this repository's
history. Everything from the autonomous orchestrator onward builds on that foundation.
