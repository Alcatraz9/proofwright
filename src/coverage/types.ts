import { z } from 'zod';

/**
 * What the plans cover, what they do not, and what the gaps are worth.
 *
 * Two of the six fields the final report must carry live here — "coverage gaps
 * remaining" and "untested flow risk" — and neither existed anywhere before. They
 * are computed rather than asked of a model, for the same reason the crawl is
 * deterministic: a coverage number that changes between two runs against the same
 * application is not a measurement.
 *
 * Everything here carries its reasoning. A QA engineer handed a risk score of 0.8
 * with no account of where it came from will either ignore it or, worse, act on it
 * without being able to argue with it.
 */

export const gapKindSchema = z.enum([
  /** A page or form nothing touches at all. */
  'missing_flow',
  /** A boundary the form invites and no plan tries — a malformed email, a bad quantity. */
  'missing_edge_case',
  /** A refusal path: empty required fields, wrong credentials. */
  'missing_error_state',
  /** Reachable but never reached, because the crawl ran out of budget. */
  'unexplored',
]);

export type GapKind = z.infer<typeof gapKindSchema>;

export const coverageGapSchema = z.object({
  kind: gapKindSchema,
  /** Where, in terms a reader can go and look at. */
  where: z.string(),
  /** What is not tested, stated as the test that is missing. */
  what: z.string(),
  /** Why it matters, and what evidence in the map says so. */
  why: z.string(),
});

export type CoverageGap = z.infer<typeof coverageGapSchema>;

export const untestedFlowRiskSchema = z.object({
  flow: z.string(),
  /** 0-1. Meaningless without the rationale, which is why it never travels alone. */
  score: z.number(),
  band: z.enum(['low', 'medium', 'high']),
  /**
   * The arithmetic in words: what made it consequential and how many clicks from
   * the entry point it sits. A score whose derivation cannot be read is a score
   * nobody should act on.
   */
  rationale: z.string(),
});

export type UntestedFlowRisk = z.infer<typeof untestedFlowRiskSchema>;

export const coverageReportSchema = z.object({
  /** Pages, forms and negative paths reached by at least one plan. */
  covered: z.object({
    pages: z.array(z.string()),
    forms: z.array(z.string()),
    negativePaths: z.array(z.string()),
  }),
  /** Denominators, so a percentage can be checked rather than trusted. */
  totals: z.object({
    pages: z.number(),
    forms: z.number(),
    negativePaths: z.number(),
  }),
  gaps: z.array(coverageGapSchema),
  untestedFlowRisk: z.array(untestedFlowRiskSchema),
  /**
   * 0-1 across pages, forms and negative paths, weighted toward negative paths
   * because every suite covers the happy path and the absence of refusal tests is
   * what makes a green suite misleading.
   */
  score: z.number(),
  /**
   * How a plan step was matched to a mapped element. Disclosed because the match
   * is a heuristic over prose, not a fact: a reader who disagrees with a "covered"
   * call is entitled to know what produced it.
   */
  method: z.string(),
});

export type CoverageReport = z.infer<typeof coverageReportSchema>;
