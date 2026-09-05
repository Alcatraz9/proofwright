import type { ComponentType, ReactNode } from 'react';
import type { RunStatus, VisualChangeKind, A11yImpact, SecuritySeverity } from '../api/types.ts';
import type { StepState } from '../state/runModel.ts';
import {
  MarkFailed,
  MarkFallback,
  MarkPass,
  MarkPending,
  MarkRepaired,
  MarkReview,
  MarkSkipped,
} from './icons.tsx';

/**
 * The verdict vocabulary.
 *
 * Six step states, and each is separated from the others on three independent
 * channels: a drawn mark, a trace style, and a written label. Colour is a fourth
 * channel and never the only one, which is what makes the set legible to a
 * colour-blind reader and to a screen reader without a parallel text layer bolted
 * on afterwards.
 *
 * Two of the six carry chroma. `attention` is the caution colour, used where a
 * person has to decide something. `fault` is used for exactly one meaning — the
 * application is at fault — and nothing else on the surface may borrow it.
 *
 * A passing step is deliberately achromatic. Green would put the twenty rows that
 * need no attention in the same visual register as the one that does.
 */

/**
 * `pass` is the newest and the most restricted: it belongs to the run-shaped
 * views, where a reader scans a column of completed work for the entry that is
 * not. See the palette note in index.css for why it is not for step marks or any
 * list where most rows pass.
 */
export type Register = 'quiet' | 'stated' | 'attention' | 'fault' | 'dim' | 'pass';

/**
 * The one copy. This lived inline in four other files, which is how a register
 * added here compiled everywhere and rendered nowhere.
 */
export const REGISTER_TEXT: Record<Register, string> = {
  quiet: 'text-read-200',
  stated: 'text-read-100',
  attention: 'text-signal',
  fault: 'text-alarm-ink',
  dim: 'text-read-300',
  pass: 'text-pass',
};

const REGISTER_TRACE: Record<Register, string> = {
  quiet: 'var(--color-rule-strong)',
  stated: 'var(--color-read-200)',
  attention: 'var(--color-signal)',
  fault: 'var(--color-alarm)',
  dim: 'var(--color-rule)',
  // Present for completeness of the union. No step trace uses it: the trace
  // channel is per-step, and a green line per passing step is the wall again.
  pass: 'var(--color-pass)',
};

export interface StepStateStyle {
  /** Written out in full. Never abbreviated to a colour. */
  label: string;
  register: Register;
  /** One of the four trace styles defined in the stylesheet. */
  trace: 'solid' | 'dashed' | 'dotted' | 'spliced';
  mark: ComponentType<{ className?: string; size?: number }>;
  /** What the state means, in the product's own words. */
  note: string;
}

export const STEP_STATE_STYLE: Record<StepState, StepStateStyle> = {
  pending: {
    label: 'Not started',
    register: 'dim',
    trace: 'dotted',
    mark: MarkPending,
    note: 'Queued behind an earlier step.',
  },
  running: {
    label: 'In flight',
    register: 'stated',
    trace: 'solid',
    mark: MarkPending,
    note: 'Executing against the live application now.',
  },
  passed: {
    label: 'Pass',
    register: 'quiet',
    trace: 'solid',
    mark: MarkPass,
    note: 'Found by the recorded locator, and the recorded outcome held.',
  },
  drift: {
    label: 'Pass on fallback',
    register: 'attention',
    trace: 'dashed',
    mark: MarkFallback,
    note: 'The recorded locator no longer matches; an alternate rescued the step. One change from needing a repair.',
  },
  healing: {
    label: 'Attributing',
    register: 'attention',
    trace: 'dashed',
    mark: MarkPending,
    note: 'The element was not found. Deciding whether a replacement can satisfy the recorded outcome.',
  },
  healed: {
    label: 'Repaired',
    register: 'stated',
    trace: 'spliced',
    mark: MarkRepaired,
    note: 'A replacement was executed and the step’s own recorded outcome held against it.',
  },
  failed: {
    label: 'Failed',
    register: 'fault',
    trace: 'solid',
    mark: MarkFailed,
    note: 'Not repaired. Either the application is at fault, or no replacement could satisfy the outcome.',
  },
  skipped: {
    label: 'Not reached',
    register: 'dim',
    trace: 'dotted',
    mark: MarkSkipped,
    note: 'An earlier step stopped the run before this one was attempted.',
  },
};

export function traceColour(register: Register): string {
  return REGISTER_TRACE[register];
}

/** The state, written and marked. Used wherever a step is named outside the channel. */
export function StepStateChip({ state }: { state: StepState }) {
  const style = STEP_STATE_STYLE[state];
  const Mark = style.mark;
  return (
    <span className={`label-cut inline-flex items-center gap-1.5 ${REGISTER_TEXT[style.register]}`}>
      <Mark size={13} />
      {style.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Run-level verdicts
// ---------------------------------------------------------------------------

const RUN_STATUS: Record<RunStatus, { label: string; register: Register; mark: ComponentType<{ className?: string; size?: number }> }> = {
  queued: { label: 'Queued', register: 'dim', mark: MarkPending },
  running: { label: 'In flight', register: 'stated', mark: MarkPending },
  passed: { label: 'Pass', register: 'quiet', mark: MarkPass },
  failed: { label: 'Failed', register: 'fault', mark: MarkFailed },
  needs_review: { label: 'Held for review', register: 'attention', mark: MarkReview },
  cancelled: { label: 'Cancelled', register: 'dim', mark: MarkSkipped },
  error: { label: 'Runner fault', register: 'fault', mark: MarkFailed },
};

export function RunStatusChip({ status }: { status: RunStatus }) {
  const entry = RUN_STATUS[status] ?? RUN_STATUS.error;
  const Mark = entry.mark;
  return (
    <span className={`label-cut inline-flex items-center gap-1.5 ${REGISTER_TEXT[entry.register]}`}>
      <Mark size={13} />
      {entry.label}
    </span>
  );
}

export function runStatusLabel(status: RunStatus): string {
  return (RUN_STATUS[status] ?? RUN_STATUS.error).label;
}

export function PlanStatusChip({ status }: { status: 'DRAFT' | 'APPROVED' }) {
  return (
    <span
      className={`label-cut inline-flex items-center gap-1.5 ${
        status === 'APPROVED' ? 'text-read-100' : 'text-signal'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-2 w-2 ${status === 'APPROVED' ? 'bg-read-200' : 'border border-signal'}`}
      />
      {status === 'APPROVED' ? 'Signed off' : 'Unsigned draft'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Appearance findings
// ---------------------------------------------------------------------------

/**
 * A finding without its kind is a number with no meaning, so the kind is never
 * reduced to a count. Absorbed cosmetic change and missing content are different
 * events and are never summed into one badge.
 */
export const VISUAL_KIND_STYLE: Record<VisualChangeKind, { label: string; register: Register; note: string }> = {
  COSMETIC: {
    label: 'Cosmetic',
    register: 'dim',
    note: 'Only properties that cannot move or resize a box changed. Absorbed into the baseline.',
  },
  TEXT_CHANGED: {
    label: 'Text changed',
    register: 'quiet',
    note: 'The same element, different copy. Whether that fails is decided by the step’s assertions, not here.',
  },
  LAYOUT_SHIFT: {
    label: 'Layout shift',
    register: 'attention',
    note: 'Moved or resized beyond tolerance. Reported with the delta; gates only in strict mode.',
  },
  CONTENT_MISSING: {
    label: 'Content missing',
    register: 'fault',
    note: 'Recorded in the baseline and absent now, with nothing accounting for it. Never absorbed.',
  },
  CONTENT_REPLACED: {
    label: 'Content replaced',
    register: 'stated',
    note: 'Gone, but a repair identified what replaced it. Not a loss, and still worth a person’s eye.',
  },
  CONTENT_ADDED: {
    label: 'Content added',
    register: 'quiet',
    note: 'Present now with no recorded counterpart.',
  },
};

export function VisualKindChip({ kind }: { kind: VisualChangeKind }) {
  const style = VISUAL_KIND_STYLE[kind];
  return (
    <span className={`label-cut ${REGISTER_TEXT[style.register]}`} title={style.note}>
      {style.label}
    </span>
  );
}

const IMPACT_REGISTER: Record<A11yImpact, Register> = {
  critical: 'fault',
  serious: 'attention',
  moderate: 'quiet',
  minor: 'dim',
};

export function ImpactChip({ impact }: { impact: A11yImpact }) {
  return <span className={`label-cut ${REGISTER_TEXT[IMPACT_REGISTER[impact] ?? 'dim']}`}>{impact}</span>;
}

const SEVERITY_REGISTER: Record<SecuritySeverity, Register> = {
  high: 'fault',
  medium: 'attention',
  low: 'quiet',
  info: 'dim',
};

export function SeverityChip({ severity }: { severity: SecuritySeverity }) {
  return <span className={`label-cut ${REGISTER_TEXT[SEVERITY_REGISTER[severity] ?? 'dim']}`}>{severity}</span>;
}

export function Chip({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'heal' | 'warn' | 'fail' | 'pass';
}) {
  const register: Record<string, Register> = {
    neutral: 'dim',
    accent: 'attention',
    heal: 'stated',
    warn: 'attention',
    fail: 'fault',
    pass: 'quiet',
  };
  return (
    <span className={`label-cut inline-flex items-center gap-1.5 ${REGISTER_TEXT[register[tone] ?? 'dim']}`}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * A score, presented as the worst page because that is what it is. An average lets
 * one unusable page hide behind four sound ones, and the unusable page is the one
 * that decides whether the journey works.
 */
export function Score({ value, caption, hint }: { value: number | null; caption: string; hint?: string }) {
  const register: Register = value === null ? 'dim' : value >= 90 ? 'quiet' : value >= 70 ? 'attention' : 'fault';
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className={`mono-figures text-[32px] font-semibold leading-none ${REGISTER_TEXT[register]}`}>
          {value === null ? '——' : String(value).padStart(2, '0')}
        </span>
        <span className="label-cut">of 100</span>
      </div>
      <p className="label-cut label-cut-bright mt-2">{caption}</p>
      {hint ? <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">{hint}</p> : null}
    </div>
  );
}

/** A single measured parameter. Reads as a gauge field, not a metric card. */
export function Metric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'accent' | 'heal' | 'warn' | 'fail' | 'pass';
}) {
  const register: Record<string, Register> = {
    neutral: 'stated',
    accent: 'attention',
    heal: 'stated',
    warn: 'attention',
    fail: 'fault',
    pass: 'quiet',
  };
  return (
    <div className="border-l border-rule pl-3">
      <p className="label-cut">{label}</p>
      <p className={`mono-figures mt-1 text-[19px] font-semibold leading-none ${REGISTER_TEXT[register[tone] ?? 'stated']}`}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-[12px] leading-snug text-read-300">{hint}</p> : null}
    </div>
  );
}
