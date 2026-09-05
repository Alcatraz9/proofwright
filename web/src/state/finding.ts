import type { RunView, StepView } from './runModel.ts';

/**
 * Attribution.
 *
 * The product asks one question of every failure: was the element not found, or
 * was the result not what was recorded? The first is a stale test and can be
 * repaired. The second is the application behaving differently and must never be
 * repaired, because a tool that repairs it rewrites the suite until it passes.
 *
 * This module is the read side of that question. It derives nothing the run did
 * not report — every branch below is keyed on the classification the runner
 * already made and the heal outcome it already recorded. Where the evidence does
 * not support a side, the answer is `undetermined` and the run is escalated rather
 * than rounded to whichever side is more convenient.
 */

export type Attribution =
  /** No run to attribute yet. */
  | 'idle'
  /** Running; the classification has not landed. */
  | 'inflight'
  /** Every step held. */
  | 'nominal'
  /** The test was stale. Locator repaired, or drifted onto a fallback. */
  | 'instrument'
  /** The application changed or misbehaved. Never repaired. */
  | 'airframe'
  /** Neither the test nor the application — the harness or its configuration. */
  | 'harness'
  /** The evidence does not support either side. Held for a person. */
  | 'undetermined';

export interface Parameter {
  label: string;
  value: string;
  /** The one parameter that decided the attribution, emphasised over the rest. */
  decisive?: boolean;
  note?: string;
}

export interface Finding {
  attribution: Attribution;
  /** The attribution in the product's own words, for the reader who reads nothing else. */
  verdictWord: string;
  /** The finding as a sentence. Never a count. */
  headline: string;
  /** What follows from it. */
  consequence: string;
  parameters: Parameter[];
  /** The step the finding is about, when it is about one. */
  stepId: string | null;
}

/**
 * Failure kinds the runner classifies as not-the-locator's-fault. Kept as a
 * lookup for the wording only — `failure.healable` from the runner is the
 * authority, and this never overrides it.
 */
const KIND_PROSE: Record<string, string> = {
  ELEMENT_NOT_FOUND: 'the recorded locator matched nothing on a settled page',
  LOCATOR_AMBIGUOUS: 'the recorded locator now matches more than one element',
  OUTCOME_NOT_MET: 'the element was found and acted on, and the recorded outcome did not hold',
  HTTP_ERROR: 'the application answered with an error status',
  PAGE_DIVERGED: 'the page was not the one the step expected, before any element was looked up',
  PAGE_NOT_READY: 'the page reported itself still busy when the step timed out',
  NETWORK_ERROR: 'the application could not be reached at all',
  CONFIGURATION_ERROR: 'the run was missing configuration it needed',
};

const HARNESS_KINDS = new Set(['CONFIGURATION_ERROR']);
const ENVIRONMENT_KINDS = new Set(['NETWORK_ERROR', 'HTTP_ERROR', 'PAGE_NOT_READY']);

function firstFailed(steps: StepView[]): StepView | null {
  return steps.find((step) => step.state === 'failed') ?? null;
}

function firstRepaired(steps: StepView[]): StepView | null {
  return steps.find((step) => step.state === 'healed') ?? null;
}

function firstDrifted(steps: StepView[]): StepView | null {
  return steps.find((step) => step.state === 'drift') ?? null;
}

export function deriveFinding(view: RunView): Finding {
  const { complete, started, steps, errors } = view;

  if (!started) {
    return {
      attribution: 'idle',
      verdictWord: 'No run loaded',
      headline: 'Nothing has been replayed yet.',
      consequence:
        'Arm a plan and start a run, or open a past one — a finished run is read back from its own recorded events, so it reads exactly as it did live.',
      parameters: [],
      stepId: null,
    };
  }

  const fatal = errors.find((error) => error.fatal !== false);
  if (fatal) {
    return {
      attribution: 'harness',
      verdictWord: 'Harness fault',
      headline: 'The run could not complete, and nothing about the application was established.',
      consequence:
        'This is not a verdict on the test or on the application. Neither was exercised far enough to judge.',
      parameters: [{ label: 'Reported', value: fatal.message, decisive: true }],
      stepId: fatal.stepId ?? null,
    };
  }

  const failed = firstFailed(steps);

  // A failure outranks everything else: it is the reason someone is reading this.
  if (failed?.failure) {
    return attributeFailure(failed, view);
  }

  if (!complete) {
    const live = steps.find((step) => step.state === 'running' || step.state === 'healing');
    return {
      attribution: 'inflight',
      verdictWord: 'Attributing',
      headline: live
        ? `Replaying ${live.action} — ${live.stepId} — against the deployed release.`
        : 'Replaying the recorded steps against the deployed release.',
      consequence: 'No fault to attribute yet. Steps settle as they are reached.',
      parameters: [
        { label: 'Steps settled', value: `${steps.filter((s) => s.status !== null).length} of ${view.totalSteps ?? '—'}` },
        { label: 'Repairs allowed', value: started.healing ? 'Yes' : 'No' },
      ],
      stepId: live?.stepId ?? null,
    };
  }

  const repaired = firstRepaired(steps);
  const drifted = firstDrifted(steps);

  if (complete.unverifiedHeals.length > 0) {
    return {
      attribution: 'undetermined',
      verdictWord: 'Held for review',
      headline:
        'A repair held, but the step it repaired has no recorded post-condition — so nothing in the application confirmed it.',
      consequence:
        'The outcome “held” only because there was nothing to hold. This rests on the model’s judgement, and is reported as unverified rather than counted as a pass.',
      parameters: [
        { label: 'Unverified repairs', value: String(complete.unverifiedHeals.length), decisive: true },
        { label: 'Steps', value: `${complete.stepsPassed} of ${complete.stepsTotal} held` },
        { label: 'Repairs made', value: String(complete.healed) },
      ],
      stepId: complete.unverifiedHeals[0] ?? null,
    };
  }

  if (complete.escalated) {
    return {
      attribution: 'undetermined',
      verdictWord: 'Held for review',
      headline: 'More steps needed repair in one run than a stale locator explains.',
      consequence:
        'Each repair was verified on its own, so all of them are individually sound — but a run repairing most of its steps is looking at a different application, and that is a person’s call.',
      parameters: [
        { label: 'Repairs made', value: `${complete.healed} at the cap`, decisive: true },
        { label: 'Attempts', value: String(complete.healAttempts) },
        { label: 'Steps', value: `${complete.stepsPassed} of ${complete.stepsTotal} held` },
      ],
      stepId: null,
    };
  }

  if (repaired?.heal) {
    const heal = repaired.heal;
    return {
      attribution: 'instrument',
      verdictWord: 'Stale test',
      headline: `The test went stale at ${repaired.stepId}: ${KIND_PROSE.ELEMENT_NOT_FOUND}. It was repaired and the application confirmed the repair.`,
      consequence:
        'The application was never at fault here, so nothing is escalated. The replacement executed against the live page and satisfied the step’s own recorded outcome.',
      parameters: [
        { label: 'Corroboration', value: 'Recorded outcome held', decisive: true, note: heal.verification ?? undefined },
        { label: 'Repairs made', value: String(complete.healed) },
        { label: 'Confidence', value: heal.confidence.toFixed(2) },
        { label: 'Admission floor', value: heal.threshold.toFixed(2) },
        { label: 'Proposal', value: heal.proposalFromCache ? 'Reused from cache' : 'Live model call' },
      ],
      stepId: repaired.stepId,
    };
  }

  if (drifted) {
    return {
      attribution: 'instrument',
      verdictWord: 'Drifting',
      headline: `Every step held, but ${drifted.stepId} was reached by a fallback locator rather than the recorded one.`,
      consequence:
        'Nothing failed and nothing was repaired. The recorded locator is stale, so this suite is one change away from needing a repair here.',
      parameters: [
        { label: 'Route taken', value: 'Fallback locator matched', decisive: true },
        { label: 'Drifted steps', value: String(complete.drifted.length) },
        { label: 'Steps', value: `${complete.stepsPassed} of ${complete.stepsTotal} held` },
      ],
      stepId: drifted.stepId,
    };
  }

  return {
    attribution: 'nominal',
    verdictWord: 'Nominal',
    headline: 'Every recorded step was found where the baseline said it would be, and every recorded outcome held.',
    consequence: 'Nothing to attribute and nothing to repair. Replay makes no model calls, so this run cost nothing.',
    parameters: [
      { label: 'Steps', value: `${complete.stepsPassed} of ${complete.stepsTotal} held`, decisive: true },
      { label: 'Repairs made', value: String(complete.healed) },
      { label: 'Model calls', value: '0' },
    ],
    stepId: null,
  };
}

/**
 * The attribution itself.
 *
 * `failure.healable` is the runner's own classification and is treated as the
 * authority. Where a failure was healable and the healer still declined, the
 * decline reason decides: nothing serving the intent means the feature is gone,
 * which is the application changing, while a candidate that could not be admitted
 * leaves the question genuinely open.
 */
function attributeFailure(step: StepView, view: RunView): Finding {
  const failure = step.failure!;
  const prose = KIND_PROSE[failure.kind] ?? 'the step could not be completed';
  const heal = step.heal;

  const base: Parameter[] = [
    { label: 'Classification', value: failure.kind, decisive: true },
    { label: 'Repairable', value: failure.healable ? 'Yes — a locator fault' : 'No — not a locator fault' },
    { label: 'Step', value: step.stepId },
    { label: 'Action', value: step.action },
  ];

  if (!failure.healable) {
    const harness = HARNESS_KINDS.has(failure.kind);
    const environment = ENVIRONMENT_KINDS.has(failure.kind);

    if (harness) {
      return {
        attribution: 'harness',
        verdictWord: 'Harness fault',
        headline: `Neither the test nor the application: ${prose}.`,
        consequence: 'Nothing was established about either. Fix the run’s configuration and replay.',
        parameters: base,
        stepId: step.stepId,
      };
    }

    return {
      attribution: 'airframe',
      verdictWord: environment ? 'Application unreachable' : 'Application at fault',
      headline: `The application is at fault at ${step.stepId}: ${prose}.`,
      consequence:
        'The healer was never consulted. Repairing this would replace a real defect with a green tick, which is the one thing this must not do — so the run fails and escalates instead.',
      parameters: [
        ...base,
        { label: 'Healer consulted', value: 'No — withheld by classification' },
        { label: 'Reported', value: failure.message },
      ],
      stepId: step.stepId,
    };
  }

  // Healable, and a repair was attempted and refused.
  if (heal && step.healOutcome === 'rejected') {
    if (heal.status === 'no_candidate') {
      return {
        attribution: 'airframe',
        verdictWord: 'Feature gone',
        headline: `Nothing on the page serves what ${step.stepId} was for: ${prose}, and no candidate replaced it.`,
        consequence:
          'The healer was asked and answered that nothing on the page does this job. That is the application dropping a capability, not a locator going stale, so it escalates.',
        parameters: [
          ...base,
          { label: 'Healer verdict', value: 'No candidate serves the intent', decisive: true, note: heal.reason },
          { label: 'Candidates proposed', value: String(heal.candidatesProposed) },
        ],
        stepId: step.stepId,
      };
    }

    return {
      attribution: 'undetermined',
      verdictWord: 'Undetermined',
      headline: `${capitalise(prose)} at ${step.stepId}, and the proposed replacement could not be admitted.`,
      consequence:
        'A locator fault is likely, but nothing proved it — so the run does not claim one. Escalated rather than guessed.',
      parameters: [
        ...base,
        { label: 'Refused because', value: refusalProse(heal.status), decisive: true, note: heal.reason },
        { label: 'Confidence', value: heal.confidence.toFixed(2) },
        { label: 'Admission floor', value: heal.threshold.toFixed(2) },
        { label: 'Candidates tried', value: String(heal.candidatesTried) },
      ],
      stepId: step.stepId,
    };
  }

  if (step.healError) {
    return {
      attribution: 'undetermined',
      verdictWord: 'Undetermined',
      headline: `${capitalise(prose)} at ${step.stepId}, and the repair itself could not run.`,
      consequence:
        'The step keeps its original classification. A repair that failed to execute is reported separately and never becomes the verdict.',
      parameters: [...base, { label: 'Repair fault', value: step.healError, decisive: true }],
      stepId: step.stepId,
    };
  }

  if (step.escalated) {
    return {
      attribution: 'undetermined',
      verdictWord: 'Held at the cap',
      headline: `${capitalise(prose)} at ${step.stepId}, past the repair cap for this run.`,
      consequence:
        'The healer was not consulted, because asking and discarding the answer spends a model call to reach the same verdict.',
      parameters: [...base, { label: 'Repair cap', value: `${step.escalated.cap} reached`, decisive: true }],
      stepId: step.stepId,
    };
  }

  // Healable, no repair attempted — healing was not armed for this run.
  return {
    attribution: 'instrument',
    verdictWord: view.started?.healing ? 'Stale test' : 'Stale test, repairs off',
    headline: `The test is stale at ${step.stepId}: ${prose}.`,
    consequence: view.started?.healing
      ? 'A locator fault. No repair was recorded for it.'
      : 'A locator fault, and repairs were not armed for this run — so it was reported rather than fixed. Arm repairs and replay to see whether a replacement satisfies the recorded outcome.',
    parameters: [...base, { label: 'Repairs armed', value: view.started?.healing ? 'Yes' : 'No', decisive: true }],
    stepId: step.stepId,
  };
}

function refusalProse(status: string): string {
  switch (status) {
    case 'below_threshold':
      return 'Best candidate under the admission floor';
    case 'unlocatable':
      return 'Proposed locator matched nothing';
    case 'execution_failed':
      return 'Candidate found, outcome still not met';
    case 'no_candidate':
      return 'No candidate serves the intent';
    default:
      return 'Refused';
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How the attribution reads as a register, for the surfaces that colour it. */
export const ATTRIBUTION_REGISTER: Record<Attribution, 'quiet' | 'stated' | 'attention' | 'fault' | 'dim'> = {
  idle: 'dim',
  inflight: 'stated',
  nominal: 'quiet',
  instrument: 'stated',
  airframe: 'fault',
  harness: 'attention',
  undetermined: 'attention',
};
