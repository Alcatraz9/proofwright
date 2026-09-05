import type { CoverageGap } from '../coverage/types.js';
import type { SiteMap } from '../explore/types.js';
import { summariseForPlanner } from '../explore/types.js';

/**
 * Asking for the tests nobody asked for.
 *
 * The existing planner's governing rule is that every step traces to something the
 * tester wrote, which is why its plans are trustworthy and also why it will never
 * propose a wrong-password test: nobody mentioned one. That rule is not weakened
 * here. It is pointed at a second source of evidence.
 *
 * A gap named by the coverage evaluator is an observation, not a wish: the crawl
 * found a form, the form marks two fields required, and no plan submits it empty.
 * Asking for that test invents nothing — the form itself raises the question. So
 * the instruction below hands over the gap and the map, and the same prompt rules,
 * the same schema and the same validator apply unchanged.
 *
 * This is where "not just happy paths" actually gets satisfied. The happy path
 * comes from intent; the refusals come from what the application admits it checks.
 */
export function buildGapFillingInstruction(
  gaps: CoverageGap[],
  map: SiteMap,
  credentialRefs: string[] = [],
): string {
  const lines: string[] = [];

  lines.push(
    'Test what this application refuses, not what it accepts. Each item below is a check the application invites and nothing currently makes.',
    '',
  );

  for (const [index, gap] of gaps.entries()) {
    lines.push(`${index + 1}. ${gap.what}`);
    lines.push(`   On this page, and nowhere else: ${pageOf(gap.where)}`);
    lines.push(`   Why it matters: ${gap.why}`);
  }

  lines.push(
    '',
    /**
     * Stated first because omitting it produced a real failure: a plan tried the
     * newsletter form's submit button on the catalogue page, where the form does not
     * exist. The gap named its page and the planner had no instruction to go there.
     */
    'Navigate to the page named for each item before acting on it. An element only exists on its own page, and a step that looks for it elsewhere will not resolve.',
    '',
    'For each one, drive the application to the state where the check applies, perform the action that should be refused, and assert on the refusal — an error message, a field marked invalid, a page that does not advance.',
    '',
    'Three things to hold to. Assert the refusal itself, not merely that nothing happened: a form that silently swallows a bad submission is a defect, and a test that passes on silence would hide it. Sign in only if the page you need is marked as requiring it, and never before acting on the sign-in page itself, because signing in navigates away from it. And only the step under test should use a bad value; every other step uses working input.',
    '',
    summariseForPlanner(map),
    ...(credentialRefs.length
      ? [
          '',
          `When a step needs a working login, reference these exact names and no others: ${credentialRefs.join(', ')}.`,
        ]
      : []),
  );

  return lines.join('\n');
}

/**
 * A stable, readable id for the plan that fills these gaps.
 *
 * Named for what it tests rather than numbered, because a run list showing
 * "negative-paths-sign-in" beside "primary-journey" tells a reader what the suite
 * covers at a glance, which "plan-2" does not.
 */
export function gapPlanName(gaps: CoverageGap[]): string {
  const kinds = new Set(gaps.map((gap) => gap.kind));
  if (kinds.has('missing_error_state')) return 'Refusal paths';
  if (kinds.has('missing_edge_case')) return 'Boundary values';
  return 'Uncovered flows';
}

/**
 * The page part of a gap location, dropping the form suffix.
 *
 * `where` is written for a human to read — "https://x/app form#1 — Email" — and the
 * planner needs the URL out of it, or it treats the whole string as a description
 * and navigates nowhere.
 */
function pageOf(where: string): string {
  const match = /^(\S+)/.exec(where.trim());
  return match?.[1] ?? where;
}
