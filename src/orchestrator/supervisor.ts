import { enqueue, cancel as cancelQueued } from '../server/queue.js';
import type { StreamKind } from '../server/events.js';
import { finishMission } from '../store/missions.js';
import { runMission } from './machine.js';

/**
 * Mission lifetime, held outside the browser queue.
 *
 * The first version queued the mission itself and broke on a foreign key: the
 * queue announces every job on the event bus, job events are keyed to the jobs
 * table, and a mission has no row there. The fix is not a decoy jobs row — it is
 * noticing that the queue exists to protect a single browser, and an orchestrator
 * does not touch one. It decides, waits, and records.
 *
 * So the mission runs here, unqueued and concurrent, and each stage that really
 * does drive a browser goes through the queue and is awaited. One mission still
 * cannot overlap its own recording and run, several missions still cannot exceed
 * the browser concurrency, and a mission spends its waiting time as a pending
 * queue entry rather than holding the only slot while it thinks.
 */

const inflight = new Map<string, AbortController>();

export function startMissionInBackground(missionId: string): void {
  const controller = new AbortController();
  inflight.set(missionId, controller);

  void runMission({ missionId, signal: controller.signal })
    .catch((error: unknown) => {
      // runMission owns its own error reporting; this is the last resort for a
      // throw that escaped it, so the row cannot be left claiming to be running.
      finishMission(missionId, 'error', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      inflight.delete(missionId);
    });
}

/**
 * Stops a mission and whatever browser work it currently has in the queue.
 *
 * Both halves are needed: aborting the mission signal ends the orchestration, and
 * cancelling by stage id reaches a recording or run that is already executing. A
 * mission cancelled without the second half would return control immediately while
 * a browser carried on driving the application.
 */
export function abortMission(missionId: string, stageIds: string[]): boolean {
  const controller = inflight.get(missionId);
  for (const id of stageIds) cancelQueued(id);
  if (!controller) return false;
  controller.abort();
  inflight.delete(missionId);
  return true;
}

export function isInflight(missionId: string): boolean {
  return inflight.has(missionId);
}

/**
 * Runs one browser stage through the shared queue and resolves when it finishes.
 *
 * The queue was built to fire and forget, which is all an HTTP handler needs. An
 * orchestrator needs the opposite: it has to know the recording finished before it
 * can decide whether there is anything to execute.
 */
export function runQueuedStage(
  id: string,
  kind: StreamKind,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    enqueue({
      runId: id,
      kind,
      execute: async (signal) => {
        try {
          await work(signal);
          resolve();
        } catch (error) {
          reject(error);
          // Rethrown so the queue also sees the failure and does not log the
          // stage as having completed cleanly.
          throw error;
        }
      },
    });
  });
}
