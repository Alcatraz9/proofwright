import { z } from 'zod';
import { siteMapSchema } from '../explore/types.js';

/**
 * The stages the orchestrator drives, in order.
 *
 * Two are not built yet: `explore` lands with the crawler and `evaluate_coverage`
 * with the coverage evaluator. They are named here from the start rather than
 * added later, because a mission that skipped a stage has to be able to say so —
 * a report claiming coverage was assessed when no evaluator existed would be the
 * one lie this system cannot afford.
 */
export const STAGES = [
  'explore',
  'plan',
  'evaluate_coverage',
  'generate',
  'execute',
  'report',
] as const;

export type Stage = (typeof STAGES)[number];

export const stageSchema = z.enum(STAGES);

/**
 * What the orchestrator did at a stage boundary, and why.
 *
 * This is the product, not telemetry. The challenge asks for an agent that
 * decides "when to plan, when to generate, when to heal, and when to escalate",
 * and a decision nobody can read is indistinguishable from a hardcoded sequence.
 * Every transition writes one of these, including the boring ones, because a
 * reader learning that a stage was skipped and on what grounds is the difference
 * between an orchestrator and a shell script.
 */
export const decisionSchema = z.object({
  stage: stageSchema,
  /** Imperative, past tense: what was done. */
  action: z.string(),
  /** Why, in a sentence a QA engineer would accept. */
  reason: z.string(),
  outcome: z.enum(['ok', 'skipped', 'retried', 'escalated', 'failed']),
  at: z.string(),
  /** Milliseconds spent in the stage, when it did work. */
  durationMs: z.number().nullable(),
});

export type Decision = z.infer<typeof decisionSchema>;

/**
 * Who approves a plan.
 *
 * `supervised` is the behaviour that exists today: a human approves before
 * anything runs unattended, and that gate is a real quality feature rather than
 * friction to be removed. `autonomous` is what the challenge requires — the
 * orchestrator approves, and is required to record the reasoning it approved on.
 * The gate is not deleted, it changes hands, and the mission log says whose.
 */
export const missionModeSchema = z.enum(['autonomous', 'supervised']);
export type MissionMode = z.infer<typeof missionModeSchema>;

/**
 * One reading of coverage, and what the orchestrator did next.
 *
 * The score already appeared in a decision's prose, and that is where it stayed
 * until a reader wanted the series rather than the sentence. Three readings of
 * 0.20, 0.65 and 0.75 are the clearest evidence this pipeline produces — the
 * re-plan loop demonstrably working — and recovering them by parsing English out
 * of `action` would break the moment that sentence was reworded.
 *
 * `followedBy` is recorded because a climb that stops is not self-explanatory: a
 * reader is owed the difference between "nothing fillable was left" and "the
 * budget ran out with gaps still open", which are opposite conclusions about
 * whether the suite can be trusted.
 */
export const coverageRoundSchema = z.object({
  /** 1-based, in the order the evaluator ran. */
  round: z.number(),
  score: z.number(),
  gaps: z.number(),
  /** Numerator and denominator kept together so a ratio can be checked, not trusted. */
  refusalCovered: z.number(),
  refusalTotal: z.number(),
  formsCovered: z.number(),
  formsTotal: z.number(),
  pagesCovered: z.number(),
  pagesTotal: z.number(),
  /** What the orchestrator did after this reading. */
  followedBy: z.enum(['replanned', 'nothing_fillable', 'budget_spent', 'replan_failed']),
  at: z.string(),
});

export type CoverageRound = z.infer<typeof coverageRoundSchema>;

export const missionStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'needs_review',
  'cancelled',
  'error',
]);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

export const missionSchema = z.object({
  missionId: z.string(),
  status: missionStatusSchema,
  mode: missionModeSchema,
  stage: stageSchema.nullable(),
  targetUrl: z.string(),
  /**
   * Optional, and that is the requirement rather than a convenience: a URL is the
   * only mandatory input. When absent the planner has no stated intent to be
   * faithful to and must derive scope from the application itself.
   */
  instruction: z.string().nullable(),
  /** The requirements document this mission was given, when it was given one. */
  prd: z.string().nullable(),
  planId: z.string().nullable(),
  runId: z.string().nullable(),
  decisions: z.array(decisionSchema),
  /**
   * What the crawl saw, kept rather than discarded.
   *
   * The explorer built this to brief the planner and it was thrown away once the
   * prose summary had been taken from it, which left the interface unable to say
   * which pages need a sign-in or which controls were recorded and deliberately
   * never operated. Null when the crawl produced nothing, which is not the same
   * as an application with no pages.
   */
  siteMap: siteMapSchema.nullable(),
  /** Every coverage reading, in order, so the climb is a series and not a sentence. */
  coverageRounds: z.array(coverageRoundSchema),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type Mission = z.infer<typeof missionSchema>;

/**
 * The list payload. The site map goes too: a summary carrying every form field of
 * every page on every mission would make the index the heaviest response the
 * server sends, and the index does not draw them.
 */
export const missionSummarySchema = missionSchema
  .omit({ decisions: true, siteMap: true })
  .extend({
    decisionCount: z.number(),
    /** Present so the index can show the climb's end without fetching the mission. */
    pageCount: z.number(),
    formCount: z.number(),
  });

export type MissionSummary = z.infer<typeof missionSummarySchema>;

/** A stage that ran but is not implemented yet records this as its reason. */
export function notBuiltYet(what: string, tracked: string): string {
  return `${what} is not implemented yet (${tracked}). The mission continued without it and this report does not claim otherwise.`;
}
