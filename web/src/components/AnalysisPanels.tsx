import type { ReactNode } from 'react';
import type {
  A11yCheckedPayload,
  A11yStepCheckedPayload,
  A11yViolation,
  RunCompletePayload,
  SecurityCheckedPayload,
  SecurityFinding,
} from '../api/types.ts';
import type { VisualPageView } from '../state/runModel.ts';
import { worstScore } from '../state/runModel.ts';
import { pluralise } from '../lib/format.ts';
import { Code, Panel, PanelHeader, Pending, SectionTitle } from './ui.tsx';
import { ImpactChip, Score, SeverityChip, VisualKindChip, VISUAL_KIND_STYLE } from './status.tsx';
import { IconDisclose, IconExternal } from './icons.tsx';

/**
 * Corroboration: what else the run observed while it was replaying.
 *
 * Two ordering facts shape this. The appearance verdicts are computed once the
 * walk is finished, deliberately, so that an element a repair replaced is not also
 * reported as missing content — until then they read as awaited rather than as
 * zero, because zero is a result the run has not reached. The accessibility and
 * security reads arrive per page during the walk and fill in as they land.
 *
 * Per-page detail is disclosed with `<details>` rather than hidden behind a
 * screen-reader-only table. An `sr-only` table clips to one pixel while its cells
 * keep full-size bounding boxes, and a sighted reader who wants the numbers cannot
 * reach it either.
 */

export function AnalysisColumn({
  a11y,
  a11ySteps,
  security,
  visual,
  complete,
  pending,
}: {
  a11y: A11yCheckedPayload[];
  a11ySteps: A11yStepCheckedPayload[];
  security: SecurityCheckedPayload[];
  visual: VisualPageView[];
  complete: RunCompletePayload | null;
  pending: boolean;
}) {
  return (
    <div className="space-y-4">
      <Accessibility pages={a11y} steps={a11ySteps} pending={pending} />
      <Security pages={security} pending={pending} />
      <Appearance pages={visual} complete={complete} pending={pending} />
    </div>
  );
}

function Awaited({ what }: { what: string }) {
  return (
    <p className="measure px-4 py-3.5 text-[12px] leading-relaxed text-read-300">
      {what} Nothing is reported as zero until it has actually been measured.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

function Accessibility({
  pages,
  steps,
  pending,
}: {
  pages: A11yCheckedPayload[];
  steps: A11yStepCheckedPayload[];
  pending: boolean;
}) {
  const score = worstScore(pages);
  const violations = pages.reduce((total, page) => total + page.violations.length, 0);
  const noteworthy = steps.filter((step) => step.findings.some((f) => f.testabilityNote));

  return (
    <Panel>
      <PanelHeader
        title="Accessibility"
        subtitle="axe-core on every page the run visited, plus a separate read of the specific controls the test drove."
        right={pages.length === 0 && pending ? <Pending label="Measuring" /> : null}
      />

      {pages.length === 0 ? (
        pending ? (
          <Awaited what="Pages are audited as the run reaches them." />
        ) : (
          <p className="px-4 py-3.5 text-[12px] text-read-300">No pages were audited.</p>
        )
      ) : (
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Score
              value={score}
              caption="Worst page"
              hint={`Across ${pluralise(pages.length, 'page')}. Not an average — averaging lets one unusable page hide behind four sound ones, and the unusable page decides whether the journey works.`}
            />
            <div className="border-l border-rule pl-3">
              <p className="label-cut">{violations === 1 ? 'Violation' : 'Violations'}</p>
              <p className="mono-figures mt-1 text-[19px] font-semibold leading-none text-read-100">{violations}</p>
            </div>
          </div>

          {/*
            The per-element layer, published by the run rather than reconstructed
            here. This is the argument the product rests on, so it is stated at full
            weight rather than as a footnote under the score.
          */}
          {noteworthy.length > 0 ? (
            <div className="border-l border-signal pl-3">
              <SectionTitle hint={`${noteworthy.length} of the driven controls`}>
                Why this is also a durability finding
              </SectionTitle>
              <ul className="space-y-3">
                {noteworthy.map((step) => (
                  <li key={step.stepId}>
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="mono-figures text-[12px] text-read-100">{step.stepId}</span>
                      <Code className="break-all">{step.locator}</Code>
                    </p>
                    {step.findings
                      .filter((f) => f.testabilityNote)
                      .map((f) => (
                        <div key={f.check} className="mt-1.5">
                          <p className="text-[12px] leading-relaxed text-read-200">{f.message}</p>
                          <p className="measure mt-1 text-[12px] leading-relaxed text-signal-ink">
                            {f.testabilityNote}
                          </p>
                        </div>
                      ))}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pages.map((page) => (
            <PageBlock key={page.pagePath} path={page.pagePath} score={page.score} count={page.violations.length}>
              {page.violations.length === 0 ? (
                <p className="text-[12px] text-read-200">No violations on this page.</p>
              ) : (
                <ul className="space-y-3">
                  {page.violations.map((violation) => (
                    <ViolationRow key={violation.id} violation={violation} />
                  ))}
                </ul>
              )}
            </PageBlock>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ViolationRow({ violation }: { violation: A11yViolation }) {
  return (
    <li className="border-l border-rule pl-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <ImpactChip impact={violation.impact} />
        <Code>{violation.id}</Code>
        <span className="label-cut">{pluralise(violation.nodeCount, 'element')}</span>
      </div>
      <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-200">{violation.help}</p>

      {violation.samples.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {violation.samples.map((sample) => (
            <li key={sample.target}>
              <Code className="break-all">{sample.target}</Code>
            </li>
          ))}
        </ul>
      ) : null}

      <a
        href={violation.helpUrl}
        target="_blank"
        rel="noreferrer"
        className="label-cut mt-1.5 inline-flex items-center gap-1 text-signal transition-colors hover:text-signal-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2 outline-none"
      >
        Rule reference
        <IconExternal size={12} />
      </a>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function Security({ pages, pending }: { pages: SecurityCheckedPayload[]; pending: boolean }) {
  const score = worstScore(pages);
  const findings = pages.reduce((total, page) => total + page.findings.length, 0);

  return (
    <Panel>
      <PanelHeader
        title="Security"
        subtitle="Read passively from responses the run was already making. Nothing is injected and nothing is fuzzed."
        right={pages.length === 0 && pending ? <Pending label="Measuring" /> : null}
      />

      {pages.length === 0 ? (
        pending ? (
          <Awaited what="Each page is read as the run reaches it." />
        ) : (
          <p className="px-4 py-3.5 text-[12px] text-read-300">No pages were read.</p>
        )
      ) : (
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Score
              value={score}
              caption="Worst page"
              hint={`Across ${pluralise(pages.length, 'page')}, weighted by severity. A weighted count, not a conformance measure.`}
            />
            <div className="border-l border-rule pl-3">
              <p className="label-cut">{findings === 1 ? 'Finding' : 'Findings'}</p>
              <p className="mono-figures mt-1 text-[19px] font-semibold leading-none text-read-100">{findings}</p>
            </div>
          </div>

          {pages.map((page) => (
            <PageBlock key={page.pagePath} path={page.pagePath} score={page.score} count={page.findings.length}>
              {page.findings.length === 0 ? (
                <p className="text-[12px] text-read-200">Nothing flagged on this page.</p>
              ) : (
                <ul className="space-y-3">
                  {page.findings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} />
                  ))}
                </ul>
              )}
            </PageBlock>
          ))}
        </div>
      )}
    </Panel>
  );
}

function FindingRow({ finding }: { finding: SecurityFinding }) {
  return (
    <li className="border-l border-rule pl-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <SeverityChip severity={finding.severity} />
        <span className="text-[13px] font-semibold text-read-100">{finding.title}</span>
      </div>
      <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-200">{finding.detail}</p>
      {finding.evidence ? (
        <div className="mt-1.5">
          <Code className="break-all">{finding.evidence}</Code>
        </div>
      ) : null}
      <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-200">
        <span className="label-cut mr-2">Remedy</span>
        {finding.remediation}
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function Appearance({
  pages,
  complete,
  pending,
}: {
  pages: VisualPageView[];
  complete: RunCompletePayload | null;
  pending: boolean;
}) {
  const compared = pages.filter((page) => !page.firstSight);
  const recorded = pages.filter((page) => page.firstSight);

  return (
    <Panel>
      <PanelHeader
        title="Appearance"
        subtitle="Classified by kind at two viewports. A pixel percentage would score a recoloured button and one that moved 50px the same."
        right={pages.length === 0 && pending ? <Pending label="Deferred" /> : null}
      />

      {pages.length === 0 ? (
        pending ? (
          <Awaited what="Verdicts are computed once the walk finishes, so an element a repair replaced is not also reported as missing." />
        ) : (
          <p className="px-4 py-3.5 text-[12px] text-read-300">No pages were compared.</p>
        )
      ) : (
        <div className="space-y-4 px-4 py-4">
          {complete ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Tally label="Compared" value={complete.visual.pagesCompared} />
              <Tally label="Absorbed" value={complete.visual.cosmeticAbsorbed} hint="Restyles that cannot move a box." />
              <Tally
                label="Shifted"
                value={complete.visual.layoutShifts}
                attention={complete.visual.layoutShifts > 0}
                hint={complete.visual.strict ? 'Strict: these fail the run.' : 'Reported; gates only in strict mode.'}
              />
              <Tally
                label="Missing"
                value={complete.visual.missing}
                // Reserved for "the application is at fault", so it is only borrowed
                // here when this finding actually fails the run. Outside strict mode
                // it is reported, not fatal, and colouring it as a fault would claim
                // an outcome the run did not reach.
                fault={complete.visual.missing > 0 && complete.visual.strict}
                attention={complete.visual.missing > 0 && !complete.visual.strict}
                hint={
                  complete.visual.strict
                    ? 'Strict: these fail the run.'
                    : 'Reported and never absorbed; gates only in strict mode.'
                }
              />
            </dl>
          ) : null}

          {recorded.length > 0 ? (
            <p className="measure border-l border-rule pl-3 text-[12px] leading-relaxed text-read-300">
              {pluralise(recorded.length, 'page view')} had no recorded appearance and was recorded rather than
              compared. A first sighting cannot be a regression.
            </p>
          ) : null}

          {compared.map((page) => (
            <AppearanceRow key={page.key} page={page} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function AppearanceRow({ page }: { page: VisualPageView }) {
  const findings = page.findings ?? [];
  const kinds = new Map<string, number>();
  for (const finding of findings) kinds.set(finding.kind, (kinds.get(finding.kind) ?? 0) + 1);

  return (
    <details className="group border-l border-rule pl-3">
      <summary className="flex cursor-pointer list-none flex-col gap-1.5 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2 outline-none">
        <span className="flex items-baseline gap-2">
          <IconDisclose size={12} className="shrink-0 text-read-300 group-open:rotate-90" />
          <span className="mono-figures min-w-0 truncate text-[12px] text-read-100">{page.pagePath}</span>
          <span className="label-cut ml-auto shrink-0">{page.viewport}</span>
        </span>
        {/* Never one count: an absorbed restyle and missing content are different
            events, and summing them destroys the only useful part. */}
        <span className="flex flex-wrap gap-x-3 gap-y-1 pl-[1.375rem]">
          {page.clean ? <span className="label-cut">Unchanged</span> : null}
          {[...kinds].map(([kind, count]) => (
            <span key={kind} className="inline-flex items-baseline gap-1">
              <VisualKindChip kind={kind as keyof typeof VISUAL_KIND_STYLE} />
              <span className="mono-figures text-[12px] text-read-300">{count}</span>
            </span>
          ))}
        </span>
      </summary>

      <div className="mt-2.5 space-y-2.5">
        {findings.length === 0 ? (
          <p className="text-[12px] text-read-300">Nothing recorded for this page view.</p>
        ) : (
          findings.map((finding) => (
            <div key={`${finding.kind}-${finding.key}`} className="border-t border-rule pt-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <VisualKindChip kind={finding.kind} />
                <Code className="break-all">{finding.key}</Code>
              </div>
              <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-200">{finding.summary}</p>
              <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">
                {VISUAL_KIND_STYLE[finding.kind].note}
              </p>
              {finding.movedBy !== null || finding.resizedBy !== null ? (
                <p className="mono-figures mt-1 text-[12px] text-read-200">
                  {finding.movedBy !== null ? `moved ${finding.movedBy}px` : ''}
                  {finding.movedBy !== null && finding.resizedBy !== null ? ' · ' : ''}
                  {finding.resizedBy !== null ? `resized ${finding.resizedBy}px` : ''}
                </p>
              ) : null}
              {finding.changes.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5">
                  {finding.changes.map((change) => (
                    <li key={change.property} className="mono-figures text-[12px] text-read-300">
                      {change.property}: {change.from} → {change.to}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function PageBlock({
  path,
  score,
  count,
  children,
}: {
  path: string;
  score: number;
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="group border-l border-rule pl-3">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2 outline-none">
        <IconDisclose size={12} className="shrink-0 text-read-300 group-open:rotate-90" />
        <span className="mono-figures min-w-0 truncate text-[12px] text-read-100">{path}</span>
        <span className="label-cut ml-auto shrink-0">{count === 0 ? 'clean' : count}</span>
        <span
          className={`mono-figures shrink-0 text-[13px] font-semibold ${
            score >= 90 ? 'text-read-200' : score >= 70 ? 'text-signal' : 'text-alarm-ink'
          }`}
        >
          {String(score).padStart(2, '0')}
        </span>
      </summary>
      <div className="mt-2.5">{children}</div>
    </details>
  );
}

function Tally({
  label,
  value,
  hint,
  attention = false,
  fault = false,
}: {
  label: string;
  value: number;
  hint?: string;
  attention?: boolean;
  fault?: boolean;
}) {
  return (
    <div className="border-l border-rule pl-3">
      <dt className="label-cut">{label}</dt>
      <dd
        className={`mono-figures mt-1 text-[19px] font-semibold leading-none ${
          fault ? 'text-alarm-ink' : attention ? 'text-signal' : 'text-read-100'
        }`}
      >
        {value}
      </dd>
      {hint ? <p className="mt-1.5 text-[12px] leading-snug text-read-300">{hint}</p> : null}
    </div>
  );
}
