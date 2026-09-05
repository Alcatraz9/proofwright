import { useEffect, useState } from 'react';
import type { StepState, StepView } from '../state/runModel.ts';
import { parseLocator, STRATEGY_NOTE } from '../lib/locator.ts';
import { ms } from '../lib/format.ts';
import { Code, Empty, focusRing } from './ui.tsx';
import { STEP_STATE_STYLE, StepStateChip, traceColour } from './status.tsx';
import { IconDisclose } from './icons.tsx';
import { HealCard } from './HealCard.tsx';

/**
 * The step channel.
 *
 * A time-ordered readout rather than a list of rows: one trace runs the height of
 * the run, and each step is a mark on it. That shape is doing work a list cannot —
 * a repair is legible as the channel breaking and rejoining, and a run that
 * stopped early is legible as a trace that terminates rather than as rows that
 * happen to stop.
 *
 * Every state is separated from the others by its mark, its trace style and its
 * written label, so none of the six depends on hue.
 */

export function StepChannel({
  steps,
  totalSteps,
  planId,
  onBaselineChanged,
}: {
  steps: StepView[];
  totalSteps: number | null;
  planId: string | null;
  onBaselineChanged?: () => void;
}) {
  const ghosts = totalSteps === null ? 0 : Math.max(0, totalSteps - steps.length);

  if (steps.length === 0 && ghosts === 0) {
    return (
      <Empty
        title="No channel recorded."
        body="Start a run, or open a past one. A finished run is read back from its own recorded events, so the channel draws identically either way."
      />
    );
  }

  // Cumulative offsets, so the left axis reads as elapsed time rather than as an
  // index. Steps that never ran contribute nothing.
  let elapsed = 0;
  const offsets = steps.map((step) => {
    const at = elapsed;
    elapsed += step.durationMs ?? 0;
    return at;
  });

  return (
    <ol className="py-1">
      {steps.map((step, index) => (
        <ChannelRow
          key={step.stepId}
          step={step}
          offsetMs={offsets[index] ?? 0}
          first={index === 0}
          last={index === steps.length - 1 && ghosts === 0}
          planId={planId}
          onBaselineChanged={onBaselineChanged}
        />
      ))}
      {Array.from({ length: ghosts }, (_, index) => (
        <GhostRow key={`unreached-${index}`} index={steps.length + index + 1} last={index === ghosts - 1} />
      ))}
    </ol>
  );
}

function ChannelRow({
  step,
  offsetMs,
  first,
  last,
  planId,
  onBaselineChanged,
}: {
  step: StepView;
  offsetMs: number;
  first: boolean;
  last: boolean;
  planId: string | null;
  onBaselineChanged?: () => void;
}) {
  const style = STEP_STATE_STYLE[step.state];
  const Mark = style.mark;
  const locator = parseLocator(step.locator);
  const live = step.state === 'running' || step.state === 'healing';
  const ran = step.durationMs !== null && step.state !== 'skipped';

  const expandable = step.heal !== null || step.failure !== null || step.escalated !== null || step.healError !== null;
  const [open, setOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);

  // A repair and a failure are the two things worth reading in full, so they open
  // themselves once. Everything else stays folded.
  useEffect(() => {
    if (autoOpened) return;
    if (step.heal !== null || step.state === 'failed') {
      setOpen(true);
      setAutoOpened(true);
    }
  }, [step.heal, step.state, autoOpened]);

  const colour = traceColour(style.register);

  return (
    <li className="relative">
      <div className="grid grid-cols-[3.5rem_1.75rem_minmax(0,1fr)] items-start gap-x-3 px-3 sm:px-4">
        {/* Elapsed axis */}
        {/* Only a step that actually ran has an elapsed offset. Skipped steps
            inherited the last cumulative value and all printed the same time,
            which read as six steps running simultaneously. */}
        <span className="mono-figures pt-3 text-right text-[12px] leading-5 text-read-300">
          {ran ? `+${(offsetMs / 1000).toFixed(1)}s` : live ? '——' : ''}
        </span>

        {/* The channel itself */}
        <span className="relative self-stretch" aria-hidden>
          {/* Incoming segment */}
          {!first ? (
            <span
              className={`trace trace-${style.trace} top-0 h-3.5`}
              style={{ ['--trace-color' as string]: colour }}
            />
          ) : null}
          {/* Outgoing segment. Stops at a terminated channel. */}
          {!last && step.state !== 'failed' ? (
            <span
              className={`trace trace-${style.trace} bottom-0 top-8 ${live ? 'trace-advance' : ''}`}
              style={{ ['--trace-color' as string]: colour }}
            />
          ) : null}
          <span
            className={`absolute left-1/2 top-3.5 -translate-x-1/2 ${live ? 'channel-live' : ''}`}
            style={{ color: colour }}
          >
            <Mark size={16} />
          </span>
        </span>

        {/* Readout */}
        <div className="min-w-0 border-b border-rule py-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[14px] font-semibold text-read-100">{step.action}</span>
            <span className="mono-figures text-[12px] text-read-300">{step.stepId}</span>
            <StepStateChip state={step.state} />
            <span className="mono-figures ml-auto text-[12px] text-read-300">
              {step.durationMs === null ? (live ? 'running' : '') : ms(step.durationMs)}
            </span>
          </div>

          {locator ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Code className="break-all">{locator.raw}</Code>
              {locator.strategy ? (
                <span className="label-cut" title={STRATEGY_NOTE[locator.strategy]}>
                  {locator.strategy}
                </span>
              ) : null}
            </div>
          ) : null}

          {step.state === 'drift' ? (
            <p className="measure mt-2 text-[12px] leading-relaxed text-signal">
              Reached by a fallback, not by the recorded locator. Nothing failed — and the baseline is one change
              from needing a repair here.
            </p>
          ) : null}

          {step.failure ? <FailureLine failure={step.failure} /> : null}

          {step.escalated ? (
            <p className="measure mt-2 border-l border-signal pl-2.5 text-[12px] leading-relaxed text-signal">
              {step.escalated.message}
            </p>
          ) : null}

          {step.healError ? (
            <p className="measure mt-2 text-[12px] leading-relaxed text-signal">
              The repair could not run: {step.healError}. The step keeps its original classification rather than
              being reported as something else.
            </p>
          ) : null}

          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              className={`label-cut mt-2.5 inline-flex items-center gap-1.5 text-signal transition-colors hover:text-signal-ink ${focusRing}`}
            >
              <IconDisclose open={open} size={13} />
              {open ? 'Fold evidence' : step.heal ? 'Evidence for the repair' : 'Attribution detail'}
            </button>
          ) : null}

          {open && step.heal && step.healOutcome ? (
            <HealCard
              heal={step.heal}
              outcome={step.healOutcome}
              planId={planId ?? ''}
              onReverted={onBaselineChanged}
            />
          ) : null}

          {open && !step.heal && step.failure ? <FailureDetail failure={step.failure} /> : null}
        </div>
      </div>
    </li>
  );
}

/**
 * The classification, and whether it permits a repair.
 *
 * This is the product's whole distinction, so it is stated on the row rather than
 * folded away: a missing element and a wrong result are different faults with
 * different owners, and they must never read alike.
 */
function FailureLine({ failure }: { failure: { kind: string; healable: boolean; message: string } }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="mono-figures text-[12px] font-semibold text-alarm-ink">{failure.kind}</span>
      <span className={`label-cut ${failure.healable ? 'text-signal' : 'text-alarm-ink'}`}>
        {failure.healable ? 'Locator fault — repair permitted' : 'Not a locator fault — repair withheld'}
      </span>
    </div>
  );
}

function FailureDetail({ failure }: { failure: { kind: string; healable: boolean; message: string } }) {
  return (
    <div
      className={`mt-3 space-y-2.5 rounded-plate border bg-plate-000 px-3.5 py-3 ${
        failure.healable ? 'border-signal/50' : 'border-alarm/50'
      }`}
    >
      <p className="measure text-[13px] leading-relaxed text-read-200">{failure.message}</p>
      <p className="measure text-[12px] leading-relaxed text-read-300">
        {failure.healable
          ? 'Classified as a locator fault: nothing was found on a settled page. A replacement may be proposed, and it has to satisfy the step’s own recorded outcome before it is accepted.'
          : 'Classified as not a locator fault, and the healer was never consulted. The element was found and the application did the wrong thing with it. Repairing this would trade a real defect for a green tick, so the run escalates instead.'}
      </p>
    </div>
  );
}

function GhostRow({ index, last }: { index: number; last: boolean }) {
  const colour = traceColour('dim');
  return (
    <li className="relative">
      <div className="grid grid-cols-[3.5rem_1.75rem_minmax(0,1fr)] items-start gap-x-3 px-3 sm:px-4">
        <span className="mono-figures pt-3 text-right text-[12px] leading-5 text-read-300">{index}</span>
        <span className="relative self-stretch" aria-hidden>
          <span className="trace trace-dotted top-0 h-3.5" style={{ ['--trace-color' as string]: colour }} />
          {!last ? (
            <span className="trace trace-dotted bottom-0 top-8" style={{ ['--trace-color' as string]: colour }} />
          ) : null}
        </span>
        <div className="min-w-0 border-b border-rule py-3">
          <span className="label-cut">Not reached</span>
        </div>
      </div>
    </li>
  );
}

/** Kept for the state legend in the help panel. */
export const CHANNEL_STATES: StepState[] = [
  'passed',
  'drift',
  'healed',
  'failed',
  'skipped',
  'pending',
];
