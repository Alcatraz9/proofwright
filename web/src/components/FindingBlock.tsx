import type { ReactNode } from 'react';
import type { Finding, Parameter } from '../state/finding.ts';
import { ATTRIBUTION_REGISTER } from '../state/finding.ts';

/**
 * The finding.
 *
 * This is the first thing on the surface and it is a sentence, not a count. The
 * product's whole value is that it attributes a fault before it reports one — a
 * reader who takes only the top line away should have taken away whose problem it
 * is, and a number cannot say that.
 *
 * The attribution word carries the most weight on the page, the sentence explains
 * it, the consequence says what follows, and the strip beneath names the parameter
 * that decided it. The primary action sits here rather than in a header, because
 * the action a reader wants is the one this finding invites.
 */

const REGISTER_TEXT = {
  quiet: 'text-read-200',
  stated: 'text-read-100',
  attention: 'text-signal',
  fault: 'text-alarm-ink',
  dim: 'text-read-300',
} as const;

const REGISTER_EDGE = {
  quiet: 'border-rule-strong',
  stated: 'border-read-200',
  attention: 'border-signal',
  fault: 'border-alarm',
  dim: 'border-rule',
} as const;

export function FindingBlock({
  finding,
  clock,
  streamLabel,
  action,
  children,
}: {
  finding: Finding;
  /** Elapsed, ticking client-side while a run is live. */
  clock?: string | null;
  streamLabel?: string | null;
  /** The primary action. Sits with the finding, never in a header. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  const register = ATTRIBUTION_REGISTER[finding.attribution];

  return (
    <section
      aria-label="Finding"
      className={`rounded-plate border border-rule border-l-2 bg-plate-100 ${REGISTER_EDGE[register]}`}
    >
      {/*
        Full width, deliberately.
        This block previously carried the run's arming controls in a right-hand
        column, which made the finding two thirds of a row instead of the width of
        the page and left roughly 270px of empty plate under it, because the column
        beside it was always the taller of the two. The finding is the one thing on
        this surface that earns the full measure.
      */}
      <div className="px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h1
            className={`readout attribute-settle text-[clamp(1.5rem,3.4vw,2.25rem)] font-semibold leading-[1.08] ${REGISTER_TEXT[register]}`}
          >
            {finding.verdictWord}
          </h1>

          {clock ? (
            <span className="mono-figures flex items-baseline gap-2 text-[15px] text-read-200">
              {clock}
              {streamLabel ? <span className="label-cut">{streamLabel}</span> : null}
            </span>
          ) : null}

          {action ? <div className="ml-auto flex flex-wrap items-center gap-2">{action}</div> : null}
        </div>

        <p className="readout measure mt-3.5 text-[clamp(0.9375rem,1.5vw,1.125rem)] leading-snug text-read-100">
          {finding.headline}
        </p>
        <p className="measure mt-2.5 text-[13px] leading-relaxed text-read-300">{finding.consequence}</p>
      </div>

      {finding.parameters.length > 0 ? <ParameterStrip parameters={finding.parameters} /> : null}

      {children}
    </section>
  );
}

/**
 * The parameters that decided the finding.
 *
 * The decisive one is marked and leads, because "which parameter decided this" is
 * the question a reader asks immediately after reading the verdict. The rest are
 * context and are set at the same contrast but a quieter register.
 */
function ParameterStrip({ parameters }: { parameters: Parameter[] }) {
  const ordered = [...parameters].sort((a, b) => Number(Boolean(b.decisive)) - Number(Boolean(a.decisive)));

  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-4 border-t border-rule px-4 py-3.5 sm:px-6">
      {ordered.map((parameter) => (
        <div
          key={parameter.label}
          className={`min-w-0 ${parameter.decisive ? 'border-l-2 border-signal pl-3' : 'border-l border-rule pl-3'}`}
        >
          <dt className={`label-cut ${parameter.decisive ? 'text-signal' : ''}`}>
            {/* The decisive parameter keeps its own name — which parameter decided
                it is the point, so replacing the name with "decided by" would drop
                the answer and keep the label. */}
            {parameter.decisive ? `Decided by — ${parameter.label}` : parameter.label}
          </dt>
          <dd className="mono-figures mt-1 text-[13px] text-read-100">{parameter.value}</dd>
          {parameter.note ? (
            <dd className="measure mt-1 text-[12px] leading-relaxed text-read-300">{parameter.note}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
