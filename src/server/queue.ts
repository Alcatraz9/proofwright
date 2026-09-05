import { RUN_CONCURRENCY } from '../config.js';
import { markRunStatus } from '../store/runs.js';
import { finishJob } from '../store/jobs.js';
import { publish, type StreamKind } from './events.js';

/**
 * A bounded FIFO queue for runs.
 *
 * Each run drives a real Chromium, and the visual pass will drive it at two
 * viewports. On a free-tier container that is most of the available memory, so
 * unbounded concurrency does not degrade gracefully — it gets the container
 * OOM-killed the first time two people click Run at the same time. Queueing is
 * the difference between the second person waiting and everybody losing the
 * instance.
 *
 * Runs are recorded as `queued` in the database before they get here, so a
 * waiting run is visible in the dashboard rather than looking lost.
 */

export interface QueuedJob {
  /** Identifies both the work and its event stream. */
  runId: string;
  execute: (signal: AbortSignal) => Promise<void>;
  /**
   * Which event log this work writes to.
   *
   * Not cosmetic: a run's events are foreign-keyed to the runs table, so queuing a
   * recording without saying so wrote its first event into the wrong log and the
   * insert failed on the constraint. The queue serialises both kinds — they both
   * drive a browser — but they are not the same record.
   */
  kind?: StreamKind;
}

interface Active {
  runId: string;
  kind: StreamKind;
  controller: AbortController;
}

const pending: QueuedJob[] = [];
const active = new Map<string, Active>();

export function enqueue(job: QueuedJob): { position: number } {
  pending.push(job);
  publish(
    job.runId,
    'RUN_QUEUED',
    { position: pending.length, ahead: active.size + pending.length - 1 },
    job.kind ?? 'run',
  );
  pump();
  return { position: pending.length };
}

/**
 * Cancels a run whether it has started or not. A queued run is dropped; a
 * running one is signalled and its executor is expected to notice.
 */
export function cancel(runId: string): boolean {
  const queuedIndex = pending.findIndex((job) => job.runId === runId);
  if (queuedIndex >= 0) {
    const [job] = pending.splice(queuedIndex, 1);
    const kind = job?.kind ?? 'run';
    if (kind === 'job') finishJob(runId, 'cancelled', 'Cancelled before it started.');
    else markRunStatus(runId, 'cancelled');
    publish(runId, 'RUN_ERROR', { message: 'Cancelled before it started.' }, kind);
    publish(runId, 'STREAM_END', null, kind);
    return true;
  }

  const running = active.get(runId);
  if (!running) return false;
  running.controller.abort();
  return true;
}

export function queueState(): { active: string[]; pending: string[]; concurrency: number } {
  return {
    active: [...active.keys()],
    pending: pending.map((job) => job.runId),
    concurrency: RUN_CONCURRENCY,
  };
}

function pump(): void {
  while (active.size < RUN_CONCURRENCY && pending.length > 0) {
    const job = pending.shift();
    if (!job) return;

    const controller = new AbortController();
    const kind = job.kind ?? 'run';
    active.set(job.runId, { runId: job.runId, kind, controller });

    // Deliberately not awaited: pump() is synchronous so that enqueue() returns
    // immediately and the client can open its event stream. The job reports
    // itself through the event bus.
    void job
      .execute(controller.signal)
      .catch((err: unknown) => {
        // A throw here means the executor failed outside its own error handling.
        // Record it against the run rather than letting it become an unhandled
        // rejection that takes the server down with it.
        const message = err instanceof Error ? err.message : String(err);
        if (kind === 'job') finishJob(job.runId, 'error', message);
        else markRunStatus(job.runId, 'error');
        publish(job.runId, 'RUN_ERROR', { message }, kind);
        publish(job.runId, 'STREAM_END', null, kind);
      })
      .finally(() => {
        active.delete(job.runId);
        pump();
      });
  }
}
