import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import type { Mission, MissionSummary, QualityReport } from '../api/types.ts';
import { useAsync, usePoll } from '../hooks/useAsync.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { ago, ms, when } from '../lib/format.ts';
import {
  Button,
  ErrorNote,
  Field,
  Panel,
  PanelHeader,
  Spinner,
  focusRing,
  inputClass,
} from '../components/ui.tsx';
import {
  Channel,
  MISSION_STATUS,
  MissionStatusChip,
  NoReading,
  STAGES,
  STAGE_LABEL,
} from '../components/mission.tsx';
import {
  CoverageExhibit,
  DecisionExhibit,
  ReportExhibit,
  ScenarioExhibit,
  SiteMapExhibit,
  StageLegend,
} from '../components/MissionExhibits.tsx';
import { IconRun, IconStop, MarkDone, MarkPending } from '../components/icons.tsx';

/**
 * The mission surface.
 *
 * A band of live channels sits above everything and persists while the body
 * beneath it changes, so "where is this and is it alive" is answered in one place
 * and "what did it decide" in another. The decisions exhibit opens first: the
 * reasoning is this product's argument for itself and is not something a reader
 * should have to go looking for.
 *
 * One tree. The exhibit selector is a rail beside the body on wide viewports and a
 * scrolling row above it on narrow ones — the same buttons, reflowed, never a
 * second copy.
 */

const EXHIBITS = [
  { id: 'decisions', label: 'Decisions' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'sitemap', label: 'Site map' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'report', label: 'Report' },
] as const;

type ExhibitId = (typeof EXHIBITS)[number]['id'];

/**
 * Whether an exhibit has anything in it yet.
 *
 * The rail carries a mark per row, and this is the only per-exhibit status that
 * is actually true. It is tempting to read the run's own pass/fail into these
 * rows the way a CI sidebar does, but four of the five exhibits are readings
 * rather than jobs — a site map does not pass — and a green tick against "Report"
 * would be asserting the report is good rather than that it exists. So the mark
 * says "there is something here", which is what a reader deciding where to click
 * is actually asking.
 */
function exhibitReady(id: ExhibitId, mission: Mission, report: QualityReport | null): boolean {
  switch (id) {
    case 'decisions':
      return mission.decisions.length > 0;
    case 'coverage':
      return mission.coverageRounds.length > 0 || report?.coverage != null;
    case 'sitemap':
      return mission.siteMap != null;
    case 'scenarios':
      return (report?.scenarios.length ?? 0) > 0;
    case 'report':
      return report != null;
  }
}

/** A second hand, so a five-minute stage cannot be mistaken for a stalled one. */
function useTick(active: boolean): number {
  const [, setBeat] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setBeat((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return Date.now();
}

export function Missions() {
  const { query, setQuery } = useRouter();
  const missionId = query.get('m');
  const requested = query.get('x');
  const exhibit: ExhibitId =
    EXHIBITS.some((entry) => entry.id === requested) ? (requested as ExhibitId) : 'decisions';

  const list = useAsync(() => api.missions(30), []);
  const detail = useAsync(
    () => (missionId ? api.mission(missionId) : Promise.resolve(null)),
    [missionId],
  );

  const mission = detail.data;
  const live = mission ? MISSION_STATUS[mission.status]?.live === true : false;

  // The decision list only grows and never revises, so polling is sufficient and
  // there is no stream to reconnect. Stops the moment the mission is finished.
  usePoll(detail.reload, 2500, live);
  usePoll(list.reload, 6000, (list.data ?? []).some((entry) => MISSION_STATUS[entry.status]?.live));

  const reportable =
    mission !== null &&
    (mission.status === 'passed' || mission.status === 'failed' || mission.status === 'needs_review');

  const report = useAsync(
    () => (reportable && missionId ? api.report(missionId) : Promise.resolve(null)),
    [missionId, reportable],
  );

  if (!missionId) {
    return <MissionIndex list={list.data} loading={list.loading} error={list.error} onStarted={(id) => {
      list.reload();
      setQuery({ m: id, x: null }, { replace: false });
    }} />;
  }

  return (
    <div className="space-y-4">
      <MissionReadout
        mission={mission}
        report={report.data}
        loading={detail.loading}
        error={detail.error}
        live={live}
        onCancelled={() => {
          detail.reload();
          list.reload();
        }}
      />

      {mission ? (
        <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
          {/* The rail. A row states whether its exhibit holds anything, so choosing
              where to look does not mean opening five panels to find out. */}
          <nav
            aria-label="Investigation exhibits"
            /* min-w-0 because a grid item defaults to min-width:auto, which lets
               this nav grow to its content and leaves the scroller below nothing
               to clip against — the whole page scrolls sideways instead of the
               rail. */
            className="min-w-0 lg:sticky lg:top-4 lg:self-start"
          >
            <p className="label-cut hidden border-b border-rule pb-2 lg:block">All exhibits</p>
            <div className="flex gap-0 overflow-x-auto lg:mt-1 lg:flex-col lg:overflow-visible">
              {EXHIBITS.map((entry) => {
                const active = entry.id === exhibit;
                const ready = exhibitReady(entry.id, mission, report.data);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setQuery({ x: entry.id })}
                    className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-left transition-colors lg:border-b-0 lg:border-l-2 ${focusRing} ${
                      active
                        ? 'border-signal bg-plate-100 text-read-100'
                        : 'border-transparent text-read-300 hover:border-rule-strong hover:bg-plate-100 hover:text-read-100'
                    }`}
                  >
                    {/* relative: the sr-only label inside is absolutely
                        positioned, and without a positioned ancestor it escapes
                        this row's horizontal scroll clip and widens the page. */}
                    <span className={`relative shrink-0 ${ready ? 'text-pass' : 'text-read-300'}`}>
                      {ready ? <MarkDone size={13} /> : <MarkPending size={13} />}
                      <span className="sr-only">{ready ? 'Has content' : 'Nothing recorded yet'}</span>
                    </span>
                    <span className="label-cut">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="min-w-0">
            <Panel>
              {exhibit === 'decisions' ? <DecisionExhibit mission={mission} live={live} /> : null}
              {exhibit === 'coverage' ? (
                <CoverageExhibit mission={mission} report={report.data} />
              ) : null}
              {exhibit === 'sitemap' ? <SiteMapExhibit siteMap={mission.siteMap} /> : null}
              {exhibit === 'scenarios' ? <ScenarioExhibit report={report.data} /> : null}
              {exhibit === 'report' ? (
                <ReportExhibit
                  mission={mission}
                  report={report.data}
                  markdownUrl={api.reportMarkdownUrl(mission.missionId)}
                />
              ) : null}
            </Panel>
            {exhibit === 'decisions' ? <StageLegend /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The readout: mission line plus the instrument strip
// ---------------------------------------------------------------------------

function MissionReadout({
  mission,
  report,
  loading,
  error,
  live,
  onCancelled,
}: {
  mission: Mission | null;
  report: QualityReport | null;
  loading: boolean;
  error: string | null;
  live: boolean;
  onCancelled: () => void;
}) {
  const now = useTick(live);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  if (error) {
    return (
      <Panel>
        <div className="px-4 py-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </Panel>
    );
  }

  if (!mission) {
    return (
      <Panel>
        <div className="flex items-center gap-3 px-4 py-6">
          {loading ? <Spinner /> : null}
          <p className="text-[13px] text-read-300">
            {loading ? 'Reading the mission.' : 'No mission at that identifier.'}
          </p>
        </div>
      </Panel>
    );
  }

  const status = MISSION_STATUS[mission.status] ?? MISSION_STATUS.error;
  const stageIndex = mission.stage ? STAGES.indexOf(mission.stage) : -1;
  const latest = mission.decisions.length ? mission.decisions[mission.decisions.length - 1] : null;
  const lastRound = mission.coverageRounds.length
    ? mission.coverageRounds[mission.coverageRounds.length - 1]
    : null;
  const finalCoverage = report?.coverage ?? null;

  const notable: string[] = [];
  for (const outcome of ['escalated', 'retried', 'skipped', 'failed'] as const) {
    const count = mission.decisions.filter((decision) => decision.outcome === outcome).length;
    if (count) notable.push(`${count} ${outcome}`);
  }

  const started = Date.parse(mission.createdAt);
  const ended = mission.finishedAt ? Date.parse(mission.finishedAt) : now;
  const elapsed = Number.isNaN(started) ? null : Math.max(0, ended - started);

  return (
    <Panel>
      {/* The mission line: what was tested, and what the whole thing concluded,
          before any figure. */}
      <PanelHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span>{status.label}</span>
            <span className="mono-figures text-[13px] font-normal text-read-300">
              {mission.missionId}
            </span>
          </span>
        }
        subtitle={status.note}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/missions"
              className={`label-cut border border-rule px-2 py-1 text-read-200 transition-colors hover:border-signal hover:text-signal ${focusRing}`}
            >
              All missions
            </Link>
            {mission.runId ? (
              <Link
                to={`/?run=${encodeURIComponent(mission.runId)}`}
                title="Watch the step-by-step replay on the console"
                className={`label-cut border border-rule px-2 py-1 text-read-200 transition-colors hover:border-signal hover:text-signal ${focusRing}`}
              >
                Open the run
              </Link>
            ) : null}
            {live ? (
              <Button
                tone="danger"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  setCancelError(null);
                  api
                    .cancelMission(mission.missionId)
                    .then(onCancelled)
                    .catch((err: unknown) =>
                      setCancelError(err instanceof Error ? err.message : String(err)),
                    )
                    .finally(() => setCancelling(false));
                }}
              >
                <IconStop size={13} />
                {cancelling ? 'Halting' : 'Halt'}
              </Button>
            ) : null}
          </div>
        }
      />

      <p className="mono-figures break-all border-b border-rule px-4 py-2.5 text-[13px] text-read-200">
        {mission.targetUrl}
      </p>

      {/* The strip. Ruled channels of equal weight, no fill and no boxes: a
          channel with no reading says so rather than showing a zero, because zero
          is a measurement and "not yet" is not one. */}
      <div className="flex flex-wrap border-b border-rule px-4 py-2 sm:flex-nowrap">
        <Channel
          label="Stage"
          live={live}
          register={live ? 'attention' : 'stated'}
          value={
            mission.stage ? (
              <>
                {STAGE_LABEL[mission.stage]}{' '}
                <span className="text-read-300">
                  {stageIndex >= 0 ? `${stageIndex + 1} of ${STAGES.length}` : ''}
                </span>
              </>
            ) : (
              <NoReading label="Not started" />
            )
          }
          note={mission.mode === 'autonomous' ? 'No human between stages' : 'Supervised'}
        />
        <Channel
          label="Elapsed"
          value={elapsed === null ? <NoReading /> : ms(elapsed)}
          note={mission.finishedAt ? `Finished ${ago(mission.finishedAt)}` : 'Running'}
        />
        <Channel
          label="Coverage"
          register={lastRound || finalCoverage ? 'stated' : 'dim'}
          value={
            lastRound ? (
              <>
                {lastRound.score.toFixed(2)}{' '}
                <span className="text-read-300">reading {lastRound.round}</span>
              </>
            ) : finalCoverage ? (
              <>
                {finalCoverage.score.toFixed(2)} <span className="text-read-300">final</span>
              </>
            ) : (
              <NoReading label="Not scored" />
            )
          }
          note={
            lastRound
              ? `${lastRound.refusalCovered} of ${lastRound.refusalTotal} refusal paths`
              : finalCoverage
                ? `${finalCoverage.covered.negativePaths.length} of ${finalCoverage.totals.negativePaths} refusal paths`
                : 'Scored after the first plan'
          }
        />
        <Channel
          label="Decisions"
          value={mission.decisions.length}
          note={
            /* The count alone answers nothing. What a reader wants from this
               channel is whether anything was escalated or retried, which is the
               difference between a pipeline that ran and one that judged. */
            notable.length ? notable.join(' · ') : 'All routine'
          }
        />
      </div>

      {/* The newest decision, carried in the readout while the mission works.
          The structure's own risk was that a strip turns the reasoning into a
          drill-down; this is where that is answered. */}
      {live && latest ? (
        <div className="border-b border-rule px-4 py-2.5">
          <p className="label-cut flex items-center gap-1.5">
            <span className="channel-live inline-block h-2 w-px bg-signal" aria-hidden />
            Most recent decision
          </p>
          <p className="readout mt-1 text-[15px] leading-snug text-read-100">{latest.action}</p>
          <p className="measure mt-1 text-[13px] leading-relaxed text-read-300">{latest.reason}</p>
        </div>
      ) : null}

      {mission.instruction ? (
        <div className="border-b border-rule px-4 py-2.5">
          <p className="label-cut">Stated intent</p>
          <p className="measure mt-1 text-[13px] leading-relaxed text-read-200">
            {mission.instruction}
          </p>
        </div>
      ) : null}

      {mission.error ? (
        <div className="px-4 py-3">
          <ErrorNote>{mission.error}</ErrorNote>
        </div>
      ) : null}

      {cancelError ? (
        <div className="px-4 py-3">
          <ErrorNote>{cancelError}</ErrorNote>
        </div>
      ) : null}

      <p className="px-4 py-2.5 text-[12px] leading-relaxed text-read-300">
        Opened {when(mission.createdAt)}
        {mission.finishedAt ? `, finished ${when(mission.finishedAt)}` : ''}.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

function MissionIndex({
  list,
  loading,
  error,
  onStarted,
}: {
  list: MissionSummary[] | null;
  loading: boolean;
  error: string | null;
  onStarted: (missionId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <StartMission onStarted={onStarted} />

      <Panel>
        <PanelHeader
          title="Investigations"
          subtitle="Newest first. One URL is the whole minimum; everything else the orchestrator works out for itself."
          right={
            list ? (
              <span className="mono-figures text-[13px] text-read-300">{list.length}</span>
            ) : null
          }
        />
        {error ? (
          <div className="px-4 py-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : loading && !list ? (
          <div className="flex items-center gap-3 px-4 py-6">
            <Spinner />
            <p className="text-[13px] text-read-300">Reading the investigation index.</p>
          </div>
        ) : !list?.length ? (
          <div className="px-4 py-10">
            <p className="readout text-[15px] text-read-100">Nothing has been investigated yet.</p>
            <p className="measure mt-2 text-[13px] leading-relaxed text-read-300">
              Give the form above a URL. The orchestrator crawls the application, writes a
              specification, scores its own coverage, re-plans for what it is missing, then records,
              executes and reports — and writes down what it decided at every boundary.
            </p>
          </div>
        ) : (
          <ul>
            {list.map((entry) => (
              <li key={entry.missionId} className="border-t border-rule first:border-t-0">
                <Link
                  to={`/missions?m=${encodeURIComponent(entry.missionId)}`}
                  className={`block px-4 py-3.5 transition-colors hover:bg-plate-200/40 ${focusRing}`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
                    <MissionStatusChip status={entry.status} />
                    <span className="mono-figures min-w-0 flex-1 truncate text-[13px] text-read-200">
                      {entry.targetUrl}
                    </span>
                    <span className="mono-figures text-[12px] text-read-300">
                      {ago(entry.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                    <span className="label-cut">
                      {entry.stage ? STAGE_LABEL[entry.stage] : 'Not started'}
                    </span>
                    <span className="text-[12px] text-read-300">
                      {entry.decisionCount} decision{entry.decisionCount === 1 ? '' : 's'}
                    </span>
                    {entry.pageCount > 0 ? (
                      <span className="text-[12px] text-read-300">
                        {entry.pageCount} page{entry.pageCount === 1 ? '' : 's'} mapped
                      </span>
                    ) : null}
                    {entry.coverageRounds.length ? (
                      <span className="text-[12px] text-read-300">
                        coverage{' '}
                        <span className="figures text-read-200">
                          {entry.coverageRounds[entry.coverageRounds.length - 1]?.score.toFixed(2)}
                        </span>
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

function StartMission({ onStarted }: { onStarted: (missionId: string) => void }) {
  const [targetUrl, setTargetUrl] = useState('');
  const [instruction, setInstruction] = useState('');
  const [prd, setPrd] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [supervised, setSupervised] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = useMemo(() => {
    if (!targetUrl.trim()) return false;
    try {
      const parsed = new URL(targetUrl.trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, [targetUrl]);

  function submit(): void {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    api
      .startMission({
        targetUrl: targetUrl.trim(),
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(prd.trim() ? { prd: prd.trim() } : {}),
        ...(supervised ? { mode: 'supervised' as const } : {}),
        ...(email.trim() && password
          ? { credentials: { TEST_EMAIL: email.trim(), TEST_PASSWORD: password } }
          : {}),
      })
      .then((started) => onStarted(started.missionId))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  return (
    <Panel>
      <PanelHeader
        title="Open an investigation"
        subtitle="Point it at a running application. A URL is the whole minimum; anything else you supply narrows the scope rather than enabling it."
      />
      <form
        className="space-y-4 px-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Target URL"
          hint="Where the crawl starts. It stays on this origin and never operates a control that destroys data."
        >
          <input
            className={inputClass}
            type="url"
            inputMode="url"
            placeholder="http://127.0.0.1:7872/app/"
            value={targetUrl}
            onChange={(event) => setTargetUrl(event.target.value)}
          />
        </Field>

        {/*
          On the main form, not in the disclosure. These were hidden behind a tab
          switch plus an expand and were never found in practice — and a login is
          not an optional nicety anymore: the exploration signs in with it,
          verifies it works, and the planner builds authenticated flows and
          wrong-credential contrasts around that verdict.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Test account"
            hint="If sign-in is needed, the exploration verifies these against the real form. Only field names are echoed back; values are held in memory and never stored."
          >
            <input
              className={inputClass}
              type="text"
              inputMode="email"
              autoComplete="off"
              placeholder="user@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Test password">
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className={`label-cut text-read-200 transition-colors hover:text-signal ${focusRing}`}
        >
          {open ? 'Fewer inputs' : 'Narrow the scope'}
        </button>

        {open ? (
          <div className="space-y-4 border-l border-rule pl-3">
            <Field
              label="Stated intent"
              hint="What to test, in plain English. With none, scope comes from the pages the crawl actually found."
            >
              <textarea
                className={`${inputClass} min-h-[4.5rem]`}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
              />
            </Field>

            <Field
              label="Requirements"
              hint="Pasted requirements are read once and compared against the plans afterwards, which is a different question from what the application affords."
            >
              <textarea
                className={`${inputClass} min-h-[4.5rem]`}
                value={prd}
                onChange={(event) => setPrd(event.target.value)}
              />
            </Field>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={supervised}
                onChange={(event) => setSupervised(event.target.checked)}
                className={`mt-0.5 h-4 w-4 shrink-0 accent-signal ${focusRing}`}
              />
              <span className="min-w-0">
                <span className="text-[13px] font-medium text-read-100">Hold for approval</span>
                <span className="measure mt-1 block text-[12px] leading-relaxed text-read-300">
                  The investigation stops after planning and waits for a person. The gate does not
                  disappear in autonomous mode — it changes hands, and the log says whose.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button tone="primary" type="submit" disabled={!valid || busy}>
            {busy ? <Spinner /> : <IconRun size={13} />}
            {busy ? 'Investigating' : 'Investigate'}
          </Button>
          <p className="measure text-[12px] leading-relaxed text-read-300">
            Several minutes is normal. The free tier allows roughly three locator resolutions a
            minute, and quiet stretches are the model working rather than the run stalling.
          </p>
        </div>
      </form>
    </Panel>
  );
}
