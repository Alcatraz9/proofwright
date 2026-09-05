import type {
  A11yCheckedPayload,
  A11yStepCheckedPayload,
  DriftPayload,
  HealErrorPayload,
  HealEscalatedPayload,
  HealPayload,
  RunCompletePayload,
  RunErrorPayload,
  RunEvent,
  RunQueuedPayload,
  RunStartedPayload,
  SecurityCheckedPayload,
  StepSettledPayload,
  StepStartedPayload,
  StepStatus,
  StepFailure,
  VisualCapturedPayload,
  VisualCheckedPayload,
} from '../api/types.ts';

/**
 * One reducer over one array of events.
 *
 * This is the whole reason the console can render a finished run and a live run
 * with the same component. `GET /api/runs/:id` returns the run's entire event
 * list, and the stream replays its history before attaching to the live feed, so
 * both sources hand over the same thing: an ordered array. Fold it and the
 * "replay a past run" feature costs nothing.
 *
 * The fold is a full recompute rather than an incremental update. A run is nine
 * steps and a few dozen events, so recomputing on each arrival is free, and a
 * pure function of the array cannot drift out of step with it the way an
 * accumulating one can.
 */

export type StepState =
  | 'pending'
  | 'running'
  | 'passed'
  /** Passed, but only via a fallback locator. Not the same as a pass. */
  | 'drift'
  | 'healing'
  | 'healed'
  | 'failed'
  | 'skipped';

export interface StepView {
  stepId: string;
  action: string;
  /** Zero-based on the wire, from `STEP_STARTED`. Rendered 1-based. */
  index: number | null;
  state: StepState;
  status: StepStatus | null;
  durationMs: number | null;
  locator: string | null;
  usedFallback: boolean;
  outcomeChecked: boolean;
  failure: StepFailure | null;
  /** The accepted or rejected heal for this step, whichever arrived. */
  heal: HealPayload | null;
  healOutcome: 'accepted' | 'rejected' | null;
  healError: string | null;
  escalated: HealEscalatedPayload | null;
  driftLocator: string | null;
}

export interface VisualPageView extends VisualCheckedPayload {
  /** `pagePath` and `viewport` together identify one comparison. */
  key: string;
}

export interface RunView {
  queued: RunQueuedPayload | null;
  started: RunStartedPayload | null;
  steps: StepView[];
  visual: VisualPageView[];
  captured: VisualCapturedPayload[];
  a11y: A11yCheckedPayload[];
  /** Per-element findings for the controls the test drove. */
  a11ySteps: A11yStepCheckedPayload[];
  security: SecurityCheckedPayload[];
  complete: RunCompletePayload | null;
  /** Fatal and non-fatal alike; `fatal === false` marks an inspection failure. */
  errors: RunErrorPayload[];
  ended: boolean;
  lastSeq: number;
  /** Total step count, known from `RUN_STARTED` before any step reports. */
  totalSteps: number | null;
}

export const emptyRunView: RunView = {
  queued: null,
  started: null,
  steps: [],
  visual: [],
  captured: [],
  a11y: [],
  a11ySteps: [],
  security: [],
  complete: null,
  errors: [],
  ended: false,
  lastSeq: 0,
  totalSteps: null,
};

function blankStep(stepId: string, action: string): StepView {
  return {
    stepId,
    action,
    index: null,
    state: 'pending',
    status: null,
    durationMs: null,
    locator: null,
    usedFallback: false,
    outcomeChecked: false,
    failure: null,
    heal: null,
    healOutcome: null,
    healError: null,
    escalated: null,
    driftLocator: null,
  };
}

/**
 * The step's state is derived at the end rather than assigned as events arrive.
 *
 * Order matters and is not the order a reader would guess: `HEALING_STARTED` and
 * the heal verdict both land *before* the step settles, so a healed step arrives
 * as "passed" last. Deriving the state from the accumulated facts, once, avoids
 * a later event quietly overwriting the more specific label an earlier one set.
 */
function deriveState(step: StepView): StepState {
  if (step.status === 'skipped') return 'skipped';
  if (step.status === 'failed') return 'failed';
  if (step.status === 'passed') {
    if (step.healOutcome === 'accepted') return 'healed';
    if (step.usedFallback) return 'drift';
    return 'passed';
  }
  if (step.healOutcome === null && step.healError === null && step.heal === null) {
    return step.index === null ? 'pending' : 'running';
  }
  return 'healing';
}

export function foldEvents(events: RunEvent[]): RunView {
  // Every array is re-created rather than spread from the template: a shared array
  // would accumulate across folds, and the fold runs on every event arrival.
  const view: RunView = {
    ...emptyRunView,
    steps: [],
    visual: [],
    captured: [],
    a11y: [],
    a11ySteps: [],
    security: [],
    errors: [],
  };
  const byId = new Map<string, StepView>();
  const order: string[] = [];

  const step = (stepId: string, action = ''): StepView => {
    const existing = byId.get(stepId);
    if (existing) {
      if (action && !existing.action) existing.action = action;
      return existing;
    }
    const created = blankStep(stepId, action);
    byId.set(stepId, created);
    order.push(stepId);
    return created;
  };

  for (const event of events) {
    view.lastSeq = Math.max(view.lastSeq, event.seq);

    switch (event.type) {
      case 'RUN_QUEUED':
        view.queued = event.payload as RunQueuedPayload;
        break;

      case 'RUN_STARTED': {
        const payload = event.payload as RunStartedPayload;
        view.started = payload;
        view.totalSteps = payload.steps;
        break;
      }

      case 'STEP_STARTED': {
        const payload = event.payload as StepStartedPayload;
        const current = step(payload.stepId, payload.action);
        current.index = payload.index;
        view.totalSteps = payload.total;
        break;
      }

      case 'STEP_PASSED':
      case 'STEP_FAILED': {
        const payload = event.payload as StepSettledPayload;
        const current = step(payload.stepId, payload.action);
        current.status = payload.status;
        current.durationMs = payload.durationMs;
        current.locator = payload.locator;
        current.usedFallback = payload.usedFallback;
        current.outcomeChecked = payload.outcomeChecked;
        current.failure = payload.failure;
        break;
      }

      case 'STEP_SKIPPED': {
        const payload = event.payload as { stepId: string };
        step(payload.stepId).status = 'skipped';
        break;
      }

      case 'DRIFT_DETECTED': {
        const payload = event.payload as DriftPayload;
        const current = step(payload.stepId);
        current.driftLocator = payload.locator;
        current.usedFallback = true;
        break;
      }

      case 'HEALING_STARTED': {
        const payload = event.payload as { stepId: string };
        // Marks the step as under repair without a verdict yet. `deriveState`
        // reads the absence of an outcome, so nothing is written here beyond
        // ensuring the row exists.
        step(payload.stepId);
        break;
      }

      case 'HEAL_ACCEPTED':
      case 'HEAL_REJECTED': {
        const payload = event.payload as HealPayload;
        const current = step(payload.stepId);
        current.heal = payload;
        current.healOutcome = event.type === 'HEAL_ACCEPTED' ? 'accepted' : 'rejected';
        break;
      }

      case 'HEAL_ERROR': {
        const payload = event.payload as HealErrorPayload;
        step(payload.stepId).healError = payload.message;
        break;
      }

      case 'HEAL_ESCALATED': {
        const payload = event.payload as HealEscalatedPayload;
        step(payload.stepId).escalated = payload;
        break;
      }

      case 'VISUAL_CAPTURED':
        view.captured.push(event.payload as VisualCapturedPayload);
        break;

      case 'VISUAL_CHECKED': {
        const payload = event.payload as VisualCheckedPayload;
        const key = `${payload.pagePath}@${payload.viewport}`;
        const index = view.visual.findIndex((v) => v.key === key);
        const entry: VisualPageView = { ...payload, key };
        if (index >= 0) view.visual[index] = entry;
        else view.visual.push(entry);
        break;
      }

      // Both are derivable from `VISUAL_CHECKED` and exist so a client does not
      // have to re-derive them. The panels read the comparison directly, so
      // nothing is accumulated for them here.
      case 'VISUAL_COSMETIC_HEALED':
      case 'VISUAL_LAYOUT_SHIFT':
        break;

      case 'A11Y_CHECKED':
        view.a11y.push(event.payload as A11yCheckedPayload);
        break;

      case 'A11Y_STEP_CHECKED':
        view.a11ySteps.push(event.payload as A11yStepCheckedPayload);
        break;

      case 'SECURITY_CHECKED':
        view.security.push(event.payload as SecurityCheckedPayload);
        break;

      case 'RUN_COMPLETE':
        view.complete = event.payload as RunCompletePayload;
        break;

      case 'RUN_ERROR':
        view.errors.push(event.payload as RunErrorPayload);
        break;

      case 'STREAM_END':
        view.ended = true;
        break;
    }
  }

  view.steps = order.map((id) => {
    const current = byId.get(id)!;
    return { ...current, state: deriveState(current) };
  });

  return view;
}

// ---------------------------------------------------------------------------
// Derived readings
// ---------------------------------------------------------------------------

/**
 * The worst page, not the mean.
 *
 * A score averaged across five pages says the site is mostly fine while one page
 * is unusable, which is not what an accessibility or security score means. The
 * run's own totals take the minimum, so the dashboard does too.
 */
export function worstScore(pages: { score: number }[]): number | null {
  if (pages.length === 0) return null;
  return pages.reduce((worst, page) => Math.min(worst, page.score), 100);
}

export function isRunning(view: RunView): boolean {
  return view.started !== null && !view.ended && view.complete === null;
}

/** Analysis verdicts arrive at the end of a run, so "empty" and "not yet" differ. */
export function analysisPending(view: RunView): boolean {
  return view.started !== null && view.complete === null && !view.ended;
}
