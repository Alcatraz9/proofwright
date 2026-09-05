import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunEvent, RunEventType } from '../api/types.ts';
import { foldEvents, type RunView } from '../state/runModel.ts';

/**
 * Every event type the server emits. Named SSE frames do not reach `onmessage`,
 * which only receives frames with no `event:` line, so each type is subscribed
 * to explicitly. Listing them is also a useful contract check: a type the server
 * adds and the client has not been taught about is silently ignored rather than
 * mishandled.
 */
const EVENT_TYPES: RunEventType[] = [
  'RUN_QUEUED',
  'RUN_STARTED',
  'STEP_STARTED',
  'STEP_PASSED',
  'STEP_FAILED',
  'STEP_SKIPPED',
  'DRIFT_DETECTED',
  'HEALING_STARTED',
  'HEAL_ACCEPTED',
  'HEAL_REJECTED',
  'HEAL_ERROR',
  'HEAL_ESCALATED',
  'VISUAL_CAPTURED',
  'VISUAL_CHECKED',
  'VISUAL_COSMETIC_HEALED',
  'VISUAL_LAYOUT_SHIFT',
  'A11Y_CHECKED',
  'A11Y_STEP_CHECKED',
  'SECURITY_CHECKED',
  'RUN_COMPLETE',
  'RUN_ERROR',
  'STREAM_END',
];

export type StreamState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface RunFeed {
  view: RunView;
  events: RunEvent[];
  streamState: StreamState;
  /** Milliseconds since `RUN_STARTED`, ticking client-side while the run is live. */
  elapsedMs: number | null;
}

/**
 * Subscribes to a run.
 *
 * The server replays the events already recorded before attaching the connection
 * to the live feed, so opening late — or reconnecting after a dropped socket —
 * yields the whole run rather than the remainder. That means this hook does not
 * have to fetch history first and then splice: it just accumulates whatever
 * arrives, in sequence order, and lets `foldEvents` make sense of it.
 *
 * `EventSource` reconnects on its own and resends `Last-Event-ID`, which the
 * server honours, so there is no retry logic here either.
 */
export function useRunStream(runId: string | null): RunFeed {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const seen = useRef(new Set<number>());

  useEffect(() => {
    setEvents([]);
    seen.current = new Set();
    if (!runId) {
      setStreamState('idle');
      return;
    }

    setStreamState('connecting');
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);

    source.onopen = () => setStreamState('open');

    // A closed stream is the normal end of a run, but the browser reports it the
    // same way it reports a failure. STREAM_END is the authoritative signal, so
    // an error after it is not surfaced as one.
    source.onerror = () => {
      setStreamState((current) => (current === 'closed' ? 'closed' : 'error'));
    };

    const onFrame = (raw: MessageEvent): void => {
      const event = JSON.parse(raw.data as string) as RunEvent;
      // The replay-then-attach handover can deliver an event twice. Sequence
      // numbers are authoritative, so a duplicate is dropped rather than folded
      // twice.
      if (seen.current.has(event.seq)) return;
      seen.current.add(event.seq);
      setEvents((current) => [...current, event].sort((a, b) => a.seq - b.seq));

      if (event.type === 'STREAM_END') {
        setStreamState('closed');
        source.close();
      }
    };

    for (const type of EVENT_TYPES) source.addEventListener(type, onFrame);

    return () => {
      for (const type of EVENT_TYPES) source.removeEventListener(type, onFrame);
      source.close();
    };
  }, [runId]);

  const view = useMemo(() => foldEvents(events), [events]);
  const elapsedMs = useElapsed(findStartedAt(events), findEndedAt(events));

  return { view, events, streamState, elapsedMs };
}

/**
 * Deliberately the only way the console reads a run, live or finished.
 *
 * Opening a stream against a run that has already completed replays its whole
 * event history and then closes, so there is no second "load a past run" path to
 * keep in step with this one — which is what makes replaying a past run free
 * rather than a feature.
 */
function findStartedAt(events: RunEvent[]): string | null {
  return events.find((e) => e.type === 'RUN_STARTED')?.at ?? null;
}

/** The recorded end, so a finished run shows its real duration, not the last tick. */
function findEndedAt(events: RunEvent[]): string | null {
  const terminal = events.find((e) => e.type === 'RUN_COMPLETE' || e.type === 'RUN_ERROR');
  return terminal?.at ?? events.find((e) => e.type === 'STREAM_END')?.at ?? null;
}

/**
 * A run takes thirty to sixty seconds, and a clock that only moves when an event
 * arrives looks stalled during a slow step. This ticks locally instead, and
 * settles on the recorded end time once the run has one.
 */
function useElapsed(startedAt: string | null, endedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt || endedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [startedAt, endedAt]);

  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;

  const end = endedAt ? Date.parse(endedAt) : now;
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}
