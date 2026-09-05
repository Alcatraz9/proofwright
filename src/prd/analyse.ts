import { z } from 'zod';
import { generateJson } from '../llm/generate.js';
import type { IntentPlan } from '../intent/types.js';

/**
 * Reading a product requirements document, and saying which of its requirements
 * nothing tests.
 *
 * The good-to-have and the bonus in the problem statement are the same mechanism
 * seen from two ends: a PRD informs what to test, and comparing it against the
 * plans afterwards shows what was left out. Both are done here.
 *
 * This is a different question from the coverage evaluator's. That one asks what
 * the *application* affords and nothing exercises — a required field nobody submits
 * empty. This one asks what the *specification* promises and nothing checks. An
 * application can be fully exercised and still leave a stated requirement
 * unverified, and it is the second gap a PM actually cares about.
 *
 * The extraction is a model call. A requirements document is prose with no
 * structure to parse, so unlike the crawl there is nothing deterministic to do —
 * but it is one call for the whole document, not one per requirement.
 */

const requirementSchema = z.object({
  /** Short handle, e.g. "R1". */
  id: z.string(),
  /** The requirement in the document's own words, condensed to one sentence. */
  statement: z.string(),
  /**
   * Whether this is something a browser test could verify at all. A performance
   * budget or a compliance obligation is a real requirement and not one a UI test
   * settles, and reporting it as an untested gap would be noise dressed as rigour.
   */
  testableInBrowser: z.boolean(),
  /** Words a plan would use if it tested this, for matching afterwards. */
  keywords: z.array(z.string()),
});

const extractionSchema = z.object({
  requirements: z.array(requirementSchema),
});

export type Requirement = z.infer<typeof requirementSchema>;

export const prdGapSchema = z.object({
  requirement: z.string(),
  id: z.string(),
  covered: z.boolean(),
  /** Which plan appears to test it, when one does. */
  coveredBy: z.string().nullable(),
  /** Why this was judged covered or not, so the call can be argued with. */
  basis: z.string(),
});

export type PrdGap = z.infer<typeof prdGapSchema>;

export const prdAnalysisSchema = z.object({
  requirementsFound: z.number(),
  testableInBrowser: z.number(),
  covered: z.number(),
  gaps: z.array(prdGapSchema),
  /** What this analysis cannot settle, stated rather than left implied. */
  caveat: z.string(),
});

export type PrdAnalysis = z.infer<typeof prdAnalysisSchema>;

const SYSTEM = `You read product requirements documents and list the individual requirements they state.

Rules:
- One requirement per entry. A paragraph describing three behaviours is three requirements.
- Use the document's own words, condensed. Do not add requirements it does not state, and do not soften ones it does.
- Mark testableInBrowser false for anything a browser test cannot settle: performance budgets, uptime, security posture, analytics, legal or compliance obligations, anything about infrastructure.
- keywords are the words a test plan would plausibly use for this requirement — feature names, field labels, page names, user actions.`;

export async function extractRequirements(prd: string): Promise<Requirement[]> {
  const result = await generateJson({
    prompt: `Product requirements document:\n"""\n${prd.slice(0, 20_000)}\n"""\n\nList the requirements it states.`,
    schema: extractionSchema,
    systemInstruction: SYSTEM,
  });
  const parsed = extractionSchema.safeParse(result.data);
  return parsed.success ? parsed.data.requirements : [];
}

/**
 * Which requirements the plans appear to test.
 *
 * Keyword matching against the plans' own prose, and deliberately the same
 * heuristic the coverage evaluator uses, with the same disclosure: it can call a
 * requirement uncovered when a plan tests it in different words. Erring that way is
 * the right direction — over-reporting work to do is recoverable, and claiming a
 * requirement is verified when nothing checks it is the failure that matters.
 */
export function analysePrdCoverage(
  requirements: Requirement[],
  plans: { planId: string; plan: IntentPlan }[],
): PrdAnalysis {
  const haystacks = plans.map((entry) => ({
    planId: entry.planId,
    text: [
      entry.plan.name,
      entry.plan.description,
      ...entry.plan.steps.flatMap((step) => [
        step.intent,
        step.target?.description ?? '',
        step.expectedOutcome?.description ?? '',
      ]),
    ]
      .join(' ')
      .toLowerCase(),
  }));

  const gaps: PrdGap[] = [];
  let covered = 0;
  let testable = 0;

  for (const requirement of requirements) {
    if (!requirement.testableInBrowser) {
      gaps.push({
        id: requirement.id,
        requirement: requirement.statement,
        covered: false,
        coveredBy: null,
        basis:
          'Not verifiable by a browser test, so this pipeline makes no claim about it. It still needs verifying by other means.',
      });
      continue;
    }
    testable += 1;

    const keywords = requirement.keywords
      .map((keyword) => keyword.trim().toLowerCase())
      .filter((keyword) => keyword.length >= 3);

    // Two matching keywords rather than one. A single common word — "user", "page"
    // — matches almost any plan and would report broad coverage that is not there.
    const match = haystacks.find(
      (entry) => keywords.filter((keyword) => entry.text.includes(keyword)).length >= 2,
    );

    if (match) {
      covered += 1;
      const hit = keywords.filter((keyword) => match.text.includes(keyword));
      gaps.push({
        id: requirement.id,
        requirement: requirement.statement,
        covered: true,
        coveredBy: match.planId,
        basis: `"${match.planId}" mentions ${hit.slice(0, 4).map((word) => `"${word}"`).join(', ')}.`,
      });
    } else {
      gaps.push({
        id: requirement.id,
        requirement: requirement.statement,
        covered: false,
        coveredBy: null,
        basis: `No plan mentions ${keywords.slice(0, 4).map((word) => `"${word}"`).join(', ') || 'anything from this requirement'}.`,
      });
    }
  }

  return {
    requirementsFound: requirements.length,
    testableInBrowser: testable,
    covered,
    gaps,
    caveat:
      'Requirements are matched to plans by keyword, so a plan that tests a requirement in different words reads as uncovered. The matching errs toward reporting a gap rather than claiming coverage, because an overstated suite is the more expensive mistake.',
  };
}

/** The requirements worth asking the planner to cover, most specific first. */
export function uncoveredRequirements(analysis: PrdAnalysis, limit = 3): PrdGap[] {
  return analysis.gaps
    .filter((gap) => !gap.covered && gap.basis.startsWith('No plan'))
    .sort((a, b) => b.requirement.length - a.requirement.length)
    .slice(0, limit);
}
