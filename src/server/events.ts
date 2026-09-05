import { appendRunEvent } from '../store/runs.js';
import { appendJobEvent } from '../store/jobs.js';

/**
 * In-process fan-out for run events, plus the persistence that makes a late
 * subscriber possible.
 *
 * Broadcasting alone is not enough for the dashboard. A judge who opens the page
 * midway through a run would see an empty timeline until the next event happened
 * to fire, which on a slow step is most of the run. So every event is written to
 * the database as it is published, and a new subscriber is replayed the events
 * it missed before being attached to the live feed.
 */

export type RunEventType =
  | 'RUN_QUEUED'
  | 'RUN_STARTED'
  | 'STEP_STARTED'
  | 'STEP_PASSED'
  | 'STEP_FAILED'
  | 'STEP_SKIPPED'
  /** Passed, but only because a fallback locator rescued it. */
  | 'DRIFT_DETECTED'
  | 'HEALING_STARTED'
  | 'HEAL_ACCEPTED'
  | 'HEAL_REJECTED'
  /** The heal itself could not run. The step keeps its original classification. */
  | 'HEAL_ERROR'
  /** More steps healed in one run than we are willing to accept unattended. */
  | 'HEAL_ESCALATED'
  /** A page was measured. The verdict comes later, once all heals are known. */
  | 'VISUAL_CAPTURED'
  | 'VISUAL_CHECKED'
  | 'VISUAL_COSMETIC_HEALED'
  | 'VISUAL_LAYOUT_SHIFT'
  | 'A11Y_CHECKED'
  /**
   * The accessibility of the one control a step drove.
   *
   * Separate from the page audit because it answers a different question. The page
   * audit says how accessible the page is; this says whether the specific control
   * the test depends on is describable — and a control that is not describable to a
   * screen reader is also not describable to a locator, which is why the test
   * pointing at it is fragile.
   */
  | 'A11Y_STEP_CHECKED'
  | 'SECURITY_CHECKED'
  | 'RUN_COMPLETE'
  | 'RUN_ERROR'
  // Recording a baseline. Progress rather than verdicts: which page the recorder is
  // on, which element it matched, what locator that produced and how durable it is.
  | 'RECORD_STARTED'
  | 'RECORD_PAGE'
  | 'RECORD_STEP_RESOLVED'
  | 'RECORD_WARNING'
  | 'RECORD_COMPLETE'
  | 'RECORD_ERROR'
  | 'STREAM_END';

export interface PublishedEvent {
  seq: number;
  at: string;
  type: RunEventType;
  payload: unknown;
}

type Listener = (event: PublishedEvent) => void;

const listeners = new Map<string, Set<Listener>>();

/**
 * Records the event, then delivers it. Persist-before-deliver on purpose: if the
 * process dies between the two, a reader that reconnects still sees it. The other
 * order would lose it.
 */
/**
 * Which table an event stream persists to.
 *
 * A run and a recording share the fan-out and the SSE framing but not the storage:
 * one is a test result with a verdict, the other is progress on an exploratory
 * action. Keeping them in separate tables is what stops a recording appearing in
 * pass-rate arithmetic.
 */
export type StreamKind = 'run' | 'job';

export function publish(
  streamId: string,
  type: RunEventType,
  payload: unknown = null,
  kind: StreamKind = 'run',
): PublishedEvent {
  const seq = kind === 'job' ? appendJobEvent(streamId, type, payload) : appendRunEvent(streamId, type, payload);
  const runId = streamId;
  const event: PublishedEvent = { seq, at: new Date().toISOString(), type, payload };

  for (const listener of listeners.get(runId) ?? []) {
    // One broken subscriber must not stop the others, or abort the run.
    try {
      listener(event);
    } catch {
      /* a dead socket is the subscriber's problem, not the run's */
    }
  }
  return event;
}

export function subscribe(runId: string, listener: Listener): () => void {
  const set = listeners.get(runId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(runId, set);

  return () => {
    const current = listeners.get(runId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(runId);
  };
}

export function subscriberCount(runId: string): number {
  return listeners.get(runId)?.size ?? 0;
}
