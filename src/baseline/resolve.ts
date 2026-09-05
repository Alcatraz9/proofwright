import { z } from 'zod';
import { generateJson } from '../llm/generate.js';
import { renderElementsForPrompt, type PageSnapshot } from '../browser/extract.js';
import type { IntentStep } from '../intent/types.js';

const resolutionSchema = z.object({
  ref: z
    .string()
    .nullable()
    .describe(
      'The ref of the single best matching element, exactly as shown in brackets ' +
        '(e.g. "s0e4"). Null if no element on this page satisfies the step.',
    ),
  confidence: z
    .number()
    .describe(
      'How certain you are, from 0 to 1. Above 0.9 means the match is unmistakable. ' +
        'Below 0.5 means you are guessing. Report your real certainty; a low score is ' +
        'more useful than a confident wrong answer.',
    ),
  reason: z
    .string()
    .describe('One sentence on why this element matches the intent, or why nothing does.'),
});

export type StepResolution = z.infer<typeof resolutionSchema>;

const SYSTEM_INSTRUCTION = `You match one step of a QA test to one element on a web page.

You are given the step's intent and a semantic description of its target, plus every
candidate element currently on the page. Choose the single element a human tester would
click, fill or check for this step.

RULES

1. Choose from the given elements only. Return the ref verbatim. Never invent a ref.

2. If no element on this page satisfies the step, return ref: null with a low confidence
   and say what is missing. That is a correct and useful answer — the page may simply be
   the wrong one, and a wrong guess is far more damaging than an honest miss.

3. Match on meaning, not on wording. "sign in action" matches a button named "Log in".
   Role matters: a "fill" step needs a textbox, a "click" step needs something clickable.

4. Use the target's context and the elements' "in=" and "near=" fields to disambiguate
   repeated elements. If several elements match equally well and nothing distinguishes
   them, lower your confidence and say so.

5. Prefer the element that does the step's job directly. For "proceed to checkout",
   a button named "Checkout" beats a nav link named "Cart" that would eventually get there.

6. Elements marked DISABLED cannot be acted on. Elements marked "static" are not
   clickable and are only valid targets for assert or waitFor steps.`;

export interface ResolveStepParams {
  step: IntentStep;
  snapshot: PageSnapshot;
  /** Steps already executed, so the model knows where in the flow it is. */
  history: string[];
  /**
   * Refs of elements the previous action caused to appear — computed by the
   * recorder from a before/after DOM diff, not guessed. An assert step that
   * follows an action is usually about what the action produced (an error
   * alert, a confirmation, a destination heading), so these are named to the
   * model as the prime candidates rather than left to compete on wording alone.
   */
  appearedRefs?: string[];
}

export async function resolveStep({
  step,
  snapshot,
  history,
  appearedRefs = [],
}: ResolveStepParams): Promise<{ resolution: StepResolution; model: string }> {
  const target = step.target;

  /**
   * Two token reductions, both chosen because they cannot change the answer.
   *
   * History is capped to the last three steps. Its purpose is orientation — "we
   * just signed in, so we are past the login page" — and step-1 stops informing
   * that judgement long before step-9 runs. Uncapped, this line grows linearly
   * and a long plan pays for its own past on every call.
   *
   * The element list is filtered by what the action can possibly act on. A fill
   * step's answer is an input control by definition: sending the page's links and
   * headings alongside them spends tokens on candidates the rules already forbid.
   * Assert and waitFor see everything, because their target can be anything.
   * Disabled elements are kept for actionable steps on purpose — "the button is
   * disabled" is a diagnosis the model can only make if it can see the button.
   */
  const recentHistory = history.slice(-3);
  const candidates = filterByAction(snapshot, step.action);
  // Only refs that survived the action filter: naming a ref the model cannot
  // pick would invite exactly the invented-ref failure the rules forbid.
  const visibleAppeared = appearedRefs.filter((ref) =>
    candidates.elements.some((el) => el.ref === ref),
  );

  const prompt = [
    recentHistory.length > 0
      ? `Steps already completed (most recent):\n${recentHistory.map((h) => `  - ${h}`).join('\n')}\n`
      : '',
    'Step to resolve:',
    `  intent: ${step.intent}`,
    `  action: ${step.action}`,
    `  target: ${target?.description ?? '(none)'}`,
    `  target context: ${target?.context ?? '(none given)'}`,
    '',
    visibleAppeared.length > 0
      ? `Elements that APPEARED in response to the previous action: ${visibleAppeared.join(', ')}\n` +
        'If this step verifies the previous action\'s effect, these are the prime candidates —\n' +
        'they are what the action actually produced.\n'
      : '',
    'Candidate elements on the current page:',
    renderElementsForPrompt(candidates),
    '',
    'Return the single best matching element.',
  ]
    .filter(Boolean)
    .join('\n');

  const { data, model } = await generateJson({
    prompt,
    schema: resolutionSchema,
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0,
  });

  return { resolution: resolutionSchema.parse(data), model };
}

/** Roles that an input-writing action can act on. */
const FILLABLE_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'slider',
  'checkbox',
  'radio',
  'switch',
  'listbox',
]);

/**
 * The subset of the page this action could possibly target.
 *
 * Deliberately conservative: a step kind is only narrowed when the excluded
 * elements are *impossible* answers under the system prompt's own rules, so the
 * filter can shrink the prompt but never the answer space. Anything uncertain
 * passes through untouched.
 */
export function filterByAction(snapshot: PageSnapshot, action: string): PageSnapshot {
  let keep: (el: PageSnapshot['elements'][number]) => boolean;

  switch (action) {
    case 'fill':
    case 'select':
    case 'check':
    case 'uncheck':
      // The answer must be an input control; tagName covers roleless markup.
      keep = (el) =>
        FILLABLE_ROLES.has(el.role) || ['input', 'select', 'textarea'].includes(el.tagName);
      break;
    case 'click':
    case 'press':
    case 'hover':
      // The answer must be interactive. Disabled stays visible for diagnosis.
      keep = (el) => el.interactive;
      break;
    default:
      // assert / waitFor / navigate: any element can be the target. No filtering.
      return snapshot;
  }

  const elements = snapshot.elements.filter(keep);
  // A filter that empties the list has misjudged the page (unusual markup, ARIA
  // misuse). Falling back to the full inventory costs tokens once; a wrongly
  // narrowed prompt costs a resolvable step reported as missing.
  return elements.length === 0 ? snapshot : { ...snapshot, elements };
}
