import type { CoverageReport } from '../coverage/types.js';
import type { Mission } from '../orchestrator/types.js';
import { listRunEvents, loadRun, listRuns } from '../store/runs.js';
import { loadBaseline } from '../store/baselines.js';
import { loadPlan } from '../store/plans.js';
import type { PrdAnalysis } from '../prd/analyse.js';
import type { HealAction, QualityReport, Scenario } from './types.js';

/**
 * Assembles the report from what actually happened.
 *
 * Reads the stored runs, baselines and plans rather than accumulating state during
 * the mission, so a report can be produced for a mission that finished hours ago —
 * and so the report cannot disagree with the records a reader would check it
 * against.
 */

export interface SynthesiseParams {
  mission: Mission;
  /** Every plan the mission produced, in the order it produced them. */
  planIds: string[];
  coverage: CoverageReport | null;
  specFiles: string[];
  prd: PrdAnalysis | null;
}

export function synthesiseReport({
  mission,
  planIds,
  coverage,
  specFiles,
  prd,
}: SynthesiseParams): QualityReport {
  const scenarios: Scenario[] = [];
  const healActions: HealAction[] = [];
  const analysisEvents: (RunAnalysis | null)[] = [];

  for (const [index, planId] of planIds.entries()) {
    const plan = loadPlan(planId);
    const baseline = loadBaseline(planId);
    // The most recent run of this plan is the one this mission produced; a plan is
    // recorded and run once per mission.
    const runSummary = listRuns({ planId, limit: 1 })[0];
    const run = runSummary ? loadRun(runSummary.runId) : null;
    if (runSummary) analysisEvents.push(readAnalysis(runSummary.runId));

    const stepsTotal = baseline?.steps.length ?? plan?.plan.steps.length ?? 0;
    const stepsPassed = run?.summary.stepsPassed ?? 0;

    scenarios.push({
      planId,
      name: plan?.plan.name ?? planId,
      intent: plan?.plan.description ?? 'No description recorded.',
      // The first plan is the journey the mission was asked for; the rest exist
      // because the coverage evaluator found something missing.
      kind: index === 0 ? 'primary_journey' : classifyScenario(plan?.plan.name ?? planId),
      stepsTotal,
      stepsPassed,
      verdict: verdictOf(run?.summary.status, baseline !== null),
      outcome: describeOutcome(run?.summary.status, baseline !== null, stepsPassed, stepsTotal),
      specFile: specFiles.find((file) => file.includes(planId)) ?? null,
    });

    for (const step of baseline?.steps ?? []) {
      for (const heal of step.healHistory ?? []) {
        const entry = heal as Record<string, unknown>;
        healActions.push({
          planId,
          stepId: step.stepId,
          status: String(entry.status ?? 'accepted'),
          confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
          reason: typeof entry.reason === 'string' ? entry.reason : null,
          previousLocator: describeMaybeLocator(entry.previousLocator),
          newLocator: describeMaybeLocator(entry.newLocator),
          verification: typeof entry.verification === 'string' ? entry.verification : null,
          fromCache: entry.proposalFromCache === true,
        });
      }
    }
  }

  const outcomes = {
    scenariosTotal: scenarios.length,
    scenariosPassed: scenarios.filter((s) => s.verdict === 'passed').length,
    scenariosFailed: scenarios.filter((s) => s.verdict === 'failed' || s.verdict === 'error').length,
    scenariosNeedingReview: scenarios.filter((s) => s.verdict === 'needs_review').length,
    scenariosNotRun: scenarios.filter((s) => s.verdict === 'not_run').length,
    stepsTotal: scenarios.reduce((total, s) => total + s.stepsTotal, 0),
    stepsPassed: scenarios.reduce((total, s) => total + s.stepsPassed, 0),
  };

  return {
    missionId: mission.missionId,
    targetUrl: mission.targetUrl,
    generatedAt: new Date().toISOString(),
    verdict: mission.status,
    scenarios,
    outcomes,
    healActions,
    coverage,
    coverageNote: coverage
      ? coverage.method
      : 'Coverage was not assessed — no map of the application was produced, so this report makes no claim about what is untested. Absence of gaps here does not mean there are none.',
    quality: score(outcomes, coverage, scenarios),
    application: mergeAnalysis(analysisEvents),
    prd,
    specFiles,
    decisions: mission.decisions.map((decision) => ({
      stage: decision.stage,
      action: decision.action,
      reason: decision.reason,
      outcome: decision.outcome,
    })),
  };
}

/**
 * The composite, and everything it is made of.
 *
 * Functional pass rate is the smaller half deliberately. A suite where every test
 * passes and nothing tests a refusal is the exact object this product exists to
 * argue with, and a score that rewarded it would be endorsing the problem.
 */
function score(
  outcomes: QualityReport['outcomes'],
  coverage: CoverageReport | null,
  scenarios: Scenario[],
): QualityReport['quality'] {
  const parts: QualityReport['quality']['parts'] = [];
  const caveats: string[] = [];

  const ran = outcomes.scenariosTotal - outcomes.scenariosNotRun;
  const functional = ran > 0 ? outcomes.scenariosPassed / ran : 0;
  parts.push({
    name: 'Functional',
    score: Number(functional.toFixed(2)),
    weight: 0.45,
    note: `${outcomes.scenariosPassed} of ${ran} executed scenario(s) passed.`,
  });

  if (coverage) {
    parts.push({
      name: 'Coverage',
      score: coverage.score,
      weight: 0.55,
      note: `${coverage.covered.negativePaths.length} of ${coverage.totals.negativePaths} refusal path(s) and ${coverage.covered.forms.length} of ${coverage.totals.forms} form(s) covered; ${coverage.gaps.length} gap(s) remain.`,
    });
  } else {
    caveats.push(
      'Coverage is absent from this score, so it reflects only whether the tests that exist passed — not whether the right tests exist.',
    );
  }

  if (outcomes.scenariosNotRun > 0) {
    caveats.push(
      `${outcomes.scenariosNotRun} scenario(s) never executed and are excluded from the functional score rather than counted as failures. They are listed with their reason.`,
    );
  }
  if (scenarios.every((scenario) => scenario.kind === 'primary_journey')) {
    caveats.push(
      'Every scenario is a happy path. A green result here says the application works when used correctly, and nothing about how it behaves when it is not.',
    );
  }

  const denominator = parts.reduce((total, part) => total + part.weight, 0);
  const overall = denominator
    ? Number((parts.reduce((total, part) => total + part.score * part.weight, 0) / denominator).toFixed(2))
    : 0;

  return { overall, parts, caveats };
}

function classifyScenario(name: string): Scenario['kind'] {
  const lower = name.toLowerCase();
  if (/refus|invalid|wrong|empty|error|reject/.test(lower)) return 'refusal_path';
  if (/boundary|range|limit|negative number/.test(lower)) return 'boundary_value';
  return 'uncovered_flow';
}

function verdictOf(status: string | undefined, hasBaseline: boolean): Scenario['verdict'] {
  if (!hasBaseline) return 'not_run';
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'needs_review') return 'needs_review';
  if (status === undefined) return 'not_run';
  return 'error';
}

function describeOutcome(
  status: string | undefined,
  hasBaseline: boolean,
  passed: number,
  total: number,
): string {
  if (!hasBaseline) {
    return 'No executable baseline was produced, so this scenario never ran. It is not a failure of the application.';
  }
  switch (status) {
    case 'passed':
      return `All ${total} step(s) passed.`;
    case 'needs_review':
      return `${passed} of ${total} step(s) passed, and the run needs a person: either the healer reached its cap or a repair passed while the application stayed unhealthy.`;
    case 'failed':
      return `${passed} of ${total} step(s) passed. A step acted and the expected outcome did not follow, which points at the application rather than the locator.`;
    default:
      return 'The run did not reach a verdict.';
  }
}

function describeMaybeLocator(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const entry = value as { strategy?: string; value?: string; role?: string; name?: string };
  if (entry.strategy === 'role') return `role=${entry.role}[name="${entry.name ?? ''}"]`;
  return entry.strategy ? `${entry.strategy}="${entry.value ?? ''}"` : null;
}

/**
 * The report as markdown, for a reader rather than a program.
 *
 * A PM cannot use a JSON payload, and the requirement's audience is a team
 * deciding whether to trust a suite. Ordered so the parts that qualify the headline
 * come before the headline can be misread: the score, then what it excludes, then
 * the gaps, then the detail.
 */
export function renderMarkdown(report: QualityReport): string {
  const lines: string[] = [];

  lines.push(
    `# Test quality report`,
    '',
    `**Target** ${report.targetUrl}  `,
    `**Mission** ${report.missionId}  `,
    `**Verdict** ${report.verdict}  `,
    `**Generated** ${report.generatedAt}`,
    '',
    `## Quality score: ${report.quality.overall}`,
    '',
    '| Part | Score | Weight | Basis |',
    '| --- | --- | --- | --- |',
  );
  for (const part of report.quality.parts) {
    lines.push(`| ${part.name} | ${part.score} | ${part.weight} | ${part.note} |`);
  }

  if (report.quality.caveats.length) {
    lines.push('', '**What this score does not account for**', '');
    for (const caveat of report.quality.caveats) lines.push(`- ${caveat}`);
  }

  lines.push('', '## Scenarios covered', '', '| Scenario | Kind | Steps | Verdict |', '| --- | --- | --- | --- |');
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.name} | ${scenario.kind.replace(/_/g, ' ')} | ${scenario.stepsPassed}/${scenario.stepsTotal} | ${scenario.verdict} |`,
    );
  }
  lines.push('');
  for (const scenario of report.scenarios) {
    lines.push(`- **${scenario.name}** — ${scenario.outcome}`);
  }

  lines.push('', '## Coverage gaps remaining', '');
  if (report.coverage) {
    if (report.coverage.gaps.length === 0) {
      lines.push('None. Every page, form and refusal path the crawl found is exercised.');
    } else {
      for (const gap of report.coverage.gaps) {
        lines.push(`- **${gap.kind.replace(/_/g, ' ')}** at ${gap.where}: ${gap.what} ${gap.why}`);
      }
    }
    lines.push('', `_How coverage was matched: ${report.coverage.method}_`);
  } else {
    lines.push(report.coverageNote);
  }

  lines.push('', '## Untested flow risk', '');
  if (report.coverage?.untestedFlowRisk.length) {
    for (const risk of report.coverage.untestedFlowRisk.slice(0, 10)) {
      lines.push(`- **${risk.band}** (${risk.score}) ${risk.flow}`, `  ${risk.rationale}`);
    }
  } else {
    lines.push('Nothing untested was found to rank.');
  }

  if (report.prd) {
    lines.push(
      '',
      '## Stated requirements nothing verifies',
      '',
      `${report.prd.covered} of ${report.prd.testableInBrowser} browser-testable requirement(s) appear covered, from ${report.prd.requirementsFound} found in the document.`,
      '',
    );
    for (const gap of report.prd.gaps.filter((entry) => !entry.covered)) {
      lines.push(`- **${gap.id}** ${gap.requirement}`, `  ${gap.basis}`);
    }
    lines.push('', `_${report.prd.caveat}_`);
  }

  if (report.application) {
    const app = report.application;
    lines.push(
      '',
      '## The application under test',
      '',
      'Measured while the tests ran, and deliberately not part of the quality score above —',
      'that score is about the suite, these are about the application.',
      '',
      '| Aspect | Result |',
      '| --- | --- |',
      `| Accessibility | **${app.accessibility.score}/100** across ${app.accessibility.pagesAudited} page audit(s), ${app.accessibility.violations} violation(s) |`,
      `| Security | **${app.security.score}/100** across ${app.security.pagesAudited} page audit(s), ${app.security.findings} finding(s) |`,
      `| Visual | ${app.visual.pagesCompared} page(s) compared, ${app.visual.layoutShifts} layout shift(s), ${app.visual.contentMissing} content missing |`,
    );
    if (app.accessibility.elementFindings) {
      lines.push(
        '',
        `${app.accessibility.elementFindings} finding(s) are on the specific elements the tests depend on` +
          (app.accessibility.checksFailed.length
            ? ` (${app.accessibility.checksFailed.join(', ')})`
            : '') +
          '. A page can score well while the one control a test needs is unnameable.',
      );
    }
    lines.push('', '_Scores are the worst observed across runs, not an average: a single inaccessible page is a finding, not something to average away._');
  }

  lines.push('', '## Healer actions', '');
  if (report.healActions.length === 0) {
    lines.push('No repairs were needed.');
  } else {
    for (const action of report.healActions) {
      lines.push(
        `- ${action.planId} ${action.stepId}: ${action.status}${
          action.confidence !== null ? ` at ${action.confidence} confidence` : ''
        }${action.fromCache ? ' (reused an earlier answer rather than consulting the model)' : ''}`,
        `  ${action.previousLocator ?? '?'} → ${action.newLocator ?? '?'}`,
        ...(action.reason ? [`  ${action.reason}`] : []),
        ...(action.verification ? [`  Verified: ${action.verification}`] : []),
      );
    }
  }

  if (report.specFiles.length) {
    lines.push('', '## Executable tests written', '');
    for (const file of report.specFiles) lines.push(`- \`${file}\``);
    lines.push(
      '',
      'Every locator in these files was resolved against the running application and confirmed to select exactly one element; every assertion was derived from what the browser did rather than from what the plan expected.',
    );
  }

  lines.push('', '## What the orchestrator decided', '');
  for (const decision of report.decisions) {
    lines.push(`- **${decision.stage}** (${decision.outcome}) ${decision.action}`, `  ${decision.reason}`);
  }

  return lines.join('\n');
}


/**
 * The analysis half of a run's completion event.
 *
 * Read from the stored event rather than from a column, because the run summary
 * keeps counts and the scores live only in the event payload. Reading what is
 * already recorded beats widening the schema for data the run already published.
 */
interface RunAnalysis {
  a11y: {
    score: number;
    violations: number;
    pages: number;
    elementFindings: number;
    elementChecks: string[];
  };
  security: { score: number; findings: number; pages: number };
  visual: {
    pagesCompared: number;
    pagesRecorded: number;
    cosmeticAbsorbed: number;
    layoutShifts: number;
    missing: number;
  };
}

function readAnalysis(runId: string): RunAnalysis | null {
  const complete = listRunEvents(runId).find((event) => event.type === 'RUN_COMPLETE');
  if (!complete) return null;
  // Already parsed by listRunEvents — JSON.parse on it silently threw and swallowed
  // the whole analysis section, which is why the report shipped without it once.
  const payload = complete.payload as Partial<RunAnalysis> | null;
  if (!payload || typeof payload !== 'object') return null;
  return payload.a11y && payload.security && payload.visual ? (payload as RunAnalysis) : null;
}

/**
 * One application view across every run in the mission.
 *
 * Scores take the WORST across runs, not the mean. A mission that visits five
 * clean pages and one inaccessible one has found an inaccessible page, and
 * averaging it away is how a real defect becomes a rounding error. Counts sum,
 * because they are counts.
 */
function mergeAnalysis(entries: (RunAnalysis | null)[]): QualityReport['application'] {
  const present = entries.filter((entry): entry is RunAnalysis => entry !== null);
  if (!present.length) return null;

  const checks = new Set<string>();
  for (const entry of present) for (const check of entry.a11y.elementChecks) checks.add(check);

  return {
    accessibility: {
      score: Math.min(...present.map((entry) => entry.a11y.score)),
      violations: present.reduce((total, entry) => total + entry.a11y.violations, 0),
      pagesAudited: present.reduce((total, entry) => total + entry.a11y.pages, 0),
      elementFindings: present.reduce((total, entry) => total + entry.a11y.elementFindings, 0),
      checksFailed: [...checks],
    },
    security: {
      score: Math.min(...present.map((entry) => entry.security.score)),
      findings: present.reduce((total, entry) => total + entry.security.findings, 0),
      pagesAudited: present.reduce((total, entry) => total + entry.security.pages, 0),
    },
    visual: {
      pagesCompared: present.reduce((total, entry) => total + entry.visual.pagesCompared, 0),
      pagesFirstSeen: present.reduce((total, entry) => total + entry.visual.pagesRecorded, 0),
      cosmeticAbsorbed: present.reduce((total, entry) => total + entry.visual.cosmeticAbsorbed, 0),
      layoutShifts: present.reduce((total, entry) => total + entry.visual.layoutShifts, 0),
      contentMissing: present.reduce((total, entry) => total + entry.visual.missing, 0),
    },
  };
}
