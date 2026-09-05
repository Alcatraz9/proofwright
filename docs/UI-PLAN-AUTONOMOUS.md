# ProofWright — UI plan for the autonomous pipeline

The backend changed shape while the redesign was in flight. This document says what
now exists, what the interface has to show that it currently cannot, and how to
decide the shape of it.

Read `docs/DESIGN-DIRECTION.md` first — the visual world is already chosen and is
not reopened here. This is about **what goes on the screen**, not what it looks like.

---

## 1. What changed

ProofWright used to be four human-driven steps: write a plan, approve it, record a
baseline, start a run. The dashboard was built for that, and it is a faithful
interface to a system that no longer works that way.

There is now a **mission**: one URL in, and the orchestrator plans, evaluates its
own coverage, re-plans for what it is missing, records, executes, heals, and writes
a report — with no human between stages. The old flow still exists in
`supervised` mode and should stay, but it is no longer the main path.

The consequence for the interface is not cosmetic. The dashboard's most valuable
screen used to be the live run. The most valuable screen now is **the reasoning**:
what the agent decided at each stage boundary and why. The hackathon rubric pays
15% for "how clearly does the team present the agent's decisions and output", and
that is currently invisible.

---

## 2. What the interface cannot currently show

Every item below is real data with no home on screen.

**The decision log.** Each mission carries an ordered list of decisions, each with a
stage, an action, a reason in plain English, an outcome
(`ok` / `skipped` / `retried` / `escalated` / `failed`), and a duration. This is the
single most important thing to render well. A worked example from a real mission:

```
[explore]           ok        2915ms   Mapped 5 pages, 3 forms, 4 negative-path opportunities
[plan]              ok                 Derived scope from the requirements and the map
[plan]              ok        4801ms   Planned 6 steps as "primary-journey"
[evaluate_coverage] ok                 Scored coverage 0.20 with 8 gaps
[evaluate_coverage] retried  35084ms   Re-planned for 3 gaps as "sign-in-refusal-tests"
[evaluate_coverage] ok                 Scored coverage 0.65 with 4 gaps
[evaluate_coverage] escalated          Left 3 gaps unfilled
[plan]              ok                 Approved "primary-journey" without a human
[generate]          ok       58238ms   Resolved 6 steps against the live application
[execute]           ok       35334ms   "primary-journey" finished as passed
[report]            ok                 Reported 3 scenarios at quality 0.86
```

Two things a reader must be able to see at a glance: coverage **improving** across
re-plans, and stages that were **skipped** with their stated reason. A stage that
announces it was not implemented is a feature, not an embarrassment — it is why the
report can be trusted.

**The site map.** Pages found, depth from the entry point, forms with their field
labels, which pages need a sign-in, destructive controls that were deliberately
never operated, links left unvisited with the reason, and whether the crawl got past
an authentication wall.

**Coverage, as a number that moves.** A mission produces a score, per-dimension
totals (pages / forms / refusal paths), a gap list with kinds
(`missing_flow`, `missing_edge_case`, `missing_error_state`, `unexplored`), and
untested flows ranked by risk with the arithmetic written out.

**Multiple scenarios per mission.** A mission is now one-to-many with plans. The
first is the primary journey; the rest exist because the coverage evaluator found
something missing. Their kinds are distinguishable: `primary_journey`,
`refusal_path`, `boundary_value`, `uncovered_flow`.

**The quality report.** Six sections, available as JSON and markdown. The score
always carries its parts and its caveats.

**Emitted test files.** Real Playwright specs on disk, executable outside the tool.

**PRD gap analysis.** Which stated requirements nothing verifies — a different
question from what the application affords and nothing exercises.

---

## 3. The API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/missions` | `{ targetUrl }` is the whole minimum. Optional: `instruction` (plain English scope), `prd` (requirements text), `credentials` (`{TEST_EMAIL, TEST_PASSWORD}` — names echo back, values never do), `mode` (`autonomous` \| `supervised`). Returns `202` with a `missionId`. |
| `GET` | `/api/missions` | Summaries, newest first, without decision logs. |
| `GET` | `/api/missions/:id` | Full mission: status, stage, decisions, planId, runId. |
| `POST` | `/api/missions/:id/cancel` | Stops the mission and whatever browser stage it has queued. |
| `GET` | `/api/missions/:id/report` | The synthesised quality report as JSON. |
| `GET` | `/api/missions/:id/report.md` | The same report as markdown, for reading or export. |

Mission status is one of `queued`, `running`, `passed`, `failed`, `needs_review`,
`cancelled`, `error`. Stage is one of `explore`, `plan`, `evaluate_coverage`,
`generate`, `execute`, `report`.

The existing plan, run, job and stats endpoints are unchanged and still power the
live run view, which remains the right screen for watching a single run stream.

**One gap to be aware of:** missions have no SSE stream yet. The existing per-run and
per-job streams still work, and a mission references its primary `runId`, so a live
run view can be reached from a mission. Mission-level progress must be polled — every
2–3 seconds is fine, the decision list only grows. If a mission stream would
materially improve the interface, say so and it will be added rather than worked
around.

---

## 4. What to decide, not what to build

Do not treat the list in §2 as a screen list. It is inventory. The question the
interface has to answer is what a QA engineer or PM actually needs from it, and there
is a real tension worth resolving deliberately rather than by default:

**A mission is both a live process and a finished artifact.** While it runs, the
useful thing is where it is and what it just decided. Once finished, the useful thing
is the verdict, the coverage gaps, and the risk ranking. Most dashboards pick one and
serve the other badly. Deciding this well is worth more than any individual widget.

Second tension: **the decision log is the product's argument for itself, and it is a
long list of prose.** A raw log is honest and unreadable; a summarised one is
readable and loses the reasoning that makes it credible. This is a genuine
information-design problem and it is where the 15% demo-clarity score actually lives.

Third: **coverage improving across re-plan rounds is the most persuasive thing the
system does** — 0.20 → 0.65 → 0.75 with refusal coverage going 0 of 4 to 4 of 4. It
is currently three lines of text in a log. That progression deserves to be legible.

Do not invent data. Everything the interface shows must come from the endpoints in
§3. If a screen needs something that is not there, ask.

---

## 5. Constraints that still bind

From `PRODUCT.md` and `docs/DESIGN-DIRECTION.md`, unchanged:

- **Name is ProofWright.**
- **The six verdict states stay semantically distinct.** A pass and a pass-via-fallback
  must never read the same. Hues are yours; the distinctions are not. Mission status
  adds `queued`, `running`, `cancelled` and `error` to that vocabulary.
- **WCAG 2.1 AA is a product requirement.** The product scores accessibility, so
  failing the standard it measures discredits the measurement.
- **Never overstate what a run established.** A repair accepted on the model's word
  alone is marked unverified, prominently. The report's `quality.caveats` array is the
  same principle: **never render `quality.overall` without them.** A 0.86 on a suite
  with no refusal coverage is a different object from a 0.86 that tests every refusal.
- **No live app viewport.** Before/after screenshots per heal instead.
- **One responsive tree per screen.** The Releases screen drifted between separate
  desktop and mobile trees three times before they were unified.
- Read the "Invariants learned the hard way" section of `docs/DESIGN-DIRECTION.md`.
  Eleven of them, each a defect that actually shipped.

New ones from the pipeline:

- **A mission can take several minutes** on the free tier — 8,000 tokens per minute
  means roughly three locator resolutions per minute. Long-running is the normal case,
  not the exception, and an interface that looks hung after thirty seconds is wrong.
- **A scenario can be `not_run`**, which is neither a pass nor a failure. It means no
  executable baseline was produced, and it must not be rendered as a test failure —
  the report is explicit that it is not a failure of the application.
- **Gaps of kind `unexplored`** are facts, not work items: a form with no submit
  control, a page beyond the crawl budget. They should not read as things somebody
  forgot to test.

---

## 6. Verification

Unchanged, and it matters because the outgoing build was repeatedly reported as
verified when it was not:

```bash
npm run web:build && npx tsc --noEmit && npm --prefix web run typecheck && npm test
```

The server **preloads the bundle at boot**, so a rebuild alone changes nothing — kill
and restart it. Screenshot 1440×900 and 390×844 and *open the images*.

To exercise the new surfaces without waiting on a mission:

```bash
npm run explore -- --url http://127.0.0.1:7860/app/   # crawl only, zero model calls
npm run llm:check                                      # provider, model, strict decoding
```

The crawler makes no model calls, so it is free to run repeatedly. A finished mission
in the database is the best fixture for report and coverage screens.
