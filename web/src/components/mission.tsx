import type { ComponentType, ReactNode } from 'react';
import type {
  CoverageRound,
  DecisionOutcome,
  GapKind,
  MissionStage,
  MissionStatus,
  ScenarioKind,
  ScenarioVerdict,
} from '../api/types.ts';
import {
  MarkFailed,
  MarkFallback,
  MarkPass,
  MarkPending,
  MarkReview,
  MarkSkipped,
} from './icons.tsx';
import type { Register } from './status.tsx';

/**
 * The mission vocabulary, and the strip that carries it.
 *
 * Every state here is separated on the same three channels the step states use — a
 * drawn mark, a written label, and a register — so the two vocabularies read as one
 * system rather than two. Colour is the fourth channel and never the only one.
 */

const REGISTER_TEXT: Record<Register, string> = {
  quiet: 'text-read-200',
  stated: 'text-read-100',
  attention: 'text-signal',
  fault: 'text-alarm-ink',
  dim: 'text-read-300',
};

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export const STAGES: MissionStage[] = [
  'explore',
  'plan',
  'evaluate_coverage',
  'generate',
  'execute',
  'report',
];

/** Written the way a QA engineer would say it, not the way the enum spells it. */
export const STAGE_LABEL: Record<MissionStage, string> = {
  explore: 'Explore',
  plan: 'Plan',
  evaluate_coverage: 'Score coverage',
  generate: 'Resolve',
  execute: 'Execute',
  report: 'Report',
};

export const STAGE_NOTE: Record<MissionStage, string> = {
  explore: 'Crawl the application and record what is there. No model calls.',
  plan: 'Turn the stated intent, or the map alone, into a specification.',
  evaluate_coverage: 'Score the plan against the map and re-plan for what is missing.',
  generate: 'Resolve every step against the live application. The slowest stage.',
  execute: 'Replay the specification, repairing stale locators and escalating the rest.',
  report: 'Synthesise the verdict, the gaps and the score with its parts.',
};

// ---------------------------------------------------------------------------
// Mission status
// ---------------------------------------------------------------------------

interface StatusStyle {
  label: string;
  register: Register;
  mark: ComponentType<{ className?: string; size?: number }>;
  /** What the status means, in the product's own words. */
  note: string;
  /** True while the orchestrator is still working, which drives the live cues. */
  live: boolean;
}

export const MISSION_STATUS: Record<MissionStatus, StatusStyle> = {
  queued: {
    label: 'Queued',
    register: 'dim',
    mark: MarkPending,
    note: 'Waiting for the single run slot this instance allows.',
    live: true,
  },
  running: {
    label: 'In flight',
    register: 'stated',
    mark: MarkPending,
    note: 'Working. A mission takes several minutes on the free tier, and quiet stretches are normal.',
    live: true,
  },
  passed: {
    label: 'Pass',
    register: 'quiet',
    mark: MarkPass,
    note: 'Every scenario that produced a baseline ran, and every recorded outcome held.',
    live: false,
  },
  failed: {
    label: 'Failed',
    register: 'fault',
    mark: MarkFailed,
    note: 'A scenario could not be completed and no repair could satisfy its recorded outcome.',
    live: false,
  },
  needs_review: {
    label: 'Held for review',
    register: 'attention',
    mark: MarkReview,
    note: 'Finished, but something in it rests on judgement rather than on the application confirming it.',
    live: false,
  },
  cancelled: {
    label: 'Cancelled',
    register: 'dim',
    mark: MarkSkipped,
    note: 'Halted before it finished. Nothing further was attempted.',
    live: false,
  },
  error: {
    label: 'Orchestrator fault',
    register: 'fault',
    mark: MarkFailed,
    note: 'The pipeline itself stopped. Nothing was established about the application.',
    live: false,
  },
};

export function MissionStatusChip({ status }: { status: MissionStatus }) {
  const entry = MISSION_STATUS[status] ?? MISSION_STATUS.error;
  const Mark = entry.mark;
  return (
    <span className={`label-cut inline-flex items-center gap-1.5 ${REGISTER_TEXT[entry.register]}`}>
      <Mark size={13} />
      {entry.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Decision outcomes
// ---------------------------------------------------------------------------

/**
 * Five outcomes, and the two that matter most are the ones a dashboard would hide.
 *
 * `skipped` is a feature: a stage that announces it did not run is the reason the
 * report can be trusted. `escalated` is the product's whole argument — the
 * orchestrator declining to claim something it did not establish. Neither is
 * styled as damage.
 */
export const DECISION_OUTCOME: Record<
  DecisionOutcome,
  { label: string; register: Register; mark: ComponentType<{ className?: string; size?: number }>; note: string }
> = {
  ok: {
    label: 'Ok',
    register: 'quiet',
    mark: MarkPass,
    note: 'The stage did what it set out to do.',
  },
  skipped: {
    label: 'Skipped',
    register: 'dim',
    mark: MarkSkipped,
    note: 'Deliberately not done, with the grounds stated. The report does not claim it happened.',
  },
  retried: {
    label: 'Retried',
    register: 'attention',
    mark: MarkFallback,
    note: 'The orchestrator was not satisfied and went round again — a re-plan for gaps it found itself.',
  },
  escalated: {
    label: 'Escalated',
    register: 'attention',
    mark: MarkReview,
    note: 'Handed to a person rather than guessed at. Refusing to decide is the point, not a shortfall.',
  },
  failed: {
    label: 'Failed',
    register: 'fault',
    mark: MarkFailed,
    note: 'The stage could not complete. What follows was built on less than it should have been.',
  },
};

export function OutcomeChip({ outcome }: { outcome: DecisionOutcome }) {
  const entry = DECISION_OUTCOME[outcome] ?? DECISION_OUTCOME.failed;
  const Mark = entry.mark;
  return (
    <span className={`label-cut inline-flex items-center gap-1.5 ${REGISTER_TEXT[entry.register]}`}>
      <Mark size={13} />
      {entry.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Scenario kinds and verdicts
// ---------------------------------------------------------------------------

export const SCENARIO_KIND: Record<ScenarioKind, { label: string; note: string }> = {
  primary_journey: {
    label: 'Primary journey',
    note: 'The path the application exists to serve. Planned first, from the stated intent or the map.',
  },
  refusal_path: {
    label: 'Refusal path',
    note: 'Checks the application says no when it should: wrong credentials, an empty required field.',
  },
  boundary_value: {
    label: 'Boundary value',
    note: 'Pushes a field to the edge the form invites — a malformed address, a quantity out of range.',
  },
  uncovered_flow: {
    label: 'Uncovered flow',
    note: 'Exists because the coverage evaluator found something no earlier plan touched.',
  },
};

/**
 * `not_run` is the one that must not be dressed as a failure.
 *
 * It means no executable baseline was produced, which is a fact about this tool
 * rather than a finding about the application. Rendering it in the fault register
 * would accuse the application of something the report explicitly does not claim.
 */
export const SCENARIO_VERDICT: Record<
  ScenarioVerdict,
  { label: string; register: Register; mark: ComponentType<{ className?: string; size?: number }>; note: string }
> = {
  passed: {
    label: 'Pass',
    register: 'quiet',
    mark: MarkPass,
    note: 'Every step ran and every recorded outcome held.',
  },
  failed: {
    label: 'Failed',
    register: 'fault',
    mark: MarkFailed,
    note: 'A step could not be completed and no repair satisfied its recorded outcome.',
  },
  needs_review: {
    label: 'Held for review',
    register: 'attention',
    mark: MarkReview,
    note: 'Ran, but something in it rests on judgement rather than on the application confirming it.',
  },
  not_run: {
    label: 'No baseline',
    register: 'dim',
    mark: MarkSkipped,
    note: 'No executable baseline was produced, so nothing was replayed. This is not a failure of the application.',
  },
  error: {
    label: 'Runner fault',
    register: 'fault',
    mark: MarkFailed,
    note: 'The harness failed. Nothing was established either way.',
  },
};

export function ScenarioVerdictChip({ verdict }: { verdict: ScenarioVerdict }) {
  const entry = SCENARIO_VERDICT[verdict] ?? SCENARIO_VERDICT.error;
  const Mark = entry.mark;
  return (
    <span className={`label-cut inline-flex items-center gap-1.5 ${REGISTER_TEXT[entry.register]}`}>
      <Mark size={13} />
      {entry.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Gap kinds
// ---------------------------------------------------------------------------

/**
 * `unexplored` is a fact, not a work item.
 *
 * A form with no submit control cannot be submitted empty; a page past the crawl
 * budget was never reached. Neither is something somebody forgot to test, and the
 * dim register plus the wording keep them out of the backlog they do not belong in.
 */
export const GAP_KIND: Record<GapKind, { label: string; register: Register; note: string }> = {
  missing_flow: {
    label: 'Untested flow',
    register: 'attention',
    note: 'A page or form no plan touches at all.',
  },
  missing_edge_case: {
    label: 'Untested boundary',
    register: 'attention',
    note: 'A boundary the form invites and no plan tries.',
  },
  missing_error_state: {
    label: 'Untested refusal',
    register: 'attention',
    note: 'A refusal path — empty required fields, wrong credentials — that nothing exercises.',
  },
  unexplored: {
    label: 'Not testable here',
    register: 'dim',
    note: 'Recorded rather than dropped, and not a gap anyone can close: no submit control, or past the crawl budget.',
  },
};

// ---------------------------------------------------------------------------
// The instrument strip
// ---------------------------------------------------------------------------

/**
 * One channel of the strip.
 *
 * A cut label over a tabular figure, separated from its neighbours by a hairline
 * rule and nothing else. Deliberately not a metric card: equal weight across the
 * band, no fill, no border box, no oversized number competing with the reading
 * beside it. A channel with no reading yet says so rather than showing a zero,
 * because zero is a measurement and "not yet" is not.
 */
export function Channel({
  label,
  value,
  note,
  register = 'stated',
  live = false,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  register?: Register;
  live?: boolean;
}) {
  return (
    /* A basis wide enough to hold a reading, so four channels wrap two-up on a
       phone rather than all shrinking until every value is an ellipsis. `flex-1`
       alone let them compete for 390px and truncate "Report 6 of 6" to "Repo…". */
    <div className="min-w-0 flex-1 basis-[9.5rem] border-l border-rule px-3 py-2 first:border-l-0 first:pl-0 sm:basis-auto">
      <p className="label-cut flex items-center gap-1.5">
        {live ? <span className="channel-live inline-block h-2 w-px bg-signal" aria-hidden /> : null}
        {label}
      </p>
      <p className={`figures mt-1 truncate text-[17px] font-semibold leading-tight ${REGISTER_TEXT[register]}`}>
        {value}
      </p>
      {note ? <p className="mt-0.5 truncate text-[12px] leading-snug text-read-300">{note}</p> : null}
    </div>
  );
}

/** Absent-but-not-zero, in the strip's own register. */
export function NoReading({ label = 'No reading' }: { label?: string }) {
  return <span className="text-read-300">{label}</span>;
}

// ---------------------------------------------------------------------------
// The coverage trace
// ---------------------------------------------------------------------------

/**
 * The climb across re-plan rounds, drawn as a recorded trace.
 *
 * Not a sparkline. A sparkline is a decorative summary of a series whose values
 * cannot be read off it, and this series is three or four points whose exact
 * values are the entire argument — so every point carries its own figure, its
 * refusal ratio, and what the orchestrator did next. The rule is drawn because a
 * recorded trace is the one thing this world draws.
 *
 * Rendered as an ordered list so the sequence survives without the geometry: a
 * screen reader gets round one, its score, and what followed it, in order.
 */
export function CoverageTrace({ rounds }: { rounds: CoverageRound[] }) {
  if (!rounds.length) return null;

  const followedByLabel: Record<CoverageRound['followedBy'], string> = {
    replanned: 'Re-planned for the gaps it found',
    nothing_fillable: 'Stopped: nothing fillable left in the map',
    budget_spent: 'Stopped: re-plan budget spent, gaps remain',
    replan_failed: 'Stopped: the re-plan itself failed',
  };

  const first = rounds[0];
  const last = rounds[rounds.length - 1];
  if (!first || !last) return null;
  const climbed = rounds.length > 1 && last.score > first.score;

  return (
    <div>
      {climbed ? (
        <p className="measure mb-3 text-[13px] leading-relaxed text-read-200">
          Coverage moved from{' '}
          <span className="figures font-semibold text-read-100">{first.score.toFixed(2)}</span> to{' '}
          <span className="figures font-semibold text-signal">{last.score.toFixed(2)}</span> across{' '}
          {rounds.length} readings, and refusal paths from{' '}
          <span className="figures">
            {first.refusalCovered} of {first.refusalTotal}
          </span>{' '}
          to{' '}
          <span className="figures">
            {last.refusalCovered} of {last.refusalTotal}
          </span>
          . The orchestrator found those gaps itself and planned for them without being asked.
        </p>
      ) : null}

      <ol className="space-y-0">
        {rounds.map((round, index) => {
          const previous = index > 0 ? rounds[index - 1] : null;
          const delta = previous ? round.score - previous.score : 0;
          const width = Math.max(2, Math.round(round.score * 100));
          return (
            <li key={round.round} className="border-t border-rule py-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="label-cut label-cut-bright">Reading {round.round}</span>
                <span className="figures text-[19px] font-semibold leading-none text-read-100">
                  {round.score.toFixed(2)}
                </span>
                {delta > 0 ? (
                  <span className="figures text-[13px] text-signal">+{delta.toFixed(2)}</span>
                ) : null}
                <span className="text-[12px] text-read-300">
                  {round.gaps} gap{round.gaps === 1 ? '' : 's'} open
                </span>
              </div>

              {/* The trace itself: a measured rule, not a chart. Its length is the
                  score, and the score is printed beside it, so the drawing never
                  carries a value the reader cannot also read. */}
              <div className="mt-2 flex items-center gap-2" aria-hidden>
                <span className="relative block h-px flex-1 bg-rule">
                  <span
                    className="trace-advance absolute inset-y-0 left-0 block bg-signal"
                    style={{ width: `${width}%`, height: '1px' }}
                  />
                </span>
              </div>

              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
                <div className="flex items-baseline gap-1.5">
                  <dt className="label-cut">Refusal</dt>
                  <dd className="figures text-read-200">
                    {round.refusalCovered} of {round.refusalTotal}
                  </dd>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <dt className="label-cut">Forms</dt>
                  <dd className="figures text-read-200">
                    {round.formsCovered} of {round.formsTotal}
                  </dd>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <dt className="label-cut">Pages</dt>
                  <dd className="figures text-read-200">
                    {round.pagesCovered} of {round.pagesTotal}
                  </dd>
                </div>
              </dl>

              <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-300">
                {followedByLabel[round.followedBy]}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
