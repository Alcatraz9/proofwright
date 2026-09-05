import type { SiteMap } from '../explore/types.js';
import type { IntentPlan } from '../intent/types.js';
import type { CoverageGap, CoverageReport, UntestedFlowRisk } from './types.js';

/**
 * Compares what the crawl found against what the plans test.
 *
 * No model calls. Coverage that changes between two runs against an unchanged
 * application is not a measurement, and this number is meant to be quotable.
 *
 * The matching is honest about being a heuristic. Plans describe their targets in
 * prose — "the email input field", "sign in button" — because that is what makes
 * them reviewable, and prose does not join to a DOM inventory the way an id would.
 * So a form counts as covered when a plan step mentions one of its field labels,
 * and the report says so in `method` rather than presenting the match as a fact.
 * A reader who disagrees with a call can see exactly what produced it.
 */

const METHOD =
  'A page counts as covered when a plan navigates to it or asserts on it; a form when a step names one of its field labels; a negative path when a step expresses that kind of refusal. Matching is by normalised label text, so a plan that renames a field in its own words may read as uncovered.';

/** Words that mark a flow as consequential when it goes wrong. */
const CONSEQUENCE = [
  { hints: ['password', 'sign in', 'login', 'log in', 'auth', 'session'], weight: 0.9, why: 'it controls access' },
  { hints: ['checkout', 'payment', 'card', 'order', 'basket', 'cart', 'price', 'total'], weight: 0.9, why: 'it moves money' },
  { hints: ['delete', 'remove', 'cancel', 'deactivate', 'clear'], weight: 0.85, why: 'it destroys data' },
  { hints: ['address', 'profile', 'account', 'settings', 'email'], weight: 0.6, why: 'it holds personal data' },
  { hints: ['search', 'filter', 'sort', 'browse', 'catalog', 'catalogue'], weight: 0.35, why: 'it is a browse path' },
];

export function evaluateCoverage(map: SiteMap, plans: IntentPlan[]): CoverageReport {
  // One lowercased haystack per plan. Crude and deliberate: the alternative is a
  // model call per plan per element, which turns a free measurement into a costed
  // one and makes the number non-reproducible.
  const haystacks = plans.map((plan) =>
    [
      plan.name,
      plan.description,
      ...plan.steps.flatMap((step) => [
        step.intent,
        step.target?.description ?? '',
        step.target?.context ?? '',
        step.expectedOutcome?.description ?? '',
      ]),
    ]
      .join(' \n ')
      .toLowerCase(),
  );

  const mentions = (needle: string): boolean => {
    const cleaned = needle.trim().toLowerCase();
    if (cleaned.length < 3) return false;
    return haystacks.some((hay) => hay.includes(cleaned));
  };

  const coveredPages: string[] = [];
  const coveredForms: string[] = [];
  const coveredNegatives: string[] = [];
  const gaps: CoverageGap[] = [];

  let totalForms = 0;
  let totalNegatives = 0;

  for (const page of map.pages) {
    const path = new URL(page.url).pathname;
    const pageCovered = mentions(path) || mentions(page.title) || mentions(page.url);
    if (pageCovered) coveredPages.push(page.url);

    for (const form of page.forms) {
      totalForms += 1;
      const label = `${page.url} form#${form.index}`;
      const formCovered = form.fields.some((field) => mentions(field.label));

      /**
       * A form nothing can submit is not a coverage gap, it is a fact about the form.
       * Reported as such rather than as work to do, because asking the planner to
       * submit a form with no submit control spends a model call to produce a plan
       * that cannot resolve.
       */
      if (form.untestableHere.length) {
        for (const reason of form.untestableHere) {
          gaps.push({
            kind: 'unexplored',
            where: label,
            what: `Not testable through the browser: ${reason.kind.replace(/_/g, ' ')}.`,
            why: reason.why,
          });
        }
        if (formCovered) coveredForms.push(label);
        continue;
      }

      if (formCovered) {
        coveredForms.push(label);
      } else {
        gaps.push({
          kind: 'missing_flow',
          where: label,
          what: `Nothing fills ${form.isAuth ? 'the sign-in form' : 'this form'} (${form.fields
            .map((field) => field.label)
            .join(', ')}).`,
          why: form.isAuth
            ? 'It is the sign-in form, so everything behind it is untested as well.'
            : `The crawl found it with ${form.fields.length} field(s) and no plan touches any of them.`,
        });
      }

      for (const negative of form.negativeOpportunities) {
        totalNegatives += 1;
        const key = `${label} ${negative.kind}`;
        if (negativeCovered(negative.kind, haystacks)) {
          coveredNegatives.push(key);
        } else {
          gaps.push({
            kind: negative.kind === 'out_of_range' ? 'missing_edge_case' : 'missing_error_state',
            where: `${label} — ${negative.field}`,
            what: describeMissing(negative.kind, negative.field),
            why: negative.why,
          });
        }
      }
    }

    if (!pageCovered && page.forms.length === 0) {
      gaps.push({
        kind: 'missing_flow',
        where: page.url,
        what: 'No plan visits this page.',
        why: `The crawl reached it ${page.depth} click(s) from the entry point with ${page.elementCount} interactive element(s).`,
      });
    }
  }

  for (const entry of map.unvisited) {
    gaps.push({
      kind: 'unexplored',
      where: entry.url,
      what: 'Never explored, so nothing is known about what it contains.',
      why: entry.reason,
    });
  }

  const untestedFlowRisk = rankRisk(map, gaps);

  /**
   * Negative paths carry the most weight on purpose. Every generated suite covers
   * the happy path — that is the easy half, and a score dominated by it would read
   * as healthy on a suite that never once checks the application refuses anything.
   */
  const score = weightedScore([
    { covered: coveredPages.length, total: map.pages.length, weight: 0.25 },
    { covered: coveredForms.length, total: totalForms, weight: 0.3 },
    { covered: coveredNegatives.length, total: totalNegatives, weight: 0.45 },
  ]);

  return {
    covered: {
      pages: coveredPages,
      forms: coveredForms,
      negativePaths: coveredNegatives,
    },
    totals: {
      pages: map.pages.length,
      forms: totalForms,
      negativePaths: totalNegatives,
    },
    gaps,
    untestedFlowRisk,
    score,
    method: METHOD,
  };
}

/**
 * Whether any plan expresses this kind of refusal test.
 *
 * Matched on the vocabulary a plan would actually use. A plan testing an empty
 * submission says "empty" or "blank" or "without filling"; one testing a bad login
 * says "wrong" or "incorrect" or "invalid password". Missing a real match here
 * reports a gap that is already covered, which is the safe direction to be wrong
 * in: it over-reports work to do rather than claiming coverage that is absent.
 */
function negativeCovered(kind: string, haystacks: string[]): boolean {
  const vocabulary: Record<string, string[]> = {
    empty_required: ['empty', 'blank', 'without filling', 'no value', 'leave it unfilled', 'omit'],
    malformed_email: ['malformed', 'invalid email', 'not an email', 'without an @', 'bad email'],
    wrong_credential: [
      'wrong password',
      'incorrect password',
      'invalid password',
      'wrong credential',
      'bad password',
      'invalid credential',
      'failed login',
    ],
    out_of_range: ['negative', 'out of range', 'too large', 'zero quantity', 'absurd'],
  };
  const words = vocabulary[kind] ?? [];
  return haystacks.some((hay) => words.some((word) => hay.includes(word)));
}

function describeMissing(kind: string, field: string): string {
  switch (kind) {
    case 'empty_required':
      return `Nothing submits the form with ${field} left empty to confirm it is refused.`;
    case 'malformed_email':
      return `Nothing gives ${field} a malformed address to confirm it is rejected.`;
    case 'wrong_credential':
      return 'Nothing attempts a sign-in with the wrong password to confirm it fails and grants no session.';
    case 'out_of_range':
      return `Nothing gives ${field} an out-of-range value to confirm it is refused.`;
    default:
      return `Nothing exercises ${field} negatively.`;
  }
}

/**
 * Ranks untested flows by what going wrong would cost, times how many people
 * would meet it.
 *
 * Depth stands in for exposure: a form on the entry page is on everyone's path,
 * and one three clicks deep is on fewer. It is a proxy and named as such in the
 * rationale, so nobody mistakes it for measured traffic.
 */
function rankRisk(map: SiteMap, gaps: CoverageGap[]): UntestedFlowRisk[] {
  const depthOf = new Map<string, number>();
  for (const page of map.pages) depthOf.set(page.url, page.depth);

  const risks: UntestedFlowRisk[] = [];

  for (const gap of gaps) {
    if (gap.kind === 'unexplored') continue; // nothing is known about it to weigh

    const haystack = `${gap.where} ${gap.what}`.toLowerCase();
    const match =
      CONSEQUENCE.find((entry) => entry.hints.some((hint) => haystack.includes(hint))) ?? {
        weight: 0.4,
        why: 'it is an ordinary interaction',
      };

    /**
     * Longest match wins. A plain `find` returned the shortest prefix, so a product
     * page three levels down matched the entry URL and every deep flow was scored as
     * if it sat on the front page — inflating exactly the flows least likely to be
     * reached.
     */
    const pageUrl = [...depthOf.keys()]
      .filter((url) => gap.where.startsWith(url))
      .sort((a, b) => b.length - a.length)[0];
    const depth = pageUrl ? (depthOf.get(pageUrl) ?? 0) : 0;
    // Halves every two clicks, floored so a deep flow never scores zero.
    const exposure = Math.max(0.4, 1 - depth * 0.2);

    const score = Number((match.weight * exposure).toFixed(2));
    risks.push({
      flow: gap.where,
      score,
      band: score >= 0.65 ? 'high' : score >= 0.4 ? 'medium' : 'low',
      rationale: `Scored ${score} because ${match.why} (${match.weight}) and it sits ${depth} click(s) from the entry point, which is a proxy for how many users meet it (${exposure.toFixed(2)}). Untested: ${gap.what}`,
    });
  }

  return risks.sort((a, b) => b.score - a.score);
}

function weightedScore(parts: { covered: number; total: number; weight: number }[]): number {
  let numerator = 0;
  let denominator = 0;
  for (const part of parts) {
    // A dimension with nothing in it is not a free full mark, nor a zero: it is
    // simply not part of the question.
    if (part.total === 0) continue;
    numerator += (part.covered / part.total) * part.weight;
    denominator += part.weight;
  }
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(2));
}

/** The gaps worth asking the planner to fill, highest risk first. */
export function fillableGaps(report: CoverageReport, limit = 3): CoverageGap[] {
  const ranked = new Map(report.untestedFlowRisk.map((risk) => [risk.flow, risk.score]));
  return report.gaps
    .filter((gap) => gap.kind !== 'unexplored')
    .sort((a, b) => (ranked.get(b.where) ?? 0) - (ranked.get(a.where) ?? 0))
    .slice(0, limit);
}
