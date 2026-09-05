import { useState } from 'react';
import type { HealPayload } from '../api/types.ts';
import { api } from '../api/client.ts';
import { durabilityVerdict, parseLocator, STRATEGY_NOTE } from '../lib/locator.ts';
import { Button, Code, Quote, SectionTitle } from './ui.tsx';
import { IconExternal } from './icons.tsx';

/**
 * The evidence record for a repair.
 *
 * Everything here exists to stop a repair reading as more certain than it was: what
 * it replaced, what replaced it, what the application confirmed afterwards, whether
 * the answer was reused from a previous run, and a way back. A repair that cannot
 * be undone is a rewrite.
 *
 * The two element crops are the only saturated images on the surface, and that is
 * deliberate — they are the evidence, and everything around them is instrumentation
 * reporting on them.
 */

const REFUSAL: Record<string, { title: string; body: string }> = {
  rejected: {
    title: 'Repair refused',
    body: 'A candidate was proposed and did not hold up. The step keeps its original classification.',
  },
  below_threshold: {
    title: 'Under the admission floor',
    body: 'The best candidate did not clear the floor, so it was never executed against the page.',
  },
  no_candidate: {
    title: 'No candidate serves the intent',
    body: 'Nothing on the page does this job. That is the right answer when a capability has genuinely been removed — there is nothing to repair toward, and the fault belongs to the application.',
  },
  unlocatable: {
    title: 'Proposed locator matched nothing',
    body: 'The replacement could not be resolved on the live page, or resolved ambiguously.',
  },
  execution_failed: {
    title: 'Candidate executed, outcome still not met',
    body: 'The replacement was found and acting on it did not reproduce the recorded outcome. Refusing here is the point: accepting it would have hidden a real defect.',
  },
};

export function HealCard({
  heal,
  outcome,
  planId,
  onReverted,
}: {
  heal: HealPayload;
  outcome: 'accepted' | 'rejected';
  planId: string;
  onReverted?: () => void;
}) {
  const accepted = outcome === 'accepted';
  const previous = parseLocator(heal.previousLocator);
  const next = parseLocator(heal.newLocator);
  const durability = accepted ? durabilityVerdict(previous?.strategy ?? null, next?.strategy ?? null) : null;

  // A left rule rather than a bordered panel: a bordered box inside the channel
  // plate is a card inside a card, which is depth for its own sake. The rule
  // carries the same grouping and keeps the evidence in the row it belongs to.
  return (
    <section
      className={`attribute-settle mt-3 border-l-2 pl-3.5 ${
        accepted ? 'border-rule-strong' : 'border-alarm'
      }`}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-2.5">
        <h3 className={`label-cut ${accepted ? 'label-cut-bright' : 'text-alarm-ink'}`}>
          {accepted ? 'Repair record' : (REFUSAL[heal.status]?.title ?? 'Repair refused')}
        </h3>
        <span className="mono-figures text-[12px] text-read-300">{heal.model}</span>
        <span className={`label-cut ml-auto ${heal.proposalFromCache ? '' : 'text-signal'}`}>
          {heal.proposalFromCache ? 'Proposal reused from cache' : 'Live model call'}
        </span>
      </header>

      <div className="space-y-5 py-4">
        {accepted ? (
          <LocatorChange previous={heal.previousLocator} next={heal.newLocator} verdict={durability} />
        ) : (
          <Refusal heal={heal} />
        )}

        <Plates heal={heal} accepted={accepted} />

        <AdmissionFloor confidence={heal.confidence} threshold={heal.threshold} />

        <div>
          <SectionTitle hint="verbatim">Stated reasoning</SectionTitle>
          <Quote cite={heal.model}>{heal.reason}</Quote>
        </div>

        <Corroboration heal={heal} accepted={accepted} />

        <dl className="flex flex-wrap gap-x-8 gap-y-3 border-t border-rule pt-3">
          <Counter label="Candidates proposed" value={heal.candidatesProposed} />
          <Counter label="Candidates executed" value={heal.candidatesTried} />
          <Counter label="Model calls" value={heal.proposalFromCache ? '0' : '1'} />
        </dl>

        {accepted ? <Revert planId={planId} stepId={heal.stepId} onReverted={onReverted} /> : null}
      </div>
    </section>
  );
}

function LocatorChange({
  previous,
  next,
  verdict,
}: {
  previous: string;
  next: string | null;
  verdict: { tone: 'better' | 'same' | 'worse' | 'unknown'; label: string } | null;
}) {
  return (
    <div>
      <SectionTitle>Identity</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <LocatorFace label="As recorded" parsed={parseLocator(previous)} />
        <LocatorFace label="As repaired" parsed={parseLocator(next)} emphasis />
      </div>

      {verdict && verdict.tone !== 'unknown' ? (
        <p
          className={`measure mt-2.5 text-[12px] leading-relaxed ${
            verdict.tone === 'better' ? 'text-read-100' : verdict.tone === 'worse' ? 'text-signal' : 'text-read-300'
          }`}
        >
          {verdict.label}
          {verdict.tone === 'better'
            ? ' — and the strategy it moved to only exists because the control now has an accessible name. The accessibility fix is what made the better locator available.'
            : ''}
        </p>
      ) : null}
    </div>
  );
}

function LocatorFace({
  label,
  parsed,
  emphasis = false,
}: {
  label: string;
  parsed: ReturnType<typeof parseLocator>;
  emphasis?: boolean;
}) {
  return (
    <div className={`border-l pl-3 ${emphasis ? 'border-signal' : 'border-rule'}`}>
      <p className="label-cut flex flex-wrap items-baseline gap-x-2">
        {label}
        {parsed?.strategy ? <span className={emphasis ? 'text-signal' : 'text-read-200'}>{parsed.strategy}</span> : null}
      </p>
      <div className="mt-1.5">
        <Code className="block break-all">{parsed?.raw ?? '—'}</Code>
      </div>
      {parsed?.strategy ? (
        <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-300">{STRATEGY_NOTE[parsed.strategy]}</p>
      ) : null}
    </div>
  );
}

function Refusal({ heal }: { heal: HealPayload }) {
  return (
    <div className="space-y-3">
      <p className="measure text-[13px] leading-relaxed text-read-200">
        {REFUSAL[heal.status]?.body ?? 'The repair did not produce a usable replacement.'}
      </p>
      <div>
        <p className="label-cut mb-1.5">Locator that failed</p>
        <Code className="block break-all">{heal.previousLocator}</Code>
      </div>
    </div>
  );
}

/**
 * Two stills rather than a mirrored viewport: what the test was recorded against,
 * and what the healer chose. Both are already cropped to the element and outlined
 * at capture time, so the plate is the evidence rather than a screenshot of a page.
 * The locator sits underneath as selectable text and is never burnt into the image.
 */
function Plates({ heal, accepted }: { heal: HealPayload; accepted: boolean }) {
  const { baseline, found } = heal.shots;
  if (!baseline && !found) return null;

  return (
    <div>
      <SectionTitle hint="cropped and outlined at capture">Plates</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Plate
          src={baseline}
          caption="Recorded"
          absent="Recorded before plate capture existed, so there is no before image."
        />
        <Plate
          src={found}
          caption={accepted ? 'Repaired' : 'Inspected'}
          absent="No element was captured — nothing was found to photograph."
          emphasis
        />
      </div>
    </div>
  );
}

function Plate({
  src,
  caption,
  absent,
  emphasis = false,
}: {
  src: string | null;
  caption: string;
  absent: string;
  emphasis?: boolean;
}) {
  return (
    <figure className="min-w-0">
      <figcaption className={`label-cut mb-1.5 ${emphasis ? 'text-signal' : ''}`}>{caption}</figcaption>
      {src ? (
        <a
          href={`/artifacts/${src}`}
          target="_blank"
          rel="noreferrer"
          className={`group block rounded-plate border bg-plate-200 p-1 transition-colors ${
            emphasis ? 'border-signal/60 hover:border-signal' : 'border-rule hover:border-rule-strong'
          } focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2 outline-none`}
        >
          <img src={`/artifacts/${src}`} alt={`${caption} element`} loading="lazy" className="block max-h-56 w-full object-contain" />
          <span className="label-cut mt-1 flex items-center justify-end gap-1 px-1 pb-0.5 text-read-300 group-hover:text-signal">
            Full plate
            <IconExternal size={12} />
          </span>
        </a>
      ) : (
        <p className="measure rounded-plate border border-dashed border-rule px-3 py-6 text-[12px] leading-relaxed text-read-300">
          {absent}
        </p>
      )}
      {/* Nothing is restated under the plate. Identity, directly above, names both
          locators and both strategies; the caption says which of the two this plate
          is. Repeating either put one string in three or four places inside a single
          panel, which is template wiring rather than information. */}
    </figure>
  );
}

/**
 * Confidence, presented as what it is: the gate a candidate has to clear before it
 * is allowed to be executed. It is the model scoring its own answer, so it cannot
 * be evidence that the answer was right — the corroboration below is.
 */
function AdmissionFloor({ confidence, threshold }: { confidence: number; threshold: number }) {
  const cleared = confidence >= threshold;
  const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;

  return (
    <div>
      <SectionTitle hint="an admission gate, not proof">Confidence</SectionTitle>
      <div className="relative h-6 border border-rule bg-plate-200">
        <div className={`h-full ${cleared ? 'bg-signal/45' : 'bg-alarm/35'}`} style={{ width: pct(confidence) }} />
        <div className="absolute inset-y-0 w-px bg-read-100" style={{ left: pct(threshold) }} aria-hidden />
        <span className="label-cut absolute inset-y-0 right-1.5 flex items-center label-cut-bright">
          <span className="mono-figures">{confidence.toFixed(2)}</span>
        </span>
      </div>
      <p className="measure mt-2 text-[12px] leading-relaxed text-read-300">
        Scored <span className="mono-figures text-read-100">{confidence.toFixed(2)}</span> against a floor of{' '}
        <span className="mono-figures text-read-100">{threshold.toFixed(2)}</span> (marked). This decides whether a
        candidate may be executed against the page — never whether the repair was correct.
      </p>
    </div>
  );
}

function Corroboration({ heal, accepted }: { heal: HealPayload; accepted: boolean }) {
  return (
    <div>
      <SectionTitle>What corroborated it</SectionTitle>
      {heal.verification ? (
        <p className="measure text-[13px] leading-relaxed text-read-200">{heal.verification}</p>
      ) : (
        <p className="measure text-[13px] leading-relaxed text-read-300">
          Nothing was reported back from the application.
        </p>
      )}

      {accepted && !heal.verifiedAgainstOutcome ? (
        <p className="measure mt-2.5 border-l border-signal bg-plate-200 px-3 py-2 text-[12px] leading-relaxed text-signal-ink">
          This step records no post-condition, so there was nothing for the healer to check its candidate against.
          The outcome “held” only because there was nothing to hold. It rests on the model’s judgement, and the run
          is held for review because of it.
        </p>
      ) : null}

      {accepted && heal.verifiedAgainstOutcome ? (
        <p className="measure mt-2.5 text-[12px] leading-relaxed text-read-200">
          The replacement was executed against the live page and satisfied the step’s original recorded outcome.
          That is what admitted it — not the score above.
        </p>
      ) : null}
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="label-cut">{label}</dt>
      <dd className="mono-figures mt-1 text-[15px] text-read-100">{value}</dd>
    </div>
  );
}

function Revert({
  planId,
  stepId,
  onReverted,
}: {
  planId: string;
  stepId: string;
  onReverted?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'refused'>('idle');
  const [reason, setReason] = useState<string | null>(null);

  const revert = async (): Promise<void> => {
    setState('working');
    try {
      const result = await api.revertHeal(planId, stepId);
      if (result.reverted) {
        setState('done');
        onReverted?.();
      } else {
        setState('refused');
        setReason(result.reason ?? 'The baseline had nothing to revert.');
      }
    } catch (err) {
      setState('refused');
      setReason(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-3">
      <Button onClick={revert} disabled={state === 'working' || state === 'done'}>
        {state === 'done' ? 'Reverted' : state === 'working' ? 'Reverting' : 'Revert this repair'}
      </Button>
      <p className="measure text-[12px] leading-relaxed text-read-300">
        {state === 'done'
          ? 'The baseline holds the locator it was recorded with again. Reverting a second time is a no-op.'
          : state === 'refused'
            ? (reason ?? 'Nothing to revert.')
            : 'The previous locator and fingerprint are kept on the baseline, so there is always a way back.'}
      </p>
    </div>
  );
}
