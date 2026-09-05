import { z } from 'zod';
import type { SiteMap } from '../explore/types.js';
import type { IntentPlan } from '../intent/types.js';
import { generateJson } from '../llm/generate.js';

/**
 * The critic: a second pair of eyes on a plan before anything executes it.
 *
 * Structural validation already guarantees a plan is *well-formed* — sequential
 * ids, legal action fields, grounded sourcePhrases. Nothing until now judged
 * whether it is a *good test*. The failure modes it exists to catch are the ones
 * that make a generated suite quietly worthless: an assertion aimed at the button
 * that was just clicked rather than at what clicking it caused; a refusal test
 * that never asserts the refusal, so silent acceptance of bad input passes; a
 * step reaching for a page the crawl never saw.
 *
 * Token discipline is part of the design, not an afterthought. The plan travels
 * as numbered one-line renderings rather than JSON (roughly a quarter of the
 * size), the site map travels as a one-line digest of page paths, and the output
 * schema is four small fields. One call costs about 800-1,000 tokens against the
 * ~25,000 a mission already spends — and one bad plan caught here saves a full
 * record-and-execute cycle, which costs far more than the review did.
 *
 * The critic can demand one revision, never more. Its findings are appended to
 * the planning instruction and the planner runs once again; a second rejection is
 * recorded and the mission proceeds with the revised plan. An unbounded
 * critic-planner loop would let two models spend the day disagreeing.
 */

const findingSchema = z.object({
  stepId: z.string().describe('The step this concerns, e.g. "step-4".'),
  problem: z.string().describe('What is weak or wrong, in one sentence.'),
  fix: z.string().describe('What the step should do instead, in one sentence.'),
});

const critiqueSchema = z.object({
  verdict: z
    .enum(['accept', 'revise'])
    .describe('accept when the plan would produce a trustworthy test as written.'),
  findings: z
    .array(findingSchema)
    .describe('Empty when accepting. Each finding names one concrete defect.'),
});

export type Critique = z.infer<typeof critiqueSchema>;

const SYSTEM = `You review a QA test plan before it is executed. Judge whether it would produce a TRUSTWORTHY test, not whether it is well-formatted — formatting was already checked.

Flag a step only for these defects:

1. Weak assertion: a click or navigate whose expected outcome restates the action ("the button is clicked") instead of observing its effect ("the basket count increases").
2. Self-referential assertion: an assert step aimed at the control that was just used, rather than at what using it changed.
3. Unasserted refusal: a step that submits invalid input with no later step asserting the refusal (an error message, a page that does not advance). A form that silently swallows bad input is a defect the test must be able to see.
4. Unreachable target: a step acting on a page or element the application summary does not support.
5. Order dependence: an assert placed before the action that produces what it asserts.
6. Dead end: a plan that ends on an input step with nothing observed afterwards.

Rules: cite step ids that exist; one finding per defect; no style opinions; no new test ideas — improving coverage is another stage's job. When the plan is sound, accept it. Most sound plans deserve acceptance on first read.`;

/** One line per step: a quarter of the tokens of the JSON form, and easier to cite. */
export function renderPlanForCritique(plan: IntentPlan): string {
  return plan.steps
    .map((step) => {
      const parts = [`${step.id}: ${step.action}`];
      if (step.target?.description) parts.push(`target="${step.target.description}"`);
      if (step.value !== null && step.value !== undefined) parts.push(`value="${step.value}"`);
      if (step.valueRef) parts.push(`valueRef=${step.valueRef}`);
      const outcome = step.expectedOutcome?.description;
      parts.push(outcome ? `expect="${outcome}"` : 'expect=(none)');
      return parts.join(' ');
    })
    .join('\n');
}

/** The map as one line per page: enough to judge reachability, nothing more. */
export function digestSiteMap(map: SiteMap): string {
  return map.pages
    .map((page) => {
      const forms = page.forms.length
        ? ` forms: ${page.forms.map((f) => f.fields.map((x) => x.label).join('+')).join('; ')}`
        : '';
      return `- ${new URL(page.url).pathname}${page.behindAuth ? ' (needs sign-in)' : ''}${forms}`;
    })
    .join('\n');
}

export async function critiquePlan(
  plan: IntentPlan,
  map: SiteMap | null,
): Promise<{ critique: Critique; model: string }> {
  const prompt = [
    `Plan under review: "${plan.name}"`,
    '',
    renderPlanForCritique(plan),
    ...(map ? ['', 'The application, as explored:', digestSiteMap(map)] : []),
  ].join('\n');

  const { data, model } = await generateJson({
    prompt,
    schema: critiqueSchema,
    systemInstruction: SYSTEM,
    temperature: 0,
  });

  return { critique: critiqueSchema.parse(data), model };
}

/**
 * The critique as a revision instruction the existing planner understands.
 *
 * Reuses the plan pipeline rather than asking the critic to rewrite steps
 * itself: the planner owns the schema, the validator and the grounding rules,
 * and a critic that edits plans directly would need all three duplicated.
 */
export function buildRevisionInstruction(original: string, critique: Critique): string {
  return [
    original,
    '',
    'A reviewer examined the previous plan and requires these corrections. Address every one; keep everything else unchanged:',
    ...critique.findings.map(
      (finding) => `- ${finding.stepId}: ${finding.problem} Instead: ${finding.fix}`,
    ),
  ].join('\n');
}
