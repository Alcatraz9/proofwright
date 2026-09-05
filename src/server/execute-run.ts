import { buildLocator, describeLocator } from '../browser/locator.js';
import { checkStepElement, type ElementA11yFinding } from '../browser/a11y.js';
import { attemptHeal, HEAL_THRESHOLD, type HealUpdate } from '../heal/engine.js';
import { needsRebase, rebaseBaseline } from '../baseline/rebase.js';
import { INTERNAL_ORIGIN } from '../config.js';
import { replayBaseline } from '../run/replay.js';
import { loadBaseline, saveBaseline } from '../store/baselines.js';
import { finishRun, markRunStatus, type RunStatus } from '../store/runs.js';
import { publish } from './events.js';
import { getActiveVersion } from '../fixtures/app.js';
import { mergeVisualBaselines, VisualPass } from './visual-pass.js';
import {
  baselineShotPath,
  captureElementShot,
  capturePageShot,
  healShotPath,
} from '../browser/screenshot.js';
import { recordArtifact } from '../store/runs.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';

/**
 * Bridges a replay to the event bus.
 *
 * All of the work here is translation: the replay already reports itself through
 * an `onEvent` callback, and healing is already injected as a callback rather
 * than imported, so nothing in the engine had to change to become streamable.
 * This module decides what a dashboard should be told, and nothing else.
 */

/**
 * How many steps may heal in one run before it stops being a repair and starts
 * being a rewrite.
 *
 * Each heal is independently verified against the app, so three of them are
 * individually sound. But a run where most steps needed repairing is not a stale
 * locator, it is a different application — and a suite that quietly absorbs that
 * has stopped being a test of anything. The run still completes; it is reported
 * as needing review rather than as a pass.
 */
export const HEAL_CAP = 3;

/**
 * Whether a recorded screenshot exists for a step.
 *
 * Checked rather than assumed: baselines recorded before screenshot capture
 * existed have none, and a broken image in the interface is worse than an absent
 * one.
 */
function baselineShotExists(planId: string, stepId: string): boolean {
  return existsSync(path.join(PATHS.artifacts, baselineShotPath(planId, stepId)));
}

export interface ExecuteRunParams {
  runId: string;
  planId: string;
  healing: boolean;
  threshold?: number;
  headed?: boolean;
  /** Fails the run on a layout shift as well as on missing content. */
  strictVisual?: boolean;
  signal: AbortSignal;
}

export async function executeRun({
  runId,
  planId,
  healing,
  threshold = HEAL_THRESHOLD,
  headed = false,
  strictVisual = false,
  signal,
}: ExecuteRunParams): Promise<void> {
  const stored = loadBaseline(planId);
  if (!stored) {
    markRunStatus(runId, 'error');
    publish(runId, 'RUN_ERROR', { message: `No baseline recorded for "${planId}".` });
    publish(runId, 'STREAM_END', null);
    return;
  }

  // Replayed against wherever the app is now, not where it was recorded. Only
  // the origin moves; every recorded path is preserved, so a genuine divergence
  // is still caught. Heals are applied to `stored` rather than to this copy, so
  // running a test never rewrites the origins in the database.
  const rebased = needsRebase(stored, INTERNAL_ORIGIN)
    ? rebaseBaseline(stored, INTERNAL_ORIGIN)
    : stored;

  markRunStatus(runId, 'running');
  publish(runId, 'RUN_STARTED', {
    planId,
    startUrl: rebased.startUrl,
    steps: rebased.steps.length,
    healing,
    threshold: healing ? threshold : null,
    activeVersion: getActiveVersion(),
    // Surfaced rather than done quietly: a baseline recorded elsewhere being
    // replayed here is worth seeing in the timeline, because if the rebase were
    // ever wrong it would look like a mass page divergence.
    rebasedFrom: rebased === stored ? null : stored.startUrl,
  });

  const healed = new Map<string, HealUpdate>();
  let healAttempts = 0;
  let escalated = false;
  let llmCalls = 0;
  const unverifiedHeals: string[] = [];
  const elementFindings: ElementA11yFinding[] = [];

  const visual = new VisualPass({
    baseline: rebased,
    strict: strictVisual,

    onA11y: (audit) => {
      publish(runId, 'A11Y_CHECKED', {
        pagePath: audit.pagePath,
        score: audit.score,
        passes: audit.passCount,
        byImpact: audit.byImpact,
        violations: audit.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          helpUrl: v.helpUrl,
          tags: v.tags,
          nodeCount: v.nodeCount,
          samples: v.samples,
        })),
      });
    },

    onSecurity: (audit) => {
      publish(runId, 'SECURITY_CHECKED', {
        pagePath: audit.pagePath,
        score: audit.score,
        bySeverity: audit.bySeverity,
        findings: audit.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          evidence: f.evidence,
          remediation: f.remediation,
        })),
      });
    },
    onCaptured: (signature) => {
      publish(runId, 'VISUAL_CAPTURED', {
        pagePath: signature.pagePath,
        viewport: signature.viewport,
        elementCount: signature.elementCount,
      });
    },
    onFirstSight: (signature) => {
      publish(runId, 'VISUAL_CHECKED', {
        pagePath: signature.pagePath,
        viewport: signature.viewport,
        firstSight: true,
        elementCount: signature.elementCount,
        message: 'This page had no recorded appearance, so it was recorded rather than compared.',
      });
    },
    onComparison: (comparison, absorbed) => {
      publish(runId, 'VISUAL_CHECKED', {
        pagePath: comparison.pagePath,
        viewport: comparison.viewport,
        cosmetic: comparison.cosmeticCount,
        layoutShift: comparison.layoutShiftCount,
        missing: comparison.missingCount,
        replaced: comparison.replacedCount,
        added: comparison.addedCount,
        clean: comparison.clean,
        absorbed,
        findings: comparison.findings.map((f) => ({
          kind: f.kind,
          severity: f.severity,
          key: f.key,
          summary: f.summary,
          movedBy: f.movedBy,
          resizedBy: f.resizedBy,
          changes: f.changes.slice(0, 6),
        })),
      });

      // Named separately from the generic check so a dashboard can show the two
      // very different consequences without re-deriving them.
      if (absorbed && comparison.cosmeticCount > 0) {
        publish(runId, 'VISUAL_COSMETIC_HEALED', {
          pagePath: comparison.pagePath,
          viewport: comparison.viewport,
          count: comparison.cosmeticCount,
          examples: comparison.findings
            .filter((f) => f.kind === 'COSMETIC')
            .slice(0, 4)
            .map((f) => f.summary),
        });
      }
      if (comparison.layoutShiftCount > 0) {
        publish(runId, 'VISUAL_LAYOUT_SHIFT', {
          pagePath: comparison.pagePath,
          viewport: comparison.viewport,
          count: comparison.layoutShiftCount,
          strict: strictVisual,
          examples: comparison.findings
            .filter((f) => f.kind === 'LAYOUT_SHIFT')
            .slice(0, 6)
            .map((f) => f.summary),
        });
      }
    },
  });

  try {
    const run = await replayBaseline({
      baseline: rebased,
      headed,

      onHealableFailure: healing
        ? async ({ page, step, failure, restore }) => {
            // Past the cap, the healer is not consulted at all. Asking and then
            // discarding the answer would spend a model call to reach the same
            // verdict, and would put a candidate in the record that was never
            // going to be applied.
            if (healed.size >= HEAL_CAP) {
              escalated = true;
              publish(runId, 'HEAL_ESCALATED', {
                stepId: step.stepId,
                healedSoFar: healed.size,
                cap: HEAL_CAP,
                message:
                  `${healed.size} steps already healed in this run. Further repairs need a ` +
                  'human: at this point the UI has changed more than a locator.',
              });
              return null;
            }

            healAttempts += 1;

            // Filled by the hook below, before the candidate is executed. After
            // execution the page has usually navigated and the evidence is gone.
            let foundShot: string | null = null;

            const { attempt, update, page: currentPage } = await attemptHeal({
              page,
              step,
              failureMessage: failure.message,
              threshold,
              restore,
              onCandidateChosen: async ({ page: healPage, locator, description }) => {
                const relPath = healShotPath(runId, step.stepId, 'found');
                const shot = await captureElementShot({
                  page: healPage,
                  locator: buildLocator(healPage, locator),
                  relPath,
                });
                if (shot) {
                  foundShot = shot.relPath;
                  recordArtifact({
                    runId,
                    stepId: step.stepId,
                    kind: 'screenshot',
                    viewport: null,
                    relPath: shot.relPath,
                  });
                }
              },
            });

            // Counted after the fact, and only when the model was actually asked. The
            // increment used to happen before the attempt, so a run answered entirely
            // from cache still reported model calls — overstating cost on the very
            // screen that reports it.
            if (!attempt.proposalFromCache) llmCalls += 1;

            const detail = {
              stepId: step.stepId,
              status: attempt.status,
              confidence: attempt.confidence,
              threshold: attempt.threshold,
              reason: attempt.reason,
              verification: attempt.verification,
              model: attempt.model,
              candidatesProposed: attempt.candidatesProposed,
              candidatesTried: attempt.candidatesTried,
              previousLocator: describeLocator(attempt.previousLocator),
              newLocator: attempt.newLocator ? describeLocator(attempt.newLocator) : null,
              // False when the step had no post-condition, so the heal rests on
              // the model's judgement rather than on the application's behaviour.
              verifiedAgainstOutcome: step.expectedOutcome.assertions.length > 0,
              proposalFromCache: attempt.proposalFromCache,
              // The before-and-after pair. `baseline` was captured when the test
              // was recorded, `found` moments ago on the page that failed, so the
              // two together show what the test was looking for and what replaced
              // it. Absent rather than fabricated if a capture did not succeed.
              shots: {
                baseline: baselineShotExists(planId, step.stepId)
                  ? baselineShotPath(planId, step.stepId)
                  : null,
                found: foundShot,
              },
            };

            if (!update) {
              publish(runId, 'HEAL_REJECTED', detail);
              return null;
            }

            healed.set(step.stepId, update);

            // A step with no recorded post-condition gives the healer nothing to
            // check its candidate against, so the outcome "held" only because
            // there was nothing to hold. Accepting that silently would present a
            // heal taken on the model's word alone as though the application had
            // confirmed it, which is the one claim this system must never make
            // loosely. Recorded, surfaced, and counted toward review instead.
            if (step.expectedOutcome.assertions.length === 0) {
              unverifiedHeals.push(step.stepId);
            }
            // Told to the visual pass so the element the healer just replaced is
            // not independently reported as missing content.
            //
            // Read from the heal record rather than from the step: replay
            // overwrites `step.fingerprint` with the healed element's own
            // fingerprint, and this needs the identity of the one that vanished.
            // Relying on running before that assignment would work today and
            // break on any reordering.
            visual.reconcileHealedElement(update.record.previousFingerprint);
            publish(runId, 'HEAL_ACCEPTED', detail);

            return {
              healed: true,
              locator: update.locator,
              fallbacks: update.fallbacks,
              fingerprint: update.fingerprint,
              page: currentPage,
            };
          }
        : undefined,

      onStepSettled: async ({ page, step, monitor }) => {
        // The control this step drove, checked while the page is still on it.
        // Cheap: one evaluate against a single element, not a page extraction.
        if (step.locator) {
          const findings = await checkStepElement({
            page,
            stepId: step.stepId,
            locator: buildLocator(page, step.locator),
          }).catch(() => []);

          if (findings.length > 0) {
            elementFindings.push(...findings);
            publish(runId, 'A11Y_STEP_CHECKED', {
              stepId: step.stepId,
              locator: describeLocator(step.locator),
              findings: findings.map((f) => ({
                check: f.check,
                severity: f.severity,
                message: f.message,
                // Why the finding matters to the test and not only to a user. This is
                // the argument the layer exists to make, so it travels with it rather
                // than being reconstructed by whatever renders it.
                testabilityNote: f.testabilityNote,
              })),
            });
          }
        }

        await visual.inspect(page, monitor);
      },

      onEvent: (event) => {
        switch (event.type) {
          case 'stepStarting':
            publish(runId, 'STEP_STARTED', {
              stepId: event.stepId,
              action: event.action,
              index: event.index,
              total: event.total,
            });
            return;

          case 'skipped':
            publish(runId, 'STEP_SKIPPED', { stepId: event.stepId });
            return;

          case 'healing':
            publish(runId, 'HEALING_STARTED', { stepId: event.stepId });
            return;

          case 'healError':
            publish(runId, 'HEAL_ERROR', { stepId: event.stepId, message: event.message });
            return;

          case 'inspectionError':
            // Reported as its own thing. The step passed against the application;
            // an analyser that fell over is not a test failure.
            publish(runId, 'RUN_ERROR', {
              stepId: event.stepId,
              message: `A post-step inspection could not run: ${event.message}`,
              fatal: false,
            });
            return;

          case 'step': {
            const { result } = event;

            // A step that found its element by ANY means proves that element is
            // still there. Reconciling only healed elements missed the commonest
            // case: a step rescued by a fallback locator, whose element the
            // visual pass then reported as missing content even though the run had
            // just interacted with it successfully.
            if (result.status === 'passed') {
              const step = rebased.steps.find((s) => s.stepId === result.stepId);
              if (step?.fingerprint) visual.reconcileHealedElement(step.fingerprint);
            }
            const payload = {
              stepId: result.stepId,
              action: result.action,
              status: result.status,
              durationMs: result.durationMs,
              locator: result.locatorUsed ? describeLocator(result.locatorUsed) : null,
              usedFallback: result.usedFallback,
              outcomeChecked: result.outcomeChecked,
              failure: result.failure
                ? {
                    kind: result.failure.kind,
                    healable: result.failure.healable,
                    message: result.failure.message,
                  }
                : null,
            };

            publish(runId, result.status === 'passed' ? 'STEP_PASSED' : 'STEP_FAILED', payload);

            // Reported separately from the pass, because it is a different fact:
            // the test still works but the primary locator no longer matches, so
            // the baseline is one change away from needing a repair.
            if (result.status === 'passed' && result.usedFallback) {
              publish(runId, 'DRIFT_DETECTED', {
                stepId: result.stepId,
                locator: result.locatorUsed ? describeLocator(result.locatorUsed) : null,
              });
            }
            return;
          }
        }
      },
    });

    // Accepted heals are written to the baseline. Each one already executed
    // against the live page and satisfied the step's original recorded outcome,
    // which is why this does not wait for a human — and why the previous locator
    // is kept, so there is a way back.
    if (healed.size > 0) {
      for (const step of stored.steps) {
        const update = healed.get(step.stepId);
        if (!update) continue;
        step.healHistory.push(update.record);
        step.locator = update.locator;
        step.fallbackLocators = update.fallbacks;
        step.fingerprint = update.fingerprint;
      }
    }

    const visualResult = visual.result();

    // Absorbed and newly-seen signatures are written back together, so the next
    // run compares against the appearance this run actually saw.
    const visualUpdates = [...visualResult.absorbed, ...visualResult.added];
    if (visualUpdates.length > 0) {
      stored.visualBaselines = mergeVisualBaselines(stored.visualBaselines, visualUpdates);
    }
    if (visualUpdates.length > 0 || healed.size > 0) saveBaseline(stored);

    const visualFindingCount = visualResult.comparisons.reduce(
      (total, c) => total + c.layoutShiftCount + c.missingCount,
      0,
    );

    const status: RunStatus =
      run.status === 'failed' || visualResult.failures.length > 0
        ? 'failed'
        : escalated || healed.size >= HEAL_CAP || unverifiedHeals.length > 0
          ? 'needs_review'
          : 'passed';

    finishRun({
      runId,
      status,
      result: run,
      counters: {
        stepsPassed: run.steps.filter((s) => s.status === 'passed').length,
        healCount: healed.size,
        llmCalls,
        visualFindings: visualFindingCount,
        a11yViolations: visualResult.totals.a11yViolations + elementFindings.length,
        securityFindings: visualResult.totals.securityFindings,
      },
    });

    publish(runId, 'RUN_COMPLETE', {
      status,
      verdict: run.status,
      stepsTotal: run.steps.length,
      stepsPassed: run.steps.filter((s) => s.status === 'passed').length,
      healed: healed.size,
      healAttempts,
      escalated,
      unverifiedHeals,
      drifted: run.steps.filter((s) => s.usedFallback).map((s) => s.stepId),
      a11y: {
        score: visualResult.totals.a11yScore,
        violations: visualResult.totals.a11yViolations,
        pages: visualResult.a11y.length,
        // Reported alongside the page score, not folded into it. A page can score
        // well while the one control the test depends on is unnameable, and that is
        // the finding a test author needs.
        elementFindings: elementFindings.length,
        elementChecks: [...new Set(elementFindings.map((f) => f.check))],
      },
      security: {
        score: visualResult.totals.securityScore,
        findings: visualResult.totals.securityFindings,
        pages: visualResult.security.length,
      },
      visual: {
        pagesCompared: visualResult.comparisons.length,
        pagesRecorded: visualResult.added.length,
        cosmeticAbsorbed: visualResult.absorbed.length,
        layoutShifts: visualResult.comparisons.reduce((t, c) => t + c.layoutShiftCount, 0),
        missing: visualResult.comparisons.reduce((t, c) => t + c.missingCount, 0),
        failed: visualResult.failures.length,
        strict: strictVisual,
      },
      runFailure: run.failure ? { kind: run.failure.kind, message: run.failure.message } : null,
    });
  } catch (err) {
    // The replay classifies an unreachable app itself, so reaching here means
    // something outside the run failed. It is recorded as an infrastructure
    // error rather than as a test verdict — relabelling it a failure would
    // report a broken runner as a broken application.
    const aborted = signal.aborted;
    markRunStatus(runId, aborted ? 'cancelled' : 'error');
    publish(runId, 'RUN_ERROR', {
      message: aborted
        ? 'Run cancelled.'
        : `The run could not complete: ${err instanceof Error ? err.message : String(err)}`,
      aborted,
    });
  } finally {
    publish(runId, 'STREAM_END', null);
  }
}
