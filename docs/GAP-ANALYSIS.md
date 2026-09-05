# ProofWright — gap analysis against the Aivar problem statement

Source: *Bessemer Tech Catalyst — Problem Statement, AI/ML Track: Autonomous Test
Orchestration Agent*, Aivar Innovations, September 2026.

Method: three independent read-only audits of the implementation at `feat/qa-platform`,
each given the relevant requirement text and asked for `file:line` evidence. Findings below
are evidenced, not recalled. Where a requirement is unmet this document says so plainly.


> **Status, 4 September 2026.** Every must-have is now implemented and verified against
> the bundled fixture; the tables below are updated in place, with the original finding
> kept beside each so the change is auditable. What follows the tables — the
> architectural tension in §3, and the scope assessment in §6 — is the reasoning that
> produced the design and is left as written.
>
> Commits: `ed4fd99` orchestrator · `f345733` explorer · `9efc324` Groq provider ·
> `17f1454` first end-to-end pass · `4822586` coverage + gap-filling planner ·
> `364e385` report + spec emission · `d2ef383` auth reachability + PRD.

---

## 1. The headline finding

The statement's §1 names the exact gap it wants closed:

> AI-assisted testing tools can now generate test plans and executable test files from a live
> application, and repair failing tests automatically. **What they do not do is orchestrate
> these capabilities end to end** — deciding when to plan, when to generate, when to heal, and
> when to escalate — without a human directing each step. Engineering teams that adopt these
> tools still carry the coordination burden themselves.

ProofWright today **is** one of the tools that §1 describes as insufficient. It plans, generates,
executes and heals — each competently, several of them unusually well — and it requires a human
to direct every transition. The coordination burden is not reduced; it is formalised into four
commands and an approval gate.

This is not a missing feature at the edges. It is the 30% criterion, and it is the challenge.

**Where the effort has gone instead:** depth inside each stage. The healer, the failure
classifier, and the locator resolver are stronger than the statement asks for. Accessibility,
security and visual-regression analysis are not requested anywhere in the statement and exist
anyway. The build is deep where the challenge asked for breadth.

---

## 2. Requirement-by-requirement status

### Must Have

| # | Requirement | Status | Now |
|---|---|---|---|
| M1 | URL as the **sole required input**, pipeline begins autonomously | **Met** | `POST /api/missions { targetUrl }` is the whole minimum (`capability/missions.ts`). `instruction`, `prd`, `credentials` and `mode` are optional. *Was: `instruction` required at ≥8 chars, `targetUrl` optional.* |
| M2 | Planner sub-agent **explores the application**, human-readable plan covering **meaningful flows, not just happy paths** | **Met** | `explore/crawl.ts` crawls breadth-first with zero model calls, signs in when it finds a login form, and records the negative tests each form invites. The planner receives that map, so non-happy paths are grounded in observed evidence rather than invented — resolving the tension in §3 without weakening the rule. *Was: planner never opened a browser; prompt rule 6 forbade non-happy paths.* |
| M3 | **Evaluate the plan for coverage gaps before** passing to the Generator | **Met** | `coverage/evaluate.ts` runs between plan and generate, deterministically. Gap kinds map to the requirement's own words. Fillable gaps send the orchestrator back to plan, bounded. Fixture: 0.20 → 0.65 → 0.75, refusal paths 0 of 4 → 4 of 4. *Was: absent entirely.* |
| M4 | Generator produces **executable test files**, with live selector **and** assertion validation | **Met** | `emit/spec.ts` writes real Playwright specs to `tests/generated/`, emitted after execution so they carry any healed locator. Both generated specs run green standalone. Validation was already real and remains so. *Was: no file emission.* |
| M5 | Run the suite, invoke Healer, **distinguish broken script from genuine defect** | **Met** (unchanged — the strongest part of the build) | Deterministic split, 2 healable kinds against 12 never-healable, app health classified first. |

### Good to Have

| # | Requirement | Status | Now |
|---|---|---|---|
| G1 | Optional PRD to inform Planner scope | **Met** | `prd` on the mission scopes planning, bounded to fit the free tier's 8,000-token request cap. *Was: absent.* |
| G2 | Natural-language intent | **Met** (unchanged) | `instruction` is free-form prose and now merges with the crawled map. |
| G3 | Parallel execution across flows | **Partially met** | `RUN_CONCURRENCY` is honoured and missions run off the browser queue while their stages use it, so a thinking mission no longer holds the only slot. Default stays 1: one Chromium at two viewports per run, and raising it OOM-kills a small container. |

### Bonus

| # | Requirement | Status |
|---|---|---|
| B1 | PRD-to-test-plan gap analysis | **Met** — `prd/analyse.ts` extracts requirements, maps them to plans, and reports which stated requirements nothing verifies. Requirements a browser test cannot settle, such as a p95 latency budget, are reported as such rather than as gaps. |
| B2 | Defect classification, confidently | **Met** (unchanged) — deterministic, every call keeps the health snapshot it was made from |

### Out of scope — one live risk

> Manually written test scripts — **all test behaviour must be produced by the agent pipeline.**

`data/plans/fixture-checkout.json` carries `"model": "none (fixture recipe)"`. Its 9 steps are
hand-authored, and `store/seed.ts:31-34` loads it **pre-approved** on an empty database. It
exists for cold-start demo reliability, which is a legitimate engineering reason — but if the
live demo runs that plan, the test behaviour on screen was not produced by the agent pipeline.

### Submission requirements

| Deliverable | Status |
|---|---|
| Working prototype running live on a target application | **Dockerfile written**; Space front matter in `README.md`. Not yet deployed or warmed. |
| Source repo with setup instructions | Present |
| **Architecture diagram** of orchestration flow between sub-agents | **Written** — `docs/ARCHITECTURE.md`, four Mermaid diagrams |
| **Demo video, 2–5 min** | **Absent** |
| **Presentation deck** | **Absent** |

---

## 3. The architectural tension, and how to resolve it

This is the most important section. M2 cannot be satisfied by adding a feature beside the
current planner, because the current planner's governing rule forbids it.

`intent/prompt.ts:38-43`, rule 6:

> "Never invent steps. Every step must trace to something the tester actually wrote… if the
> tester says 'log in, view the product, and check out', there is no add-to-cart step, no
> cookie banner, no 'verify the page loaded' filler."

That rule is *correct*. It is why the generated plans are trustworthy and why a QA engineer
would believe them. It is also the exact inverse of "covering meaningful user flows — not just
happy paths". Weakening it to satisfy the requirement would trade the build's most defensible
property for a checkbox.

**Resolution: widen the evidence base, keep the discipline.** Rule 6's real content is *every
step must trace to observed evidence*. Today the only admissible evidence is the tester's
words. Add a second admissible source — the **crawled DOM** — and the rule survives intact
while the behaviour changes completely:

- **Scenario Compiler** (the existing planner, unchanged): grounded in the tester's words.
  Used whenever a human states intent. Rule 6 applies verbatim.
- **Explorer Planner** (new): grounded in the observed site map. Proposes flows including
  negative paths, edge cases and error states — each traceable to a real form, a real
  required field, a real destructive action it actually saw. It never invents either.

The orchestrator chooses: URL alone → Explorer. URL + instruction → Explorer for coverage
breadth, Compiler for the stated intent, merged with the human's intent ranked first.

This is a stronger system than either planner alone, and it is a better story for the 20%
innovation criterion than "we let the model imagine some edge cases".

---

## 4. Score exposure

| Criterion | Weight | Current standing |
|---|---|---|
| Functionality and completeness — full pipeline end to end without manual intervention | **30%** | **Lowest-scoring area.** Three mandatory human gates, no orchestrator. |
| Innovation and originality — coverage gaps, ambiguity, failure classification | **20%** | Split. Failure classification and ambiguity handling are strong; coverage-gap intelligence does not exist. |
| Technical implementation — agentic loop robustness, generated test quality, healer depth | **20%** | Strong on test quality and healer depth; the "agentic loop" is the missing piece. |
| UX and demo clarity — how clearly the agent's decisions are presented | **15%** | Strongest area. Redesign in flight (`docs/DESIGN-DIRECTION.md`). Note the criterion rewards showing **decisions** — which requires an orchestrator that makes some. |
| Business impact and feasibility | **10%** | Strong, and the escalation discipline is the differentiator. |
| Presentation — trade-offs and architecture | **5%** | Deck absent; the trade-off narrative is genuinely good and should be prepared. |

Roughly 40% of the rubric depends on an orchestration layer that does not exist, and a further
part of the 20% innovation score depends on coverage intelligence that does not exist.

---


## 7. Free-tier limits, measured

Three separate ceilings, each found by hitting it rather than by reading docs:

| Limit | Value | Effect |
|---|---|---|
| Gemini requests/day (`gemini-2.5-flash`) | **20** | One mission spends 10–15. Unusable; this is why Groq is the default. |
| Groq tokens/request | **8,000** | A full PRD plus a full map measured 8,380 and was refused with a 413 — a size error, so no retry helps. Prompt budgets are bounded in `orchestrator/machine.ts`. |
| Groq tokens/minute | **8,000** | Roughly three locator resolutions a minute. A six-step plan is minutes of mostly waiting, which is why the stage timeout is ten minutes and `MAX_REPLAN_ROUNDS` defaults to 1. |
| Groq tokens/day (`gpt-oss-120b`) | **200,000** | Around five to ten missions. Exhausted during a day of development. |

**Model choice is a real trade-off, not a preference.** `gpt-oss-120b` handles the
combined PRD-plus-map prompt; `gpt-oss-20b` returns `Failed to generate JSON` on it and
succeeds on the smaller map-only prompt. Both support `strict: true` constrained
decoding, and both have independent daily buckets — which is a usable fallback when one
is spent, at the cost of PRD scoping.

For the event: a paid Groq tier removes all four ceilings, or bring two keys and switch
`GROQ_API_KEY`. Do not plan on more than a handful of live missions per key per day.

---

## 5. Implementation plan

Ordered by score impact per unit of effort. P0 items are individually necessary for a
must-have. Each names the reuse that makes it cheaper than it looks.

### P0-1 · Orchestrator (the meta-agent) — `src/orchestrator/`

The single highest-value item. A bounded state machine over existing stages:

```
EXPLORE → PLAN → EVALUATE_COVERAGE ⇄ REPLAN(≤2) → GENERATE → BASELINE
        → EXECUTE → HEAL → REPORT
```

- `POST /api/missions { targetUrl, instruction?, prd?, credentials?, mode? }` — **`targetUrl`
  the only required field.** This alone closes M1.
- Two policies, not one: `AUTONOMOUS` (orchestrator approves, and **records its reason**) and
  `SUPERVISED` (today's human gate). Do not delete the gate — the README defends it correctly
  and it is a real quality feature. Reframe it: in autonomous mode *the orchestrator is the
  approver*, and its reasoning is a first-class output.
- Emit an SSE event per transition carrying **the decision and why** — "coverage scored 0.62,
  three error states unmodelled, re-planning once" is the sentence that wins both the 20%
  innovation and 15% demo-clarity criteria.
- Bounded re-plan (max 2) with an explicit reason each time; escalate rather than loop.

Reuse: `server/queue.ts` for concurrency, `server/events.ts` for SSE, `store/jobs.ts` for
job records. The stages already exist as callable units — this wires them.

### P0-2 · Explorer sub-agent — `src/explore/`

Breadth-first crawl from `targetUrl`, budget-capped by pages and wall-clock.

- At each state call the **existing** `extractPage()` (`browser/extract.ts`) — it already
  returns the accessibility tree and element inventory. This is the largest single reuse win.
- Detect and record: forms with required fields and validation, auth walls, destructive
  actions, navigation graph, error surfaces.
- **Authenticate and continue.** The organisers supply a URL *with login credentials* on the
  day. A crawler that stops at the login form sees one page of a ten-page app.
- Output a `SiteMap` artifact: pages, states, forms, candidate flows — the evidence base the
  Explorer Planner and the coverage evaluator both read.

### P0-3 · Explorer Planner mandate — `src/intent/explore-prompt.ts`

A second prompt, grounded in the `SiteMap` rather than the tester's words (see §3). Required
to produce, per observed affordance: happy path, invalid-input path, empty-required-field
path, and for auth flows a wrong-credential path, and for destructive actions a cancel path.
Every step still cites the DOM evidence it came from. Existing `intent/validate.ts` structural
validation applies unchanged.

### P0-4 · Coverage evaluator — `src/coverage/`

Closes M3 and report fields (d) and (e) together.

- Input: `SiteMap` + plan set. Output: `CoverageReport { covered[], gaps[{flow, kind, why}],
  untestedFlowRisk[{flow, score, rationale}] }`.
- Gap kinds map to the requirement's own words: missing flow, missing edge case, missing
  error state.
- **Risk must be explainable, not a black box:** weight each untested flow by proximity to
  money, auth or data loss × reachability depth, and print the rationale. A QA engineer will
  test a risk score they cannot interrogate, and disbelieve it.
- Runs *between* plan and generate, and again at the end for "gaps remaining".

### P0-5 · Executable test file emission — `src/emit/`

Closes M4 literally, and produces something a team would actually keep.

- Render plan + baseline to `tests/generated/<slug>.spec.ts` as real Playwright specs.
- The differentiator to say out loud: **the emitted locators are the ones proven against the
  live DOM** by `locator.ts:135-173`, not model guesses. Most generated suites ship
  unverified selectors.
- Re-emit after a successful heal, so the file is self-updating — that is the product thesis
  expressed as an artifact.
- Verify with `npx playwright test` on the fixture. Do **not** build CI integration; the
  statement lists it out of scope.

### P0-6 · Final quality report — `src/report/`

- One synthesised artifact per mission: scenario inventory (names and intents, not step
  counts), pass/fail per scenario, healer actions with confidence and cache disclosure,
  coverage gaps remaining, untested flow risk, and a composite score **that always shows its
  sub-scores** (functional, a11y, security, visual, coverage). A single opaque number is worth
  less than five honest ones.
- `GET /api/missions/:id/report` → JSON and markdown. Download control in the UI: a PM who
  cannot export the report will not use it.

### P1-1 · PRD input and PRD gap analysis — G1 + B1

Cheap once P0-4 exists: accept a pasted or uploaded PRD on mission creation, extract
requirement statements, map each to covered/uncovered flows, and report unmapped requirements.
Two good-to-have/bonus items for one increment of work.

### P1-2 · Parallel execution — G3

Raise `RUN_CONCURRENCY` and parallelise *independent* flows within a mission. Serialise
anything sharing session state. Demo at 2–3 locally and state the free-tier constraint
honestly rather than claiming scale.

### P1-3 · Seed-plan scope risk

Regenerate the fixture plan through the real pipeline and commit *that*, and label seeded
plans as seeded in the UI. Then demo a live generation against the organisers' URL. Cold-start
reliability is preserved; the scope objection disappears.

### P2 · Submission artifacts — three are outright missing deliverables

Architecture diagram of the orchestration flow; README rewritten to describe the pipeline as
built; 2–5 minute demo video; presentation deck covering problem, approach, trade-offs and
business impact. Plus the Dockerfile and hosting already tracked in `docs/REMAINING-WORK.md`,
since the first submission line is "working prototype running live".

---

## 6. Honest assessment of scope

P0-1 through P0-6 are six new subsystems: an orchestrator, a crawler, a second planner, a
coverage evaluator, a code emitter and a report synthesiser. That is a second system beside
the one that exists, and the UI redesign is already in flight in a parallel session.

Two things make it tractable. The stages themselves already work and are individually strong,
so the orchestrator wires rather than builds. And `extractPage()`, `resolveLocators()`,
`deriveOutcome()`, the queue, the SSE bus and the job store are all directly reusable.

If time forces a cut, the defensible minimum is **P0-1, P0-2, P0-4, P0-6** — a single URL in,
an autonomous run, coverage intelligence between stages, and one synthesised report out. That
is the challenge as stated. P0-5 is the cheapest remaining must-have after those. Everything
in P1 is explicitly optional in the statement.

What should **not** be cut: the escalation discipline, the deterministic classifier, and the
verified locators. They are the only parts of this build a competitor cannot reproduce in a
weekend, and they are what makes the autonomy trustworthy rather than merely automatic.
