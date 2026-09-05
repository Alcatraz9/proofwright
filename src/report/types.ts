import { z } from 'zod';
import { coverageReportSchema } from '../coverage/types.js';
import { prdAnalysisSchema } from '../prd/analyse.js';

/**
 * The final test quality report.
 *
 * The requirement lists six things it must carry, and this schema exists so none
 * of them can be quietly dropped: scenarios covered, pass/fail outcomes, healer
 * actions taken, coverage gaps remaining, untested flow risk, and a quality score.
 *
 * Two rules shape it.
 *
 * A score never travels without its parts. `quality.overall` is a weighted number
 * and `quality.parts` is what went into it, because a single figure is the easiest
 * thing to quote and the easiest thing to be misled by — a suite at 0.8 with zero
 * refusal coverage is a different object from one at 0.8 that tests every refusal
 * and misses an accessibility check.
 *
 * Nothing claims more than the pipeline did. Where a stage did not run, the field
 * says so rather than defaulting to a flattering value. A report that implied
 * coverage was assessed when no evaluator ran would be the one output that could
 * destroy trust in every other number here.
 */

export const scenarioSchema = z.object({
  planId: z.string(),
  /** What this scenario is for, in the words the plan was written in. */
  name: z.string(),
  intent: z.string(),
  /** Whether this scenario tests a refusal rather than a success. */
  kind: z.enum(['primary_journey', 'refusal_path', 'boundary_value', 'uncovered_flow']),
  stepsTotal: z.number(),
  stepsPassed: z.number(),
  verdict: z.enum(['passed', 'failed', 'needs_review', 'not_run', 'error']),
  /** Why it ended that way, in a sentence. */
  outcome: z.string(),
  /** Where the executable spec was written, when one was. */
  specFile: z.string().nullable(),
});

export type Scenario = z.infer<typeof scenarioSchema>;

export const healActionSchema = z.object({
  planId: z.string(),
  stepId: z.string(),
  status: z.string(),
  confidence: z.number().nullable(),
  /** The model's justification for the repair. */
  reason: z.string().nullable(),
  previousLocator: z.string().nullable(),
  newLocator: z.string().nullable(),
  /** What was checked to confirm the repair worked. */
  verification: z.string().nullable(),
  /**
   * Whether an identical earlier answer was reused instead of consulting the
   * model. Disclosed because a reader is entitled to know whether this repair was
   * reasoned about now or recalled.
   */
  fromCache: z.boolean(),
});

export type HealAction = z.infer<typeof healActionSchema>;

export const qualityReportSchema = z.object({
  missionId: z.string(),
  targetUrl: z.string(),
  generatedAt: z.string(),
  verdict: z.string(),

  /** (a) Scenarios covered — an inventory, not a step count. */
  scenarios: z.array(scenarioSchema),

  /** (b) Pass/fail outcomes, aggregated. */
  outcomes: z.object({
    scenariosTotal: z.number(),
    scenariosPassed: z.number(),
    scenariosFailed: z.number(),
    scenariosNeedingReview: z.number(),
    scenariosNotRun: z.number(),
    stepsTotal: z.number(),
    stepsPassed: z.number(),
  }),

  /** (c) Healer actions taken, with their evidence. */
  healActions: z.array(healActionSchema),

  /** (d) and (e) Coverage gaps remaining and untested flow risk. */
  coverage: coverageReportSchema.nullable(),
  /** Stated when coverage could not be assessed, so silence is never read as zero gaps. */
  coverageNote: z.string(),

  /** (f) A composite score that always shows its parts. */
  quality: z.object({
    overall: z.number(),
    parts: z.array(
      z.object({
        name: z.string(),
        score: z.number(),
        weight: z.number(),
        note: z.string(),
      }),
    ),
    /** What the number does not account for. */
    caveats: z.array(z.string()),
  }),

  /**
   * Which stated requirements nothing verifies. Null when no PRD was supplied — the
   * absence of this section never means every requirement is covered.
   */
  prd: prdAnalysisSchema.nullable(),

  /**
   * What the run observed about the application itself, per page it visited.
   *
   * Deliberately outside `quality`, and that separation is the point. `quality`
   * measures the *test suite* — whether the right tests exist and whether they
   * passed. Accessibility, security and visual regressions measure the
   * *application*. Folding them together would mean a well-tested application with
   * poor contrast scored the same as a badly-tested one with good contrast, and a
   * team could raise the number by fixing colours rather than by testing anything.
   *
   * Null when no run produced an analysis.
   */
  application: z
    .object({
      accessibility: z.object({
        /** 0-100, impact-weighted. Not a WCAG conformance claim. */
        score: z.number(),
        violations: z.number(),
        pagesAudited: z.number(),
        /**
         * Findings on the specific elements the test depends on, reported
         * separately: a page can score well while the one control a test needs is
         * unnameable, and that is the finding a test author acts on.
         */
        elementFindings: z.number(),
        checksFailed: z.array(z.string()),
      }),
      security: z.object({
        score: z.number(),
        findings: z.number(),
        pagesAudited: z.number(),
      }),
      visual: z.object({
        pagesCompared: z.number(),
        pagesFirstSeen: z.number(),
        cosmeticAbsorbed: z.number(),
        layoutShifts: z.number(),
        contentMissing: z.number(),
      }),
    })
    .nullable(),

  /** Executable specs written for this mission. */
  specFiles: z.array(z.string()),

  /** The orchestrator's own account of what it decided and why. */
  decisions: z.array(
    z.object({
      stage: z.string(),
      action: z.string(),
      reason: z.string(),
      outcome: z.string(),
    }),
  ),
});

export type QualityReport = z.infer<typeof qualityReportSchema>;
