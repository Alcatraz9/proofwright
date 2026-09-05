import { useState } from 'react';
import type {
  CoverageGap,
  Mission,
  PageState,
  QualityReport,
  SiteMap,
  IntentStep,
} from '../api/types.ts';
import { api } from '../api/client.ts';
import { ms, when } from '../lib/format.ts';
import { Code, Empty, Panel, SectionTitle, focusRing } from './ui.tsx';
import { IconDisclose } from './icons.tsx';
import { REGISTER_TEXT } from './status.tsx';
import {
  CoverageTrace,
  DECISION_OUTCOME,
  GAP_KIND,
  SCENARIO_KIND,
  SCENARIO_VERDICT,
  STAGES,
  STAGE_LABEL,
  STAGE_NOTE,
  STAGE_STATE,
  ScenarioVerdictChip,
  StageStateMark,
  readStage,
} from './mission.tsx';
import type { StageReading } from './mission.tsx';

/**
 * What hangs beneath the strip.
 *
 * Each exhibit answers one question and states its own provenance, so a reader who
 * arrives at any single one of them can tell what it is claiming and on what basis.
 * None of them derives a value the endpoints do not carry.
 */

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * The transcript, and the default exhibit.
 *
 * The roll's own risk line against this structure was that a strip demotes the
 * decision log to a drill-down. It opens first for that reason: the reasoning is
 * the product's argument for itself, not a tab to be found.
 *
 * A definition list rather than a table. These are not eight columns of
 * comparable figures; they are an ordered account in prose, and the reason is the
 * longest field on every row.
 */
export function DecisionExhibit({ mission, live }: { mission: Mission; live: boolean }) {
  const [outcomeFilter, setOutcomeFilter] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const decision of mission.decisions) {
    counts.set(decision.outcome, (counts.get(decision.outcome) ?? 0) + 1);
  }

  const shown = outcomeFilter
    ? mission.decisions.filter((decision) => decision.outcome === outcomeFilter)
    : mission.decisions;

  const readings = STAGES.map((stage) => readStage(stage, mission.decisions, mission.stage, live));

  if (!mission.decisions.length) {
    return (
      <Empty
        title="Nothing decided yet."
        body="The orchestrator writes a decision at every stage boundary, including the boring ones. The first lands as soon as the crawl finishes."
      />
    );
  }

  return (
    <div className="px-4 py-4">
      <p className="measure text-[13px] leading-relaxed text-read-200">
        Every stage boundary writes one of these, in the order it happened. A stage that says it was
        skipped, or that it escalated rather than decided, is doing the thing that makes the rest of
        the report worth reading.
      </p>

      {/* Filtering by outcome, with the counts visible so the filter is a fact and
          not a guess. A count of zero renders as a disabled control rather than
          vanishing, because an absent filter reads as an absent outcome. */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <span className="label-cut">Outcome</span>
        <button
          type="button"
          onClick={() => setOutcomeFilter(null)}
          aria-pressed={outcomeFilter === null}
          className={`label-cut border px-2 py-1 transition-colors ${focusRing} ${
            outcomeFilter === null
              ? 'border-signal text-signal'
              : 'border-rule text-read-300 hover:border-rule-strong hover:text-read-100'
          }`}
        >
          All {mission.decisions.length}
        </button>
        {(Object.keys(DECISION_OUTCOME) as (keyof typeof DECISION_OUTCOME)[]).map((outcome) => {
          const count = counts.get(outcome) ?? 0;
          const active = outcomeFilter === outcome;
          return (
            <button
              key={outcome}
              type="button"
              disabled={count === 0}
              onClick={() => setOutcomeFilter(active ? null : outcome)}
              aria-pressed={active}
              title={DECISION_OUTCOME[outcome].note}
              className={`label-cut border px-2 py-1 transition-colors disabled:cursor-not-allowed disabled:border-rule disabled:text-read-300/60 ${focusRing} ${
                active
                  ? 'border-signal text-signal'
                  : 'border-rule text-read-300 hover:border-rule-strong hover:text-read-100'
              }`}
            >
              {DECISION_OUTCOME[outcome].label} {count}
            </button>
          );
        })}
      </div>

      <div className="mt-3 border-t border-rule">
        {readings.map((reading) => (
          <StageGroup
            key={reading.stage}
            reading={reading}
            decisions={shown.filter((decision) => decision.stage === reading.stage)}
            filtered={outcomeFilter !== null}
          />
        ))}
      </div>

      {!shown.length ? (
        <p className="border-t border-rule py-6 text-[13px] text-read-300">
          No decision carried that outcome.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One stage, and the decisions filed under it.
 *
 * Two levels of disclosure, which is one more than the flat list this replaced
 * and is the whole reason for the change: a stage is now scannable as a unit —
 * its state and what it cost — before any of its reasoning is on screen.
 *
 * What opens by default is the argument for the structure. A live stage opens
 * because it is the thing being watched. A stage that failed or went round again
 * opens because it is the reason anyone is reading. A stage that simply worked
 * stays shut, since a reader who wants it can say so and one who does not should
 * not have to scroll past it. That is also why the filter forces every matching
 * stage open: having asked to see the escalations, being handed six closed
 * headers would be a worse answer than the flat list gave.
 *
 * State and a conditional rather than <details>, matching ScenarioSteps below:
 * Chromium keeps stale bounding boxes for closed details content, which reads as
 * phantom occluded text to any geometry audit.
 */
function StageGroup({
  reading,
  decisions,
  filtered,
}: {
  reading: StageReading;
  decisions: Mission['decisions'];
  filtered: boolean;
}) {
  const notable = reading.state === 'failed' || reading.state === 'attention';
  const [open, setOpen] = useState(reading.state === 'running' || notable);

  // A stage can become notable while the panel is on screen — the poll brings in
  // a failure two minutes into a run — and a group that stayed shut through that
  // would be hiding the one thing worth seeing.
  const [wasNotable, setWasNotable] = useState(notable);
  if (notable && !wasNotable) {
    setWasNotable(true);
    setOpen(true);
  }

  const expanded = filtered ? decisions.length > 0 : open;
  const empty = reading.state === 'pending';

  return (
    <section className="border-b border-rule last:border-b-0">
      <h3>
        <button
          type="button"
          disabled={empty || (filtered && decisions.length === 0)}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={expanded}
          className={`flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors disabled:cursor-default ${focusRing} ${
            empty ? 'opacity-55' : 'hover:bg-plate-100'
          }`}
        >
          <IconDisclose
            open={expanded}
            size={12}
            className={`shrink-0 text-read-300 ${empty || (filtered && !decisions.length) ? 'invisible' : ''}`}
          />
          <StageStateMark state={reading.state} />
          <span className="readout text-[15px] leading-snug text-read-100">
            {STAGE_LABEL[reading.stage]}
          </span>
          <span className="label-cut ml-auto hidden shrink-0 sm:inline">
            {filtered
              ? `${decisions.length} shown`
              : reading.count
                ? `${reading.count} decision${reading.count === 1 ? '' : 's'}`
                : STAGE_STATE[reading.state].label}
          </span>
          {reading.durationMs !== null ? (
            <span className="mono-figures w-16 shrink-0 text-right text-[12px] text-read-300">
              {ms(reading.durationMs)}
            </span>
          ) : (
            <span className="w-16 shrink-0" />
          )}
        </button>
      </h3>

      {expanded && decisions.length ? (
        <ol className="mb-1 ml-[1.35rem] border-l border-rule">
          {decisions.map((decision, index) => (
            <DecisionRow key={`${decision.at}-${index}`} decision={decision} />
          ))}
        </ol>
      ) : null}

      {expanded && !decisions.length && !empty ? (
        <p className="mb-2 ml-[1.35rem] border-l border-rule py-2 pl-3 text-[13px] text-read-300">
          The stage ran but filed nothing under this filter.
        </p>
      ) : null}

      {/* Stated rather than left blank: an empty stage and an unreached one look
          identical on a strip, and only one of them means anything is wrong. */}
      {empty ? (
        <p className="mb-2 ml-[1.35rem] pl-3 text-[12px] leading-relaxed text-read-300">
          {STAGE_NOTE[reading.stage]}
        </p>
      ) : null}
    </section>
  );
}

/**
 * One decision, disclosed.
 *
 * The action is the header and the reason is the body, which inverts the flat
 * list's emphasis on purpose: scanning six actions to find the one worth reading
 * is the common case, and reading all six reasons is not. The outcome and the
 * timing stay on the closed row, because those are what a reader scans *for*.
 */
function DecisionRow({ decision }: { decision: Mission['decisions'][number] }) {
  const outcome = DECISION_OUTCOME[decision.outcome] ?? DECISION_OUTCOME.failed;
  const [open, setOpen] = useState(false);
  const Mark = outcome.mark;

  return (
    <li className="border-b border-rule/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={`flex w-full items-baseline gap-3 py-2 pl-3 pr-1 text-left transition-colors hover:bg-plate-100 ${focusRing}`}
      >
        <span className={`shrink-0 self-center ${REGISTER_TEXT[outcome.register]}`}>
          <Mark size={13} />
        </span>
        <span className="min-w-0 flex-1 text-[14px] leading-snug text-read-100">
          {decision.action}
        </span>
        {/* Written out for everything except the quiet case. The house rule is that
            no two states are told apart by colour alone, and a mark plus a word
            satisfies it — but spelling out "Ok" on eleven of fifteen rows rebuilds
            the wall of green pills this surface exists to avoid. The rows that are
            not routine say so in words; the routine ones are carried by the mark. */}
        {decision.outcome === 'ok' ? (
          <span className="relative sr-only">{outcome.label}</span>
        ) : (
          <span className={`label-cut shrink-0 ${REGISTER_TEXT[outcome.register]}`}>
            {outcome.label}
          </span>
        )}
        {decision.durationMs !== null ? (
          <span className="mono-figures shrink-0 text-[12px] text-read-300">
            {ms(decision.durationMs)}
          </span>
        ) : null}
        <span className="mono-figures hidden w-[7rem] shrink-0 whitespace-nowrap text-right text-[12px] text-read-300 sm:inline-block">
          {when(decision.at)}
        </span>
      </button>

      {open ? (
        <p className="measure pb-3 pl-3 pr-4 text-[13px] leading-relaxed text-read-300">
          {decision.reason}
        </p>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * The climb, the gaps, and what the gaps are worth.
 *
 * The gap list is grouped by kind rather than listed flat, because one of the
 * kinds is not a work item and grouping is what keeps it from reading as one.
 */
export function CoverageExhibit({
  mission,
  report,
}: {
  mission: Mission;
  report: QualityReport | null;
}) {
  const coverage = report?.coverage ?? null;
  const rounds = mission.coverageRounds;

  if (!rounds.length && !coverage) {
    return (
      <Empty
        title="No coverage reading yet."
        body="Coverage is scored after the first plan exists, then again after each re-plan. It is computed from the map rather than asked of a model, so the same application scores the same twice."
      />
    );
  }

  const byKind = new Map<string, CoverageGap[]>();
  for (const gap of coverage?.gaps ?? []) {
    const list = byKind.get(gap.kind) ?? [];
    list.push(gap);
    byKind.set(gap.kind, list);
  }

  return (
    <div className="space-y-6 px-4 py-4">
      {rounds.length ? (
        <section>
          <SectionTitle hint={`${rounds.length} reading${rounds.length === 1 ? '' : 's'}`}>
            Coverage across re-plan rounds
          </SectionTitle>
          <CoverageTrace rounds={rounds} />
        </section>
      ) : (
        <section>
          <SectionTitle>Coverage across re-plan rounds</SectionTitle>
          <p className="measure text-[13px] leading-relaxed text-read-300">
            No per-round readings were recorded for this mission. The final score below still stands;
            what is missing is the series that produced it.
          </p>
        </section>
      )}

      {coverage ? (
        <>
          <section>
            <SectionTitle hint={coverage.score.toFixed(2)}>Final coverage</SectionTitle>
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              {(
                [
                  ['Pages', coverage.covered.pages.length, coverage.totals.pages],
                  ['Forms', coverage.covered.forms.length, coverage.totals.forms],
                  ['Refusal paths', coverage.covered.negativePaths.length, coverage.totals.negativePaths],
                ] as const
              ).map(([label, covered, total]) => (
                <div key={label} className="border-l border-rule pl-3">
                  <dt className="label-cut">{label}</dt>
                  <dd className="figures mt-1 text-[19px] font-semibold leading-none text-read-100">
                    {covered} <span className="text-read-300">of {total}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="measure mt-3 text-[12px] leading-relaxed text-read-300">{coverage.method}</p>
          </section>

          {coverage.gaps.length ? (
            <section>
              <SectionTitle hint={`${coverage.gaps.length} recorded`}>Gaps, by kind</SectionTitle>
              <div className="space-y-4">
                {[...byKind.entries()].map(([kind, gaps]) => {
                  const style = GAP_KIND[kind as keyof typeof GAP_KIND];
                  return (
                    <div key={kind}>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className={`label-cut ${REGISTER_TEXT[style?.register ?? 'dim']}`}>
                          {style?.label ?? kind}
                        </span>
                        <span className="mono-figures text-[12px] text-read-300">{gaps.length}</span>
                      </div>
                      <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">
                        {style?.note}
                      </p>
                      <ul className="mt-2">
                        {gaps.map((gap, index) => (
                          <li key={`${gap.where}-${index}`} className="border-t border-rule py-2.5">
                            <p className="measure text-[13px] leading-snug text-read-100">
                              {gap.what}
                            </p>
                            <p className="mono-figures mt-1 break-all text-[12px] text-read-300">
                              {gap.where}
                            </p>
                            <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">
                              {gap.why}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {coverage.untestedFlowRisk.length ? (
            <section>
              <SectionTitle hint="Highest first">Untested flows, ranked by risk</SectionTitle>
              <ul>
                {coverage.untestedFlowRisk.map((risk, index) => (
                  <li key={`${risk.flow}-${index}`} className="border-t border-rule py-3">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className="figures text-[17px] font-semibold leading-none text-read-100">
                        {risk.score.toFixed(2)}
                      </span>
                      <span
                        className={`label-cut ${
                          risk.band === 'high'
                            ? 'text-alarm-ink'
                            : risk.band === 'medium'
                              ? 'text-signal'
                              : 'text-read-300'
                        }`}
                      >
                        {risk.band}
                      </span>
                      <span className="mono-figures min-w-0 break-all text-[12px] text-read-300">
                        {risk.flow}
                      </span>
                    </div>
                    {/* The rationale is the arithmetic in words. A score whose
                        derivation cannot be read is a score nobody should act on,
                        so it is never collapsed behind a disclosure. */}
                    <p className="measure mt-1.5 text-[13px] leading-relaxed text-read-200">
                      {risk.rationale}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <section>
          <SectionTitle>Final coverage</SectionTitle>
          <p className="measure text-[13px] leading-relaxed text-read-300">
            {mission.status === 'running' || mission.status === 'queued'
              ? 'The final figure is written with the report, once the mission finishes.'
              : 'This mission produced no report, so there is no final coverage figure.'}
          </p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Site map
// ---------------------------------------------------------------------------

/** One crawled page, with its forms disclosed on demand. */
function PageRow({ page, authWall }: { page: PageState; authWall: boolean }) {
  const [open, setOpen] = useState(false);
  const hasDetail = page.forms.length > 0 || page.destructiveActions.length > 0;

  return (
    <li className="border-t border-rule py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
        <span className="label-cut w-16 shrink-0">Depth {page.depth}</span>
        <span className="readout min-w-0 flex-1 truncate text-[15px] text-read-100">
          {page.title || 'Untitled'}
        </span>
        {authWall ? (
          <span className={`label-cut ${page.behindAuth ? 'text-signal' : 'text-read-300'}`}>
            {page.behindAuth ? 'Signed in' : 'Public'}
          </span>
        ) : null}
        <span className="mono-figures text-[12px] text-read-300">{page.elementCount} elements</span>
      </div>
      <p className="mono-figures mt-1 break-all text-[12px] text-read-300">{page.url}</p>

      {page.destructiveActions.length ? (
        /* Recorded and never operated. Stated in words on the page itself rather
           than only in the crawl's summary sentence, because "we found the delete
           button and left it alone" is a claim worth being able to check. */
        <p className="measure mt-2 border-l border-signal pl-3 text-[12px] leading-relaxed text-read-200">
          <span className="label-cut mr-2 text-signal">Recorded, never operated</span>
          {page.destructiveActions.join(', ')}
        </p>
      ) : null}

      {page.blindSpots > 0 ? (
        <p className="measure mt-2 text-[12px] leading-relaxed text-read-300">
          {page.blindSpots} region{page.blindSpots === 1 ? '' : 's'} this walker cannot see into, so
          anything inside is neither mapped nor counted as absent.
        </p>
      ) : null}

      {hasDetail && page.forms.length ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className={`label-cut mt-2 inline-flex items-center gap-1.5 text-read-200 transition-colors hover:text-signal ${focusRing}`}
          >
            <IconDisclose open={open} size={12} />
            {page.forms.length} form{page.forms.length === 1 ? '' : 's'}
          </button>

          {/* Rendered only when open. A closed <details> keeps full-size bounding
              boxes under content-visibility, which reads to a geometry probe as
              text sitting on top of other text. */}
          {open ? (
            <div className="mt-2 space-y-3 border-l border-rule pl-3">
              {page.forms.map((form) => (
                <div key={form.index}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="label-cut label-cut-bright">
                      {form.isAuth ? 'Sign-in form' : `Form ${form.index + 1}`}
                    </span>
                    {form.submitLabel ? (
                      <span className="text-[12px] text-read-300">
                        submitted by “{form.submitLabel}”
                      </span>
                    ) : (
                      <span className="label-cut text-read-300">No submit control</span>
                    )}
                  </div>
                  <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                    {form.fields.map((field, index) => (
                      <li key={`${field.label}-${index}`} className="text-[12px] text-read-200">
                        {field.label}
                        {field.required ? <span className="text-signal"> required</span> : null}
                        {field.inputType ? (
                          <span className="mono-figures text-read-300"> {field.inputType}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {form.untestableHere.length ? (
                    <ul className="mt-1.5">
                      {form.untestableHere.map((entry, index) => (
                        <li key={index} className="measure text-[12px] leading-relaxed text-read-300">
                          {entry.why}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

export function SiteMapExhibit({ siteMap }: { siteMap: SiteMap | null }) {
  if (!siteMap) {
    return (
      <Empty
        title="No map was kept for this investigation."
        body="The crawler runs first and makes no model calls. Investigations that ran before the map was persisted show nothing here; that is a gap in the record, not an application with no pages."
      />
    );
  }

  return (
    <div className="space-y-6 px-4 py-4">
      <section>
        <SectionTitle hint={`${siteMap.pages.length} reached`}>What the crawl found</SectionTitle>
        <p className="measure text-[13px] leading-relaxed text-read-200">{siteMap.auth.note}</p>
        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
          <div className="border-l border-rule pl-3">
            <dt className="label-cut">Pages visited</dt>
            <dd className="figures mt-1 text-[19px] font-semibold leading-none text-read-100">
              {siteMap.budget.pagesVisited}{' '}
              <span className="text-read-300">of {siteMap.budget.pageLimit} allowed</span>
            </dd>
          </div>
          <div className="border-l border-rule pl-3">
            <dt className="label-cut">Depth limit</dt>
            <dd className="figures mt-1 text-[19px] font-semibold leading-none text-read-100">
              {siteMap.budget.depthLimit}
            </dd>
          </div>
          <div className="border-l border-rule pl-3">
            <dt className="label-cut">Crawl took</dt>
            <dd className="figures mt-1 text-[19px] font-semibold leading-none text-read-100">
              {ms(siteMap.budget.elapsedMs)}
            </dd>
          </div>
        </dl>
        {siteMap.budget.exhausted ? (
          <p className="measure mt-3 text-[12px] leading-relaxed text-read-300">
            The budget ran out before the application did, so the map is a floor on what is there,
            not a census of it.
          </p>
        ) : null}
      </section>

      <section>
        <SectionTitle hint="In the order visited">Pages</SectionTitle>
        <ul>
          {siteMap.pages.map((page) => (
            <PageRow key={page.url} page={page} authWall={siteMap.auth.wallFound} />
          ))}
        </ul>
      </section>

      {siteMap.unvisited.length ? (
        <section>
          <SectionTitle hint={`${siteMap.unvisited.length} left`}>Links not followed</SectionTitle>
          <p className="measure text-[13px] leading-relaxed text-read-300">
            Each says why. A link left alone on purpose — a sign-out that would end the session, a
            control that destroys data — is a decision, not an omission.
          </p>
          <ul className="mt-2">
            {siteMap.unvisited.map((entry, index) => (
              <li key={`${entry.url}-${index}`} className="border-t border-rule py-2.5">
                <p className="mono-figures break-all text-[12px] text-read-200">{entry.url}</p>
                <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">{entry.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export function ScenarioExhibit({ report }: { report: QualityReport | null }) {
  if (!report) {
    return (
      <Empty
        title="No scenarios recorded yet."
        body="An investigation is one-to-many with test cases: the first is the primary journey, and the rest exist because the coverage evaluator found something missing. They are listed once the report is written."
      />
    );
  }

  return (
    <div className="space-y-6 px-4 py-4">
      <section>
        <SectionTitle hint={`${report.scenarios.length} in this investigation`}>Scenarios</SectionTitle>
        <ul>
          {report.scenarios.map((scenario) => {
            const kind = SCENARIO_KIND[scenario.kind];
            const verdict = SCENARIO_VERDICT[scenario.verdict];
            return (
              <li key={scenario.planId} className="border-t border-rule py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
                  <span className="readout min-w-0 flex-1 text-[15px] font-semibold text-read-100">
                    {scenario.name}
                  </span>
                  <ScenarioVerdictChip verdict={scenario.verdict} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="label-cut label-cut-bright">{kind?.label ?? scenario.kind}</span>
                  <span className="mono-figures text-[12px] text-read-300">
                    {scenario.stepsPassed} of {scenario.stepsTotal} steps
                  </span>
                </div>
                <p className="measure mt-1.5 text-[13px] leading-relaxed text-read-200">
                  {scenario.intent}
                </p>
                <p className="measure mt-1 text-[13px] leading-relaxed text-read-300">
                  {scenario.outcome}
                </p>
                {/* The verdict's own meaning, on the row. `No baseline` is the one
                    that must not be read as the application failing, and the note
                    is where that is said rather than implied. */}
                <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">
                  {verdict?.note}
                </p>
                <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">
                  {kind?.note}
                </p>
                {scenario.specFile ? (
                  <p className="mt-2">
                    <Code>{scenario.specFile}</Code>
                  </p>
                ) : null}
                <ScenarioSteps planId={scenario.planId} />
              </li>
            );
          })}
        </ul>
      </section>

      {report.specFiles.length ? (
        <section>
          <SectionTitle hint="On disk, runnable outside this tool">Emitted specifications</SectionTitle>
          <p className="measure text-[13px] leading-relaxed text-read-200">
            Real Playwright files, written from baselines that actually resolved against the live
            application. Credentials stay as environment references; only non-secret test data is
            inlined.
          </p>
          <ul className="mt-2 space-y-1.5">
            {report.specFiles.map((file) => (
              <li key={file}>
                <Code>{file}</Code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.healActions.length ? (
        <section>
          <SectionTitle hint={`${report.healActions.length} in this investigation`}>Repairs</SectionTitle>
          <ul>
            {report.healActions.map((heal, index) => (
              <li key={`${heal.stepId}-${index}`} className="border-t border-rule py-3">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="label-cut label-cut-bright">{heal.stepId}</span>
                  <span className="label-cut text-read-200">{heal.status}</span>
                  {heal.fromCache ? (
                    <span className="label-cut text-read-300" title="An identical earlier answer was reused instead of consulting the model.">
                      Recalled, not reasoned
                    </span>
                  ) : null}
                </div>
                {heal.previousLocator ? (
                  <p className="mt-1.5 text-[12px] text-read-300">
                    was <Code>{heal.previousLocator}</Code>
                  </p>
                ) : null}
                {heal.newLocator ? (
                  <p className="mt-1 text-[12px] text-read-300">
                    now <Code>{heal.newLocator}</Code>
                  </p>
                ) : null}
                {/* Verification is the difference between a repair and a guess, so
                    its absence is stated rather than left blank. */}
                <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-200">
                  {heal.verification ? (
                    heal.verification
                  ) : (
                    <span className="text-signal">
                      Accepted on the model’s word alone. Nothing in the application confirmed it.
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * The score, its parts, and its caveats — which never appear apart.
 *
 * A 0.86 on a suite with no refusal coverage is a different object from a 0.86
 * that tests every refusal, and the caveats are the only thing that distinguishes
 * them. An empty caveat array is therefore rendered as a statement that none were
 * recorded, not as an omitted section: silence would read as "nothing to declare",
 * which is a claim the report has not made.
 */
export function ReportExhibit({
  mission,
  report,
  markdownUrl,
}: {
  mission: Mission;
  report: QualityReport | null;
  markdownUrl: string;
}) {
  if (!report) {
    return (
      <Empty
        title="No report for this investigation."
        body={
          mission.status === 'running' || mission.status === 'queued'
            ? 'The report is synthesised at the last stage, after execution. It is the only place the score, its parts and its caveats appear together.'
            : 'This mission stopped before the report stage, so nothing was synthesised. The decisions record where it stopped and why.'
        }
      />
    );
  }

  const quality = report.quality;

  return (
    <div className="space-y-6 px-4 py-4">
      <section>
        <SectionTitle
          hint={
            <a
              href={markdownUrl}
              className={`label-cut inline-flex items-center gap-1.5 text-signal underline underline-offset-2 hover:text-signal-ink ${focusRing}`}
            >
              Export markdown
            </a>
          }
        >
          Quality
        </SectionTitle>

        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div>
            <p className="figures text-[38px] font-semibold leading-none text-read-100">
              {quality.overall.toFixed(2)}
            </p>
            <p className="label-cut mt-2">Weighted overall</p>
          </div>
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            {quality.parts.map((part) => (
              <div key={part.name} className="border-l border-rule pl-3">
                <dt className="label-cut">
                  {part.name} · weight {part.weight}
                </dt>
                <dd className="figures mt-1 text-[19px] font-semibold leading-none text-read-100">
                  {part.score.toFixed(2)}
                </dd>
                <p className="measure mt-1.5 text-[12px] leading-relaxed text-read-300">{part.note}</p>
              </div>
            ))}
          </dl>
        </div>

        {/* Bound to the number above, in the same section, always drawn. */}
        <div className="mt-4 border-t border-rule pt-3">
          <h4 className="label-cut label-cut-bright">Caveats</h4>
          <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">
            What the figure above does not account for.
          </p>
          {quality.caveats.length ? (
            <ul className="mt-2 space-y-2">
              {quality.caveats.map((caveat, index) => (
                <li
                  key={index}
                  className="measure border-l border-signal pl-3 text-[13px] leading-relaxed text-read-200"
                >
                  {caveat}
                </li>
              ))}
            </ul>
          ) : (
            <p className="measure mt-2 text-[13px] leading-relaxed text-read-300">
              No caveats were recorded for this score. That is the report stating it found nothing to
              qualify — not an omission, and not the same as a score with no caveats because nobody
              looked.
            </p>
          )}
        </div>
      </section>

      <section>
        <SectionTitle>Outcomes</SectionTitle>
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          {(
            [
              ['Scenarios', report.outcomes.scenariosTotal],
              ['Passed', report.outcomes.scenariosPassed],
              ['Failed', report.outcomes.scenariosFailed],
              ['Held for review', report.outcomes.scenariosNeedingReview],
              ['No baseline', report.outcomes.scenariosNotRun],
              ['Steps', `${report.outcomes.stepsPassed} of ${report.outcomes.stepsTotal}`],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="border-l border-rule pl-3">
              <dt className="label-cut">{label}</dt>
              <dd className="figures mt-1 text-[19px] font-semibold leading-none text-read-100">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {report.outcomes.scenariosNotRun > 0 ? (
          <p className="measure mt-3 text-[12px] leading-relaxed text-read-300">
            A scenario with no baseline is neither a pass nor a failure. It means no executable
            baseline was produced, which is a statement about this tool and not a finding about the
            application.
          </p>
        ) : null}
      </section>

      <section>
        <SectionTitle
          hint={report.prd ? `${report.prd.covered} of ${report.prd.testableInBrowser} verified` : 'None supplied'}
        >
          Stated requirements
        </SectionTitle>
        {report.prd ? (
          <>
            <p className="measure text-[13px] leading-relaxed text-read-200">
              A different question from coverage. Coverage asks what the application affords and
              nothing exercises; this asks what the specification promises and nothing checks.
            </p>
            <ul className="mt-2">
              {report.prd.gaps.map((gap) => (
                <li key={gap.id} className="border-t border-rule py-3">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="label-cut label-cut-bright w-10 shrink-0">{gap.id}</span>
                    <span className={`label-cut ${gap.covered ? 'text-read-200' : 'text-signal'}`}>
                      {gap.covered ? 'Verified' : 'Nothing verifies this'}
                    </span>
                    {gap.coveredBy ? (
                      <span className="mono-figures text-[12px] text-read-300">{gap.coveredBy}</span>
                    ) : null}
                  </div>
                  <p className="measure mt-1.5 text-[13px] leading-relaxed text-read-100">
                    {gap.requirement}
                  </p>
                  <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">{gap.basis}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="measure text-[13px] leading-relaxed text-read-300">
            No requirements document was supplied with this mission, so nothing was compared against
            one. This absence never means every requirement is covered.
          </p>
        )}
      </section>

      <section>
        <SectionTitle>Provenance</SectionTitle>
        <dl className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <dt className="label-cut w-24 shrink-0">Synthesised</dt>
            <dd className="mono-figures text-[12px] text-read-200">{when(report.generatedAt)}</dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <dt className="label-cut w-24 shrink-0">Target</dt>
            <dd className="mono-figures min-w-0 break-all text-[12px] text-read-200">
              {report.targetUrl}
            </dd>
          </div>
        </dl>
        <p className="measure mt-3 text-[12px] leading-relaxed text-read-300">{report.coverageNote}</p>
      </section>
    </div>
  );
}

/** Kept beside the exhibits so the stage vocabulary has one definition on screen. */
export function StageLegend() {
  return (
    <Panel className="mt-4">
      <div className="px-4 py-3">
        <p className="label-cut label-cut-bright">Stages</p>
        <dl className="mt-2 space-y-2">
          {(Object.keys(STAGE_LABEL) as (keyof typeof STAGE_LABEL)[]).map((stage) => (
            <div key={stage} className="flex flex-wrap gap-x-3">
              <dt className="w-[8.5rem] shrink-0 text-[13px] font-semibold text-read-100">
                {STAGE_LABEL[stage]}
              </dt>
              <dd className="measure text-[12px] leading-relaxed text-read-300">{STAGE_NOTE[stage]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}


/**
 * The test case opened up: its steps, in the words the plan was written in.
 *
 * The scenario row states what a test is for; this is the "and how" a reader
 * expands into. Steps are fetched on first expand rather than with the report,
 * because an investigation can carry several plans and most readings never open
 * any of them. Rendered with state and a conditional rather than a <details>
 * element: Chromium keeps stale bounding boxes for closed details content,
 * which reads as phantom occluded text to any geometry audit.
 */
function ScenarioSteps({ planId }: { planId: string }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<IntentStep[] | null>(null);
  const [failed, setFailed] = useState(false);

  function toggle(): void {
    const next = !open;
    setOpen(next);
    if (next && steps === null && !failed) {
      api
        .plan(planId)
        .then((detail) => setSteps(detail.plan.plan.steps))
        .catch(() => setFailed(true));
    }
  }

  return (
    <div className="mt-2.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`label-cut text-read-200 transition-colors hover:text-signal ${focusRing}`}
      >
        {open ? 'Hide the steps' : 'Show the steps'}
      </button>

      {open ? (
        failed ? (
          <p className="measure mt-2 text-[12px] leading-relaxed text-read-300">
            The plan behind this test case could not be loaded. It may have been removed
            since the investigation ran.
          </p>
        ) : steps === null ? (
          <p className="mt-2 text-[12px] text-read-300">Reading the plan…</p>
        ) : (
          <ol className="mt-2 space-y-1.5 border-l border-rule pl-3">
            {steps.map((step, index) => (
              <li key={step.id} className="flex items-baseline gap-3">
                <span className="mono-figures shrink-0 text-[12px] text-read-300">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="text-[13px] leading-relaxed text-read-100">{step.intent}</span>
                  {step.expectedOutcome?.description ? (
                    <span className="measure block text-[12px] leading-relaxed text-read-300">
                      then confirm: {step.expectedOutcome.description}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </div>
  );
}
