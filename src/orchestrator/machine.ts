import { launchBrowser, newPage } from '../browser/session.js';
import { testCredentials } from '../config.js';
import { INTERNAL_ORIGIN } from '../config.js';
import { evaluateCoverage, fillableGaps } from '../coverage/evaluate.js';
import type { CoverageReport } from '../coverage/types.js';
import { crawl } from '../explore/crawl.js';
import { emitSpec } from '../emit/spec.js';
import { buildGapFillingInstruction } from '../intent/gap-prompt.js';
import {
  analysePrdCoverage,
  extractRequirements,
  type PrdAnalysis,
} from '../prd/analyse.js';
import { renderMarkdown, synthesiseReport } from '../report/synthesise.js';
import { saveReport } from '../store/reports.js';
import type { IntentPlan } from '../intent/types.js';
import { formCount, summariseForPlanner, type SiteMap } from '../explore/types.js';
import { generateIntentPlan } from '../intent/generate.js';
import { since, snapshot } from '../llm/usage.js';
import { buildRevisionInstruction, critiquePlan } from './critic.js';
import { executeRun } from '../server/execute-run.js';
import { recordBaselineJob } from '../server/record-baseline.js';
import { loadBaseline, saveSpecSource } from '../store/baselines.js';
import { createJob, finishJob } from '../store/jobs.js';
import {
  amendLastCoverageRound,
  appendCoverageRound,
  appendDecision,
  attachPlan,
  attachRun,
  finishMission,
  latestSiteMapForUrl,
  loadMission,
  saveSiteMap,
  setMissionStage,
} from '../store/missions.js';
import { approvePlan, loadPlan, savePlan } from '../store/plans.js';
import { createRun, loadRun } from '../store/runs.js';
import { getActiveVersion } from '../fixtures/app.js';
import { runQueuedStage } from './supervisor.js';
import { availableCredentialRefs, preflightValues } from './values.js';
import { notBuiltYet, type CoverageRound, type Decision, type Stage } from './types.js';

/**
 * The meta-agent.
 *
 * Everything it calls already existed and was already good; what was missing was
 * anything that decided when to call them. Four stages sat behind four commands
 * and an approval gate, which means the coordination burden stayed with the
 * person — the exact gap this is built to close.
 *
 * Two properties are deliberate:
 *
 *   Every transition records a decision. The value of an orchestrator is not that
 *   it runs stages in order — a shell script does that — it is that it can say
 *   why it moved on, what it skipped, and on what evidence. Those sentences are
 *   the output a reviewer actually reads.
 *
 *   A stage that does not exist yet says so. `explore` and `evaluate_coverage`
 *   are wired but unimplemented, and each records a skip naming what is missing.
 *   A pipeline that silently omitted exploration and then reported on coverage
 *   would be worse than one that never claimed to.
 */

/**
 * Per-stage ceiling, sized for the free tier rather than for the work.
 *
 * Locator resolution sends the page's element inventory once per step, and the free
 * tier allows 8,000 tokens a minute — roughly three resolutions. A six-step plan
 * therefore takes minutes of mostly waiting, and the original five-minute ceiling
 * killed recordings that were progressing normally. Raise the tier and this stops
 * mattering; until then a generous ceiling beats a false failure.
 */
const STAGE_TIMEOUT_MS = Number(process.env.STAGE_TIMEOUT_MS ?? 10 * 60 * 1000);

/**
 * How many times the orchestrator will go back and plan for what it is missing.
 *
 * Bounded because each round is a model call and a gap can be unfillable — a form
 * behind a wall the crawl never got through will be reported missing every round,
 * and an unbounded loop would spend the budget rediscovering it.
 *
 * One by default rather than two, and that is a throughput decision, not a design
 * one: every extra plan is another recording, and at 8,000 tokens a minute a third
 * plan pushes a mission past ten minutes of mostly waiting. Raise it with
 * MAX_REPLAN_ROUNDS on a paid tier, where more rounds cost minutes rather than the
 * whole demo window.
 */
const MAX_REPLAN_ROUNDS = Number(process.env.MAX_REPLAN_ROUNDS ?? 0);

/**
 * How long a crawled site map stays reusable for repeat missions against the
 * same URL. Long enough to cover a session of iterating on one application,
 * short enough that a deploy under the map gets noticed the next day.
 */
const EXPLORE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How much of a requirements document reaches the planner.
 *
 * The free tier caps a single request at 8,000 tokens, and the planning prompt
 * already carries the map, the rules and the schema. A full PRD plus a full map
 * measured 8,380 and was refused outright with a 413 — a size error, not a rate
 * limit, so no retry would have helped. Trimmed here rather than discovered there.
 */
const PRD_BUDGET_CHARS = 1_500;

interface RunMissionParams {
  missionId: string;
  signal: AbortSignal;
}

export async function runMission({ missionId, signal }: RunMissionParams): Promise<void> {
  const mission = loadMission(missionId);
  if (!mission) return;

  const decide = (
    stage: Stage,
    action: string,
    reason: string,
    outcome: Decision['outcome'],
    startedAt?: number,
  ): void => {
    appendDecision(missionId, {
      stage,
      action,
      reason,
      outcome,
      at: new Date().toISOString(),
      durationMs: startedAt === undefined ? null : Date.now() - startedAt,
    });
  };

  const aborted = (): boolean => signal.aborted;

  const tokensAtStart = snapshot();

  try {
    // ---- explore ----------------------------------------------------------
    setMissionStage(missionId, 'explore');
    const exploreStarted = Date.now();
    let siteMap: SiteMap | null = null;

    /**
     * Queued, because this drives a browser like every other stage. Deterministic,
     * because coverage wants exhaustiveness and the free tier affords twenty model
     * calls a day — spending one per navigation decision would end the day's budget
     * before a test ran. The model's turn comes once per page, deciding what is
     * worth testing about what was found.
     */
    const exploreJobId = `mission-${missionId}-explore`;

    /**
     * A repeat investigation of a URL explored recently reuses that map instead
     * of crawling again. The map is pure data — page inventories, form
     * classifications, auth findings — and plans built on it are selector-free,
     * so nothing in it depends on the browser session that produced it.
     * Re-crawling the same application buys nothing but time.
     *
     * Reuse is refused when it would mislead: a stale map (the application may
     * have changed under it) or a mismatched auth state. Credentials supplied
     * now demand a map crawled from behind the wall; a map crawled signed-in is
     * not reused for a mission that cannot sign in, or its plans would target
     * pages the recording can never reach.
     */
    const credsForCache = testCredentials();
    const wantAuth = Boolean(credsForCache.identity && credsForCache.secret);
    let reusedFrom: { missionId: string; ageMinutes: number } | null = null;

    if (process.env.EDGEFORGE_EXPLORE_CACHE !== 'off') {
      const cached = latestSiteMapForUrl(mission.targetUrl, missionId);
      if (cached) {
        const ageMs = Date.now() - Date.parse(cached.crawledAt);
        const fresh = ageMs >= 0 && ageMs <= EXPLORE_CACHE_MAX_AGE_MS;
        const authCompatible = !cached.siteMap.auth.wallFound
          ? true
          : cached.siteMap.auth.authenticated === wantAuth;
        // A map crawled before affordances were recorded starves the planner of
        // what each page offers — the exact defect the field fixed. Such a map
        // parses (the field defaults to []) but is not worth reusing when any
        // page plainly had clickable content the map does not name.
        const affordanceEra = cached.siteMap.pages.every(
          (p) => (p.affordances ?? []).length > 0 || p.elementCount === 0,
        );
        if (fresh && authCompatible && affordanceEra) {
          siteMap = cached.siteMap;
          reusedFrom = { missionId: cached.missionId, ageMinutes: Math.round(ageMs / 60_000) };
        }
      }
    }

    if (!reusedFrom) {
      createJob({ jobId: exploreJobId, kind: 'explore', planId: missionId });

      await runQueuedStage(exploreJobId, 'job', async (stageSignal) => {
        const browser = await launchBrowser({ headed: false });
        try {
          const page = await newPage(browser);
          siteMap = await crawl(page, { entryUrl: mission.targetUrl, signal: stageSignal });
        } finally {
          await browser.close().catch(() => {});
        }
      })
        .then(() => finishJob(exploreJobId, 'done', null))
        .catch((error: unknown) => {
          finishJob(exploreJobId, 'error', message(error));
          decide(
            'explore',
            'Could not explore the application',
            `${message(error)} The mission continues on the stated intent alone, which is a narrower basis than a crawl.`,
            'failed',
            exploreStarted,
          );
        });
    }

    if (siteMap) {
      const map: SiteMap = siteMap;
      /**
       * Kept before anything is said about it. The map is the only record of which
       * pages sit behind a sign-in and which controls were recorded and left alone,
       * and it used to be summarised into one sentence and dropped.
       */
      saveSiteMap(missionId, map);
      const negatives = map.pages.reduce(
        (total, page) =>
          total + page.forms.reduce((sum, form) => sum + form.negativeOpportunities.length, 0),
        0,
      );
      decide(
        'explore',
        reusedFrom
          ? `Reused the site map from ${reusedFrom.missionId}: ${map.pages.length} page(s), ${formCount(map)} form(s)`
          : `Mapped ${map.pages.length} page(s), ${formCount(map)} form(s), ${negatives} negative-path opportunit(y/ies)`,
        `${
          reusedFrom
            ? `The same URL was explored ${reusedFrom.ageMinutes} minute(s) ago and the map is pure data, so it was reused rather than crawled again. Set EDGEFORGE_EXPLORE_CACHE=off to force a fresh crawl. `
            : ''
        }${map.auth.note}${
          map.unvisited.length ? ` ${map.unvisited.length} link(s) were left unvisited.` : ''
        }${
          map.pages.some((page) => page.destructiveActions.length)
            ? ' Destructive controls were recorded but never operated.'
            : ''
        }`,
        'ok',
        exploreStarted,
      );

      /**
       * The credential verdict, as its own decision.
       *
       * A caller who supplies a login is asking a question -- do these work? --
       * and the crawl just answered it empirically. Success used to be buried in
       * a site-map note, and failure produced "supply credentials on the
       * mission" to a caller who already had, which reads as the tool not
       * listening. Three outcomes, each stated as what was actually observed.
       */
      const creds = testCredentials();
      const credsAvailable = Boolean(creds.identity && creds.secret);

      if (map.auth.wallFound && map.auth.authenticated && credsAvailable) {
        const behind = map.pages.filter((page) => page.behindAuth).length;
        decide(
          'explore',
          reusedFrom
            ? 'Credentials were verified during the reused exploration'
            : 'Credentials verified against the live application',
          `The ${reusedFrom ? 'earlier' : ''} crawl signed in with the supplied credentials and reached ${behind} page(s) that need that session. This is observed, not assumed: the sign-in form accepted them and the application granted access. Plans can rely on this login for authenticated flows, and a wrong-password test now has a working credential to contrast against.`,
          'ok',
        );
      } else if (map.auth.wallFound && !map.auth.authenticated && credsAvailable) {
        decide(
          'explore',
          'The supplied credentials did not get past the sign-in form',
          'A sign-in was attempted with the credentials provided and the form was still there afterwards. Two readings are possible and the crawl cannot tell them apart from outside: the credentials are wrong for this application, or the sign-in itself is broken -- which is exactly the kind of defect this product exists to catch rather than paper over. The mission continues: the sign-in page itself is still testable, and a refusal that should have been an acceptance will surface in the run.',
          'escalated',
        );
      } else if (map.auth.wallFound && !map.auth.authenticated) {
        decide(
          'explore',
          'Stopped at an authentication wall',
          'A login form was found and nothing beyond it was reached, so what was mapped is a small part of the application. Supply credentials on the mission to map the rest; coverage measured against this map would understate the real gap.',
          'escalated',
        );
      }
    }

    if (aborted()) return void finishMission(missionId, 'cancelled');

    // ---- plan -------------------------------------------------------------
    setMissionStage(missionId, 'plan');
    const planStarted = Date.now();

    /**
     * What the planner is grounded in, in descending order of strength.
     *
     * The stated intent is honoured when there is one — a tester who says what to
     * test should get that tested. The map is supplied either way, because the
     * planner's rule is that every step traces to observed evidence and the map is
     * evidence: it names the real forms, the real field labels, and the real
     * sign-in requirement, which is the difference between steps that resolve
     * against the live DOM and steps that read plausibly and match nothing.
     */
    /**
     * The credential names the planner may reference, rather than leaving it to
     * invent one. Names only — a value never reaches a prompt.
     */
    const refs = availableCredentialRefs();
    /**
     * Verified beats available. A planner told only that credentials exist plans
     * a sign-in it hopes will work; one told the crawl already signed in with
     * them can treat the login as a reliable fixture -- build authenticated
     * flows on it, and pair it with a deliberately wrong password knowing the
     * contrast is real. That difference is what turns "we accept logins" into
     * test cases designed around a credential known to work.
     */
    // TS narrows `siteMap` to never here because it was assigned inside the queued
    // closure; the explore block above resolves it the same way.
    const mapForNote = siteMap as SiteMap | null;
    const verifiedLogin = Boolean(mapForNote?.auth.wallFound && mapForNote.auth.authenticated);
    const credentialNote = refs.length
      ? [
          `When a step needs a login, reference these exact names and no others: ${refs.join(', ')}. Do not invent a different name for a credential; only these can be resolved.`,
          verifiedLogin
            ? 'These credentials are VERIFIED: the exploration signed in with them successfully. Plan authenticated flows on them with confidence, and prefer a wrong-credential refusal test alongside, since a known-good login makes that contrast meaningful.'
            : null,
        ]
          .filter(Boolean)
          .join(' ')
      : /**
         * No credentials at all. A sign-in journey planned anyway has exactly one
         * ending: the recorder reaches the login form, has nothing to type, and
         * the mission dies at resolution — or worse, the model invents a
         * credential. But the sign-in form itself is still worth testing from
         * the outside: a refusal is asserted with made-up wrong values, and
         * required-field validation needs no account. Say so explicitly, or the
         * planner treats "there is a login form" as an invitation.
         */
        'No login credentials were supplied. Do NOT plan any journey that requires signing in or reaching pages behind the sign-in form. If a sign-in form exists, test it only negatively: wrong credentials must be refused with an error, and required-field validation must hold. Plan the rest of the suite on pages reachable without an account.';

    const observed = siteMap ? summariseForPlanner(siteMap) : null;

    /**
     * The requirements document as planning scope.
     *
     * Bounded, because a long PRD would crowd out the map and the prompt's own rules.
     * It steers *what* to test; the map still constrains what the steps may refer to,
     * so a requirement describing a feature the crawl never found cannot become a
     * plan step that resolves against nothing.
     */
    const stated = mission.prd
      ? [
          'The product is specified as follows. Test what it promises, and only where the application below actually offers it:',
          mission.prd.slice(0, PRD_BUDGET_CHARS),
        ].join('\n')
      : null;

    let instruction: string;
    if (mission.instruction && observed) {
      instruction = [mission.instruction, stated, observed, credentialNote].filter(Boolean).join('\n\n');
      decide(
        'plan',
        'Planned from the stated intent, grounded in the map',
        'The tester said what to test and the crawl found what is there, so the plan is constrained by both.',
        'ok',
      );
    } else if (observed) {
      instruction = [
        stated ??
          'Exercise the primary journey this application exists for, using only what was found below: reach its main task, complete it with valid input, and confirm the application acknowledges the result. Keep the plan simple — the shortest sequence that proves the journey works end to end. Do not add edge cases, alternative flows, or exhaustive checks; a clean pass on the happy path is the goal.',
        observed,
        credentialNote,
      ]
        .filter(Boolean)
        .join('\n\n');
      decide(
        'plan',
        stated ? 'Derived scope from the requirements and the map' : 'Derived scope from the map',
        `No instruction was supplied, so scope came from the ${siteMap!.pages.length} page(s) the crawl actually saw rather than from a guess about what this application does.`,
        'ok',
      );
    } else {
      instruction =
        mission.instruction ??
        'Exercise the primary user journey this application exists for: reach its main task, complete it with valid input, and confirm the application acknowledges the result.';
      if (!mission.instruction) {
        decide(
          'plan',
          'Derived scope with neither intent nor map',
          'No instruction was supplied and the crawl produced nothing, so a generic primary-journey scope was used. Steps built this way frequently fail to resolve, and the report should not be read as coverage.',
          'ok',
        );
      }
    }

    const generated = await generateIntentPlan({
      targetUrl: mission.targetUrl,
      instruction,
      onAttempt: ({ attempt, errors }) => {
        if (attempt > 1) {
          decide(
            'plan',
            `Repaired the plan on attempt ${attempt}`,
            `The validator rejected the previous attempt: ${errors.slice(0, 3).join('; ')}`,
            'retried',
          );
        }
      },
    });

    const { planId } = savePlan({
      plan: generated.plan,
      model: generated.model,
      targetUrl: mission.targetUrl,
      instruction,
      status: 'DRAFT',
    });
    attachPlan(missionId, planId);

    decide(
      'plan',
      `Planned ${generated.plan.steps.length} steps as "${planId}"`,
      generated.warnings.length
        ? `Accepted after ${generated.attempts} attempt(s) with warnings: ${generated.warnings.join('; ')}`
        : `Accepted on attempt ${generated.attempts} with no validator warnings.`,
      'ok',
      planStarted,
    );

    if (aborted()) return void finishMission(missionId, 'cancelled');

    // ---- critique the plan before anything executes it ---------------------
    /**
     * Recorded under the 'plan' stage rather than a stage of its own. The stage
     * vocabulary is shared with the dashboard, which is mid-demo and cannot be
     * restarted to learn a new word; a critic decision reads naturally as part of
     * planning, and nothing downstream keys on stage counts.
     *
     * Disable with EDGEFORGE_CRITIC=off when a quota-tight session needs the
     * ~1,000 tokens more than the review.
     */
    if ((process.env.EDGEFORGE_CRITIC ?? 'on') !== 'off') {
      const critiqueStarted = Date.now();
      try {
        const { critique } = await critiquePlan(generated.plan, siteMap);

        if (critique.verdict === 'accept') {
          decide(
            'plan',
            'Critic accepted the plan',
            'A reviewing agent examined every step for weak assertions, unasserted refusals, unreachable targets and order dependence, and found nothing material.',
            'ok',
            critiqueStarted,
          );
        } else {
          decide(
            'plan',
            `Critic rejected the plan with ${critique.findings.length} finding(s)`,
            critique.findings
              .map((finding) => `${finding.stepId}: ${finding.problem}`)
              .join(' '),
            'retried',
            critiqueStarted,
          );

          // One bounded revision. The planner owns schema, validation and
          // grounding; the critic only supplies the corrections.
          const revised = await generateIntentPlan({
            targetUrl: mission.targetUrl,
            instruction: buildRevisionInstruction(instruction, critique),
          });
          const saved = savePlan({
            plan: revised.plan,
            model: revised.model,
            targetUrl: mission.targetUrl,
            instruction,
            planId,
            status: 'DRAFT',
          });
          // The mission's working set is built from generated.plan further down,
          // so the revision only needs to land here to reach coverage, recording
          // and execution alike.
          generated.plan = revised.plan;
          void saved;

          const second = await critiquePlan(revised.plan, siteMap);
          decide(
            'plan',
            second.critique.verdict === 'accept'
              ? 'Critic accepted the revised plan'
              : `Revised plan still carries ${second.critique.findings.length} finding(s); proceeding`,
            second.critique.verdict === 'accept'
              ? 'Every correction was addressed.'
              : 'The revision budget is one round, so the remaining findings are recorded here rather than looped on. They travel with the mission for a reader to weigh.',
            second.critique.verdict === 'accept' ? 'ok' : 'escalated',
          );
        }
      } catch (error) {
        decide(
          'plan',
          'Critic could not review the plan',
          `${message(error)} The mission continues with the unreviewed plan rather than failing on its reviewer.`,
          'failed',
          critiqueStarted,
        );
      }
    }

    // ---- evaluate coverage, and re-plan for what is missing ----------------
    setMissionStage(missionId, 'evaluate_coverage');

    /**
     * The gate the challenge asks for by name: evaluate the plan for coverage gaps
     * *before* passing it to the generator, and decide whether to re-plan.
     *
     * Deterministic, so the number is reproducible, and bounded, so a mission
     * cannot spend its budget discovering that some gap is unfillable. Every plan
     * built here goes through the same schema and the same validator as the first.
     */
    const plans: { planId: string; plan: IntentPlan }[] = [{ planId, plan: generated.plan }];
    let coverage: CoverageReport | null = null;

    /**
     * Each reading, with what the orchestrator did next.
     *
     * Recorded structurally because the climb across rounds is the clearest
     * evidence this pipeline produces, and a reader who wants the series should
     * not have to recover it from the wording of a sentence.
     */
    let roundNumber = 0;
    const recordRound = (report: CoverageReport, followedBy: CoverageRound['followedBy']): void => {
      roundNumber += 1;
      appendCoverageRound(missionId, {
        round: roundNumber,
        score: report.score,
        gaps: report.gaps.length,
        refusalCovered: report.covered.negativePaths.length,
        refusalTotal: report.totals.negativePaths,
        formsCovered: report.covered.forms.length,
        formsTotal: report.totals.forms,
        pagesCovered: report.covered.pages.length,
        pagesTotal: report.totals.pages,
        followedBy,
        at: new Date().toISOString(),
      });
    };

    if (siteMap) {
      const map = siteMap;
      for (let round = 0; round <= MAX_REPLAN_ROUNDS; round += 1) {
        coverage = evaluateCoverage(map, plans.map((entry) => entry.plan));
        const gaps = fillableGaps(coverage);
        const topRisk = coverage.untestedFlowRisk[0];

        /**
         * Written now, not when the round resolves. A re-plan is a model call that
         * can take half a minute, and a reader watching the mission is entitled to
         * see the reading that prompted it while it happens. Only the re-plan's own
         * success is unknown at this point, so that case is written optimistically
         * and amended if it fails.
         */
        recordRound(
          coverage,
          !gaps.length
            ? 'nothing_fillable'
            : round === MAX_REPLAN_ROUNDS
              ? 'budget_spent'
              : 'replanned',
        );

        decide(
          'evaluate_coverage',
          `Scored coverage ${coverage.score} with ${coverage.gaps.length} gap(s)`,
          `${coverage.covered.negativePaths.length} of ${coverage.totals.negativePaths} refusal path(s) and ${coverage.covered.forms.length} of ${coverage.totals.forms} form(s) are covered.${
            topRisk ? ` Highest untested risk: ${topRisk.flow} at ${topRisk.score} (${topRisk.band}).` : ''
          }`,
          'ok',
        );

        if (!gaps.length) {
          decide(
            'evaluate_coverage',
            'Stopped re-planning',
            'Nothing fillable is left in the map, so another planning round would spend a call to learn nothing.',
            'ok',
          );
          break;
        }
        if (round === MAX_REPLAN_ROUNDS) {
          decide(
            'evaluate_coverage',
            `Left ${coverage.gaps.length} gap(s) unfilled`,
            `The re-plan budget of ${MAX_REPLAN_ROUNDS} round(s) is spent. The remaining gaps are reported rather than quietly dropped, because a suite is only trustworthy if it says what it does not check.`,
            'escalated',
          );
          break;
        }

        // Re-plan. The rule that every step traces to observed evidence still
        // holds — a gap is an observation about a form the crawl actually found.
        const gapStarted = Date.now();
        try {
          const extra = await generateIntentPlan({
            targetUrl: mission.targetUrl,
            instruction: buildGapFillingInstruction(gaps, map, refs),
          });
          const saved = savePlan({
            plan: extra.plan,
            model: extra.model,
            targetUrl: mission.targetUrl,
            instruction: 'Coverage gaps identified by the orchestrator.',
            status: 'APPROVED',
          });
          plans.push({ planId: saved.planId, plan: extra.plan });
          decide(
            'evaluate_coverage',
            `Re-planned for ${gaps.length} gap(s) as "${saved.planId}"`,
            `Coverage scored ${coverage.score}, so the orchestrator asked for the missing checks rather than proceeding: ${gaps
              .map((gap) => gap.what)
              .join(' ')}`,
            'retried',
            gapStarted,
          );
        } catch (error) {
          amendLastCoverageRound(missionId, 'replan_failed');
          decide(
            'evaluate_coverage',
            'Could not plan the missing checks',
            `${message(error)} The mission continues with the coverage it has, and the gaps stay in the report.`,
            'failed',
            gapStarted,
          );
          break;
        }
      }
    } else {
      decide(
        'evaluate_coverage',
        'Could not evaluate coverage',
        'There is no map to compare the plan against, so no statement about coverage would mean anything.',
        'skipped',
      );
    }

    // ---- approve ----------------------------------------------------------
    /**
     * The gate changes hands rather than disappearing. In supervised mode the
     * mission stops here and waits for a person, which is the behaviour the
     * README defends and worth keeping available. In autonomous mode the
     * orchestrator approves and is obliged to say what it approved on.
     */
    if (mission.mode === 'supervised') {
      decide(
        'plan',
        'Paused for human approval',
        `Supervised mode. Approve "${planId}" and start a run to continue.`,
        'escalated',
      );
      finishMission(missionId, 'needs_review');
      return;
    }

    approvePlan(planId);
    decide(
      'plan',
      `Approved "${planId}" without a human`,
      `Autonomous mode. The plan passed structural validation on attempt ${generated.attempts} and every step resolved to a described target rather than a raw selector; approval is recorded here so the decision is attributable.`,
      'ok',
    );

    if (aborted()) return void finishMission(missionId, 'cancelled');

    // ---- generate and execute, once per plan -------------------------------
    /**
     * Every plan the mission produced gets a baseline and a run, not just the first.
     * A re-plan that fills a coverage gap and then never executes has not improved
     * anything — it has only made the report look better than the suite is.
     *
     * Verdicts aggregate to the worst outcome, because a suite is as trustworthy as
     * its least trustworthy result: one plan needing review is a mission needing
     * review, whatever the others did.
     */
    const verdicts: string[] = [];
    const specFiles: string[] = [];

    for (const [index, entry] of plans.entries()) {
      if (aborted()) return void finishMission(missionId, 'cancelled');

      setMissionStage(missionId, 'generate');
      const genStarted = Date.now();

      /**
       * Per plan, not once for the mission. The re-planned refusal tests reference
       * values the first plan never mentioned — a wrong password, a malformed
       * address — and a preflight that ran only on the primary journey left them
       * unresolvable, which surfaced as a recording that reached the step and
       * stopped.
       */
      const values = preflightValues(entry.plan);
      const authoredValues = Object.fromEntries(
        values.authored.map((item) => [item.ref, item.value]),
      );
      if (values.authored.length) {
        decide(
          'generate',
          `Authored ${values.authored.length} test value(s) for "${entry.planId}"`,
          `${values.authored.map((v) => `${v.ref}="${v.value}"`).join(', ')}. These are test inputs, not claims about the product.`,
          'ok',
        );
      }
      if (values.missing.length) {
        const names = values.missing.map((v) => v.ref).join(', ');
        decide(
          'generate',
          `Skipped "${entry.planId}" for missing credentials`,
          `It needs ${names}, which cannot be invented. Supply them as credentials on the mission and run again.`,
          'escalated',
        );
        verdicts.push('needs_review');
        continue;
      }

      const jobId = `mission-${missionId}-baseline-${index}`;
      createJob({ jobId, kind: 'record-baseline', planId: entry.planId });

      try {
        await withTimeout(
          runQueuedStage(jobId, 'job', (stageSignal) =>
            recordBaselineJob({ jobId, planId: entry.planId, signal: stageSignal }),
          ),
          STAGE_TIMEOUT_MS,
          'generate',
        );
      } catch (error) {
        decide(
          'generate',
          `Could not record "${entry.planId}"`,
          `${message(error)}${plans.length > 1 ? ' The other plans in this mission are unaffected.' : ''}`,
          'failed',
          genStarted,
        );
        verdicts.push('error');
        continue;
      }

      const baseline = loadBaseline(entry.planId);
      if (!baseline) {
        decide(
          'generate',
          `No executable baseline for "${entry.planId}"`,
          'Recording finished without writing a baseline, so there is nothing to execute. The application was reachable but no step resolved to a live element.',
          'failed',
          genStarted,
        );
        verdicts.push('failed');
        continue;
      }

      decide(
        'generate',
        `Resolved ${baseline.steps.length} step(s) of "${entry.planId}" against the live application`,
        'Every locator written to the baseline was verified against the real DOM, and every assertion was derived from what the browser actually observed rather than from the model.',
        'ok',
        genStarted,
      );

      setMissionStage(missionId, 'execute');
      const execStarted = Date.now();
      const runId = `${entry.planId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

      createRun({
        runId,
        planId: entry.planId,
        startUrl: baseline.startUrl,
        activeVersion: getActiveVersion(),
        healingEnabled: true,
        stepsTotal: baseline.steps.length,
      });
      // The primary journey owns the mission's run pointer; later plans are found
      // through their own decision lines.
      if (index === 0) attachRun(missionId, runId);

      try {
        await withTimeout(
          runQueuedStage(runId, 'run', (stageSignal) =>
            executeRun({
              runId,
              planId: entry.planId,
              healing: true,
              strictVisual: false,
              signal: stageSignal,
            }),
          ),
          STAGE_TIMEOUT_MS,
          'execute',
        );
      } catch (error) {
        decide('execute', `Run of "${entry.planId}" stopped`, message(error), 'failed', execStarted);
        verdicts.push('error');
        continue;
      }

      const run = loadRun(runId);
      const verdict = run?.summary.status ?? 'error';
      verdicts.push(verdict);

      /**
       * Emitted after the run, not after recording, so the file carries any locator
       * the healer rewrote. A spec written before execution would ship the locator
       * that had just broken.
       */
      const healedBaseline = loadBaseline(entry.planId);
      if (healedBaseline) {
        try {
          const emitted = await emitSpec(healedBaseline, { authoredValues });
          specFiles.push(emitted.relativePath);
          // The durable copy. tests/generated/ is gitignored and the filesystem
          // is ephemeral; the database is where the deliverable survives.
          saveSpecSource(entry.planId, emitted.source);
          decide(
            'execute',
            `Wrote ${emitted.relativePath}`,
            `An executable Playwright spec for "${entry.planId}"${
              emitted.healed ? `, including ${emitted.healed} locator(s) the healer repaired` : ''
            }. Its locators are the ones proven against the running application, not selectors a model guessed. The source is stored with the baseline and served at /api/plans/${entry.planId}/spec.`,
            'ok',
          );
        } catch (error) {
          decide('execute', 'Could not write the spec file', message(error), 'failed');
        }
      }

      decide(
        'execute',
        `"${entry.planId}" finished as ${verdict}`,
        explainVerdict(verdict, run?.summary.healCount ?? 0),
        verdict === 'needs_review' ? 'escalated' : verdict === 'passed' ? 'ok' : 'failed',
        execStarted,
      );
    }

    // ---- report -----------------------------------------------------------
    setMissionStage(missionId, 'report');
    finishMission(missionId, missionStatusFor(worstVerdict(verdicts)));

    /**
     * Synthesised after the verdict is settled, and from the stored records rather
     * than from state accumulated along the way — so the report cannot disagree with
     * the runs a reader would check it against.
     */
    /**
     * The specification's gaps, which are not the application's gaps.
     *
     * The coverage evaluator asks what the application affords and nothing
     * exercises. This asks what the document promises and nothing checks — an
     * application can be fully exercised and still leave a stated requirement
     * unverified, and that is the gap a PM is usually asking about.
     */
    let prdAnalysis: PrdAnalysis | null = null;
    if (mission.prd) {
      const prdStarted = Date.now();
      try {
        const requirements = await extractRequirements(mission.prd);
        prdAnalysis = analysePrdCoverage(requirements, plans);
        decide(
          'report',
          `Checked ${prdAnalysis.testableInBrowser} testable requirement(s) against the plans`,
          `${prdAnalysis.covered} appear covered. ${
            prdAnalysis.requirementsFound - prdAnalysis.testableInBrowser
          } of ${prdAnalysis.requirementsFound} requirement(s) are not settleable by a browser test and are reported as such rather than as gaps.`,
          'ok',
          prdStarted,
        );
      } catch (error) {
        decide(
          'report',
          'Could not analyse the requirements document',
          `${message(error)} The report says nothing about requirement coverage rather than guessing.`,
          'failed',
          prdStarted,
        );
      }
    }

    const finished = loadMission(missionId);
    if (finished) {
      const report = synthesiseReport({
        mission: finished,
        planIds: plans.map((entry) => entry.planId),
        coverage,
        specFiles,
        prd: prdAnalysis,
      });
      saveReport(missionId, report, renderMarkdown(report));
      const spent = since(tokensAtStart);
      decide(
        'report',
        `Spent ${spent.totalTokens.toLocaleString()} tokens across ${spent.calls} model call(s)`,
        `${spent.promptTokens.toLocaleString()} prompt, ${spent.completionTokens.toLocaleString()} completion. Locator resolution carries a page's element inventory once per step, which is where most of it goes.`,
        'ok',
      );
      decide(
        'report',
        `Reported ${report.scenarios.length} scenario(s) at quality ${report.quality.overall}`,
        `${report.outcomes.scenariosPassed} passed, ${report.outcomes.scenariosFailed} failed, ${
          report.outcomes.scenariosNotRun
        } never ran. ${
          coverage ? `${coverage.gaps.length} coverage gap(s) remain and are listed.` : 'Coverage was not assessed and the report says so.'
        }${report.quality.caveats.length ? ` ${report.quality.caveats.length} caveat(s) qualify the score.` : ''}`,
        'ok',
      );
    }
    return;

  } catch (error) {
    if (signal.aborted) {
      finishMission(missionId, 'cancelled');
      return;
    }
    appendDecision(missionId, {
      stage: loadMission(missionId)?.stage ?? 'plan',
      action: 'Stopped on an unrecoverable error',
      reason: message(error),
      outcome: 'failed',
      at: new Date().toISOString(),
      durationMs: null,
    });
    finishMission(missionId, 'error', message(error));
  }
}

/**
 * The worst result across the mission's plans.
 *
 * Ordered by how much attention each demands: an error outranks a failure, which
 * outranks a review, which outranks a pass. Reporting the best of them, or an
 * average, would let a green primary journey bury a refusal test that never ran.
 */
function worstVerdict(verdicts: string[]): string {
  const order = ['error', 'failed', 'needs_review', 'passed'];
  for (const candidate of order) {
    if (verdicts.includes(candidate)) return candidate;
  }
  return 'error';
}

function missionStatusFor(verdict: string): 'passed' | 'failed' | 'needs_review' | 'error' {
  if (verdict === 'passed') return 'passed';
  if (verdict === 'needs_review') return 'needs_review';
  if (verdict === 'failed') return 'failed';
  return 'error';
}

function explainVerdict(verdict: string, healed: number): string {
  switch (verdict) {
    case 'passed':
      return healed > 0
        ? `Every step passed, ${healed} of them after a repair the healer verified against the application's own response.`
        : 'Every step passed with no repairs needed.';
    case 'needs_review':
      return 'The run needs a person: either the healer hit its cap, or a repair passed its assertion while the application stayed unhealthy. Neither is something to report as green.';
    case 'failed':
      return 'A step failed in a way the healer is not permitted to repair — the test acted and the outcome did not follow, which points at the application rather than the locator.';
    default:
      return 'The run did not reach a verdict.';
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The ${stage} stage exceeded ${Math.round(ms / 1000)}s.`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default target when a caller supplies none: the app bundled with this server. */
export const DEFAULT_TARGET_URL = `${INTERNAL_ORIGIN}/app/`;
