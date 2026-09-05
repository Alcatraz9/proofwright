import { generateBaseline } from '../baseline/generate.js';
import { INTERNAL_ORIGIN } from '../config.js';
import { rebaseForThisHost } from '../baseline/rebase.js';
import { describeLocator } from '../browser/locator.js';
import { saveBaseline } from '../store/baselines.js';
import { finishJob, markJobStatus } from '../store/jobs.js';
import { loadPlan } from '../store/plans.js';
import { publish } from './events.js';

/**
 * Records a baseline as a queued job, reporting progress as it goes.
 *
 * This is the stage where a plan stops being a description and becomes executable: the
 * flow is walked against the running application, and for each step the recorder
 * matches the step's semantic target to a real element, derives a locator, and proves
 * that locator selects that element and nothing else.
 *
 * Queued alongside runs rather than run immediately, because it drives a real browser
 * and two of those at once is how a small container dies.
 *
 * Progress is streamed rather than summarised at the end. Recording takes the better
 * part of a minute, and the interesting part — which locator strategy each step landed
 * on, and how durable that is — is exactly what a reviewer needs to see building up.
 */

export interface RecordBaselineParams {
  jobId: string;
  planId: string;
  headed?: boolean;
  signal: AbortSignal;
}

export async function recordBaselineJob({
  jobId,
  planId,
  signal,
}: RecordBaselineParams): Promise<void> {
  const emit = (type: Parameters<typeof publish>[1], payload: unknown): void => {
    publish(jobId, type, payload, 'job');
  };

  const stored = loadPlan(planId);
  if (!stored) {
    finishJob(jobId, 'error', `No plan "${planId}".`);
    emit('RECORD_ERROR', { message: `No plan "${planId}".` });
    emit('STREAM_END', null);
    return;
  }

  markJobStatus(jobId, 'running');
  emit('RECORD_STARTED', {
    planId,
    name: stored.plan.name,
    startUrl: stored.plan.startUrl,
    steps: stored.plan.steps.length,
    status: stored.status,
  });

  try {
    const baseline = await generateBaseline({
      planId,
      plan: stored.plan,
      onEvent: (event) => {
        switch (event.type) {
          case 'page':
            emit('RECORD_PAGE', {
              url: event.url,
              elementCount: event.elementCount,
              truncated: event.truncated,
            });
            return;
          case 'resolved':
            emit('RECORD_STEP_RESOLVED', {
              stepId: event.stepId,
              matched: event.ref !== null,
              confidence: event.confidence,
              reason: event.reason,
            });
            return;
          case 'locator':
            emit('RECORD_STEP_RESOLVED', {
              stepId: event.stepId,
              locator: event.locator,
              fallbacks: event.fallbacks,
            });
            return;
          case 'executed':
            emit('RECORD_STEP_RESOLVED', { stepId: event.stepId, outcome: event.outcome });
            return;
          case 'warning':
            // Surfaced, not swallowed. A step with no post-condition, or one that could
            // only be located positionally, is a weakness in the recording that the
            // reviewer is the right person to judge.
            emit('RECORD_WARNING', { stepId: event.stepId, message: event.message });
            return;
        }
      },
    });

    if (signal.aborted) {
      finishJob(jobId, 'cancelled', 'Cancelled.');
      emit('RECORD_ERROR', { message: 'Cancelled.', aborted: true });
      return;
    }

    // Rebased on the way in for the same reason a replay is: the recorder ran against
    // this container's loopback, and storing that origin verbatim would tie the
    // baseline to the machine that produced it.
    const toStore = rebaseForThisHost(baseline, INTERNAL_ORIGIN);

    saveBaseline(toStore);

    const unverifiable = toStore.steps.filter((s) => s.expectedOutcome.assertions.length === 0);
    const positional = toStore.steps.filter((s) => s.locator?.nth !== null && s.locator?.nth !== undefined);

    finishJob(jobId, 'done', `Recorded ${toStore.steps.length} steps.`);
    emit('RECORD_COMPLETE', {
      planId,
      steps: toStore.steps.map((step) => ({
        stepId: step.stepId,
        action: step.action,
        locator: step.locator ? describeLocator(step.locator) : null,
        strategy: step.locator?.strategy ?? null,
        fallbacks: step.fallbackLocators.length,
        confidence: step.resolution.confidence,
        assertions: step.expectedOutcome.assertions.map((a) =>
          a.value ? `${a.type} "${a.value}"` : a.type,
        ),
      })),
      // Reported so the reviewer knows where this recording is weakest, rather than
      // being told only that it succeeded.
      warnings: {
        withoutPostCondition: unverifiable.map((s) => s.stepId),
        locatedPositionally: positional.map((s) => s.stepId),
      },
      model: toStore.model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(jobId, signal.aborted ? 'cancelled' : 'error', message);
    emit('RECORD_ERROR', { message, aborted: signal.aborted });
  } finally {
    emit('STREAM_END', null);
  }
}
