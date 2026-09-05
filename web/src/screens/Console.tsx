import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError } from '../api/client.ts';
import type { PlanSummary, RunSummary } from '../api/types.ts';
import { useAsync, usePoll } from '../hooks/useAsync.ts';
import { useRunStream } from '../hooks/useRunStream.ts';
import { useVersionNames } from '../hooks/useVersionNames.ts';
import { analysisPending, isRunning } from '../state/runModel.ts';
import { deriveFinding } from '../state/finding.ts';
import { AnalysisColumn } from '../components/AnalysisPanels.tsx';
import { StepChannel } from '../components/StepChannel.tsx';
import { FindingBlock } from '../components/FindingBlock.tsx';
import { Button, Code, ErrorNote, Panel, PanelHeader, Reveal, Spinner, Toggle, focusRing } from '../components/ui.tsx';
import { RunStatusChip } from '../components/status.tsx';
import { IconRetry, IconRun, IconStop } from '../components/icons.tsx';
import { clock, ms, when } from '../lib/format.ts';
import { Link, useRouter } from '../lib/router.tsx';
import type { AppShortcutActions } from '../App.tsx';

/**
 * The console.
 *
 * Reading order is the finding, then the parameter that decided it, then the
 * channel that produced it, then everything else the run corroborated. There is no
 * mirrored viewport of the application under test — it is unstable on a free host
 * and competes with the readout for attention, and what a reader needs of a repair
 * is two still plates, which the channel already carries.
 */
export function Console({ onActions }: { onActions?: (actions: AppShortcutActions) => void }) {
  const { query, setQuery } = useRouter();
  const runId = query.get('run');
  const versionName = useVersionNames();

  const plans = useAsync(() => api.plans(), []);
  const health = useAsync(() => api.health(), []);
  const recent = useAsync(() => api.runs({ limit: 8 }), []);

  const { view, streamState, elapsedMs } = useRunStream(runId);
  const running = isRunning(view);
  const finding = useMemo(() => deriveFinding(view), [view]);

  usePoll(health.reload, 4000, running || (health.data?.queue.pending.length ?? 0) > 0);

  const summary = useAsync(
    () => (runId ? api.run(runId).then((detail) => detail.summary) : Promise.resolve(null)),
    [runId, view.ended],
  );

  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [heal, setHeal] = useState(true);
  const [strictVisual, setStrictVisual] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const runnable = (plans.data ?? []).filter((plan) => plan.status === 'APPROVED' && plan.hasBaseline);
  const planId = selectedPlan ?? runnable[0]?.planId ?? null;

  useEffect(() => {
    if (view.ended) {
      recent.reload();
      plans.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.ended]);

  /**
   * Arriving with no run selected, the readout defaults to the most recent one.
   *
   * The alternative is what this screen used to do: lead with "no run loaded" as the
   * largest thing on the page, above an empty column, and keep the channel and the
   * corroboration — the parts that carry the whole argument — hidden until someone
   * pressed a button. A surface whose job is stating a finding should open on the
   * last finding rather than on its own absence.
   *
   * Once only, and by replacement rather than a push, so it neither fights a reader
   * who navigates away nor buries the console in their back history. A cold instance
   * with no runs still lands on the empty state, which is the honest thing to show
   * when nothing has been replayed.
   */
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || runId) return;
    const latest = recent.data?.[0];
    if (!latest) return;
    defaulted.current = true;
    setQuery({ run: latest.runId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent.data, runId]);

  const start = async (overridePlanId?: string, overrideHeal?: boolean): Promise<void> => {
    const pid = overridePlanId ?? planId;
    if (!pid) return;
    setStarting(true);
    setStartError(null);
    try {
      const started = await api.startRun({ planId: pid, heal: overrideHeal ?? heal, strictVisual });
      setQuery({ run: started.runId });
      recent.reload();
    } catch (err) {
      setStartError((err as ApiError).message);
    } finally {
      setStarting(false);
    }
  };

  // Shortcut actions, handed up to the shell.
  const startRef = useRef(start);
  startRef.current = start;
  const cancelRef = useRef(() => {
    if (runId) void api.cancelRun(runId);
  });
  cancelRef.current = () => {
    if (runId) void api.cancelRun(runId);
  };
  const healRef = useRef(() => setHeal((prev) => !prev));
  healRef.current = () => setHeal((prev) => !prev);

  useEffect(() => {
    if (!onActions) return;
    onActions({
      startRun: () => {
        if (!running && !starting) void startRef.current();
      },
      cancelRun: () => cancelRef.current(),
      toggleHealing: () => healRef.current(),
    });
  }, [onActions, running, starting]);

  // Announce the attribution, not the step count: the verdict is the news.
  const announcedRef = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const next = view.complete
      ? `${finding.verdictWord}. ${finding.headline}`
      : view.started && !view.ended
        ? `Run in progress. ${view.steps.filter((s) => s.status !== null).length} of ${view.totalSteps ?? '?'} steps settled.`
        : view.queued && !view.started
          ? `Queued at position ${view.queued.position}.`
          : '';
    if (next && next !== announcedRef.current) {
      announcedRef.current = next;
      setAnnouncement(next);
    }
  }, [view.complete, view.started, view.ended, view.queued, view.steps, view.totalSteps, finding]);

  const settledSteps = view.steps.filter((s) => s.status !== null).length;

  return (
    <div className="space-y-4">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <FindingBlock
        finding={finding}
        clock={runId ? clock(elapsedMs) : null}
        streamLabel={
          runId ? (streamState === 'open' ? 'streaming' : streamState === 'closed' ? 'complete' : streamState) : null
        }
        action={
          <>
            <Button tone="primary" onClick={() => void start()} disabled={!planId || starting || running}>
              {starting ? <Spinner /> : <IconRun size={13} />}
              {running ? 'Run in flight' : starting ? 'Queueing' : 'Replay'}
            </Button>
            {running && runId ? (
              <Button tone="danger" onClick={() => void api.cancelRun(runId)}>
                <IconStop size={13} />
                Halt
              </Button>
            ) : null}
            {!running && view.ended && summary.data ? (
              <Button
                onClick={() => void start(summary.data!.planId, summary.data!.healingEnabled)}
                disabled={starting}
                title="Replay the same specification with the same settings"
              >
                <IconRetry size={13} />
                Again
              </Button>
            ) : null}
          </>
        }
      >
        {runId ? (
          <RunProvenance
            runId={runId}
            summary={summary.data}
            view={view}
            versionName={versionName}
            settledSteps={settledSteps}
          />
        ) : null}

        <Arming
          plans={plans.data ?? []}
          runnable={runnable}
          selected={planId}
          onSelect={setSelectedPlan}
          heal={heal}
          onHeal={setHeal}
          strictVisual={strictVisual}
          onStrictVisual={setStrictVisual}
          error={startError}
          activeVersion={health.data ? versionName(health.data.activeVersion) : null}
          queued={health.data?.queue.pending.length ?? 0}
        />
      </FindingBlock>

      {runId ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Reveal>
            <Panel className="overflow-hidden">
              <PanelHeader
                title="Channel"
                subtitle="One trace, time-ordered. A repair reads as the channel breaking and rejoining; a stopped run reads as a trace that terminates."
                right={
                  view.totalSteps ? (
                    <span className="mono-figures text-[13px] text-read-200">
                      {settledSteps} / {view.totalSteps}
                    </span>
                  ) : null
                }
              />
              <StepChannel
                steps={view.steps}
                totalSteps={view.totalSteps}
                planId={view.started?.planId ?? summary.data?.planId ?? null}
                onBaselineChanged={plans.reload}
              />
            </Panel>
          </Reveal>

          <Reveal delay={60}>
            <AnalysisColumn
              a11y={view.a11y}
              a11ySteps={view.a11ySteps}
              security={view.security}
              visual={view.visual}
              complete={view.complete}
              pending={analysisPending(view)}
            />
          </Reveal>
        </div>
      ) : (
        <Reveal>
          <PriorRuns
            runs={recent.data ?? []}
            loading={recent.loading}
            versionName={versionName}
            onRerun={(run) => void start(run.planId, run.healingEnabled)}
            rerunDisabled={starting || running}
          />
        </Reveal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

/**
 * What to replay and what the run is permitted to do, with the action that starts
 * it. The action is a solid fill: the previous build shipped it as a 15%-opacity
 * tint that read as disabled, which is the one control on the surface that must
 * never be mistaken for unavailable.
 */
/**
 * What will be replayed, and what the run is permitted to do.
 *
 * A full-width strip under the finding rather than a column beside it. The action
 * that starts a run lives with the finding; this is the state that action operates
 * on, and it reads left to right as a row of settings rather than as a sidebar
 * competing with the readout for the eye.
 */
function Arming({
  plans,
  runnable,
  selected,
  onSelect,
  heal,
  onHeal,
  strictVisual,
  onStrictVisual,
  error,
  activeVersion,
  queued,
}: {
  plans: PlanSummary[];
  runnable: PlanSummary[];
  selected: string | null;
  onSelect: (planId: string) => void;
  heal: boolean;
  onHeal: (next: boolean) => void;
  strictVisual: boolean;
  onStrictVisual: (next: boolean) => void;
  error: string | null;
  activeVersion: string | null;
  queued: number;
}) {
  const blocked = plans.filter((plan) => plan.status !== 'APPROVED' || !plan.hasBaseline);

  return (
    <div className="border-t border-rule">
      <div className="grid gap-x-8 gap-y-5 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-1.5">
            <span className="label-cut">Specification</span>
            <span className="label-cut">
              Against <span className="text-signal">{activeVersion ?? '—'}</span>
            </span>
          </div>

          {runnable.length === 0 ? (
            <p className="measure mt-2 text-[12px] leading-relaxed text-read-300">
              Nothing is armed. A specification needs a recorded baseline and a sign-off before it can be replayed —
              see{' '}
              <Link to="/plans" className="text-signal underline underline-offset-2 hover:text-signal-ink">
                Plans
              </Link>
              .
            </p>
          ) : (
            <div className="mt-2 flex flex-col" role="radiogroup" aria-label="Select a specification to replay">
              {runnable.map((plan) => {
                const active = plan.planId === selected;
                return (
                  <button
                    key={plan.planId}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onSelect(plan.planId)}
                    className={`flex items-baseline justify-between gap-3 border-l-2 py-1.5 pl-3 text-left transition-colors ${focusRing} ${
                      active ? 'border-signal' : 'border-rule hover:border-rule-strong'
                    }`}
                  >
                    <span className={`text-[13px] ${active ? 'font-semibold text-read-100' : 'text-read-200'}`}>
                      {plan.name}
                    </span>
                    <span className="mono-figures shrink-0 text-[12px] text-read-300">{plan.stepCount} steps</span>
                  </button>
                );
              })}
            </div>
          )}

          {blocked.length > 0 ? (
            <p className="measure mt-2 text-[12px] leading-relaxed text-read-300">
              {blocked.length} cannot be replayed: {blocked.map((plan) => plan.name).join(', ')}. A draft needs
              signing off, and one with no baseline has nothing recorded to replay.
            </p>
          ) : null}
        </div>

        <div className="min-w-0">
          <p className="label-cut border-b border-rule pb-1.5">Permitted</p>
          <div className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <Toggle
              checked={heal}
              onChange={onHeal}
              label="Repair stale locators"
              hint="A missing element may be repaired, but only if the replacement satisfies the step’s recorded outcome. Three is the cap."
            />
            <Toggle
              checked={strictVisual}
              onChange={onStrictVisual}
              label="Strict appearance"
              hint="Off, appearance findings are reported without failing the run. On, a layout shift and missing content both fail it."
            />
          </div>

          <p className="measure mt-4 text-[12px] leading-relaxed text-read-300">
            Nine steps plus five pages read at two viewports — thirty to sixty seconds. Concurrency is one, so a
            second run waits{queued > 0 ? `; ${queued} waiting now` : ''}.
          </p>

          {error ? <div className="mt-3">{<ErrorNote>{error}</ErrorNote>}</div> : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** What was replayed, against what, and anything the run reported outside a step. */
function RunProvenance({
  runId,
  summary,
  view,
  versionName,
  settledSteps,
}: {
  runId: string;
  summary: RunSummary | null;
  view: ReturnType<typeof useRunStream>['view'];
  versionName: (id: string | null | undefined) => string;
  settledSteps: number;
}) {
  const queued = view.queued && !view.started;

  return (
    <div className="border-t border-rule">
      <dl className="flex flex-wrap gap-x-8 gap-y-3 px-4 py-3 sm:px-6">
        <div className="border-l border-rule pl-3">
          <dt className="label-cut">Run</dt>
          <dd className="mono-figures mt-1 text-[12px] text-read-100">{runId}</dd>
        </div>
        {summary ? (
          <div className="border-l border-rule pl-3">
            <dt className="label-cut">Recorded verdict</dt>
            <dd className="mt-1">
              <RunStatusChip status={summary.status} />
            </dd>
          </div>
        ) : null}
        <div className="border-l border-rule pl-3">
          <dt className="label-cut">Release</dt>
          <dd className="mono-figures mt-1 text-[12px] text-read-100">
            {view.started?.activeVersion ? versionName(view.started.activeVersion) : '—'}
          </dd>
        </div>
        <div className="border-l border-rule pl-3">
          <dt className="label-cut">Repair permission</dt>
          <dd className="mono-figures mt-1 text-[12px] text-read-100">
            {view.started ? (view.started.healing ? 'Armed' : 'Off') : '—'}
          </dd>
        </div>
        <div className="border-l border-rule pl-3">
          <dt className="label-cut">Steps settled</dt>
          <dd className="mono-figures mt-1 text-[12px] text-read-100">
            {settledSteps} / {view.totalSteps ?? '—'}
          </dd>
        </div>
      </dl>

      {view.started ? (
        <p className="measure px-4 pb-3 text-[12px] leading-relaxed text-read-300 sm:px-6">
          Replaying <Code>{view.started.startUrl}</Code>
          {view.started.rebasedFrom ? (
            <>
              {' '}
              — recorded against <Code>{view.started.rebasedFrom}</Code> and rebased onto the running instance, so
              every recorded path is preserved.
            </>
          ) : null}
        </p>
      ) : null}

      {queued ? (
        <p className="measure border-t border-rule px-4 py-3 text-[12px] leading-relaxed text-signal sm:px-6">
          Queued at position {view.queued?.position}, {view.queued?.ahead} ahead. One run at a time — each drives a
          real browser at two viewports, and a second would take the container with it.
        </p>
      ) : null}

      {view.errors.length > 0 ? (
        <div className="space-y-2 border-t border-rule px-4 py-3 sm:px-6">
          {view.errors.map((error, index) => (
            <p
              key={index}
              className={`measure text-[12px] leading-relaxed ${
                error.fatal === false ? 'text-signal' : 'text-alarm-ink'
              }`}
            >
              <span className="label-cut mr-2">{error.fatal === false ? 'Non-fatal' : 'Fault'}</span>
              {error.message}
            </p>
          ))}
        </div>
      ) : null}

      {view.complete?.runFailure ? (
        <p className="measure border-t border-alarm/40 px-4 py-3 text-[12px] leading-relaxed text-alarm-ink sm:px-6">
          <span className="mono-figures mr-2 font-semibold">{view.complete.runFailure.kind}</span>
          {view.complete.runFailure.message}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prior runs
// ---------------------------------------------------------------------------

function groupByDay(runs: RunSummary[]): { label: string; runs: RunSummary[] }[] {
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const k = key(new Date(run.startedAt));
    const existing = groups.get(k);
    if (existing) existing.push(run);
    else groups.set(k, [run]);
  }

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  return [...groups.entries()].map(([k, entries]) => ({
    label: k === key(today) ? 'Today' : k === key(yesterday) ? 'Yesterday' : k,
    runs: entries,
  }));
}

function PriorRuns({
  runs,
  loading,
  versionName,
  onRerun,
  rerunDisabled,
}: {
  runs: RunSummary[];
  loading: boolean;
  versionName: (id: string | null | undefined) => string;
  onRerun: (run: RunSummary) => void;
  rerunDisabled: boolean;
}) {
  const { setQuery } = useRouter();
  const groups = useMemo(() => groupByDay(runs), [runs]);

  return (
    <Panel>
      <PanelHeader
        title="Prior runs"
        subtitle="Each is read back from its own recorded events, so opening one draws the channel exactly as it drew live."
      />
      {loading ? (
        <div className="px-4 py-6">
          <Spinner />
        </div>
      ) : runs.length === 0 ? (
        <div className="px-4 py-6">
          <p className="readout text-[15px] text-read-100">Nothing has been replayed on this instance yet.</p>
          <p className="measure mt-2 text-[13px] leading-relaxed text-read-300">
            Open an investigation from{' '}
            <Link to="/" className="text-signal underline underline-offset-2 hover:text-signal-ink">
              Investigations
            </Link>{' '}
            and its runs will land here. The filesystem does not survive a restart on this host, so a cold
            instance always starts here.
          </p>
        </div>
      ) : (
        <div>
          {groups.map((group) => (
            <div key={group.label}>
              <p className="label-cut border-b border-rule px-4 pb-1.5 pt-3">{group.label}</p>
              <ul>
                {group.runs.map((run) => (
                  <li key={run.runId} className="group flex items-start gap-x-3 border-b border-rule px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setQuery({ run: run.runId })}
                      className={`flex min-w-0 flex-1 flex-col gap-1.5 text-left ${focusRing}`}
                    >
                      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <RunStatusChip status={run.status} />
                        <span className="text-[13px] font-semibold text-read-100 underline-offset-2 group-hover:underline">
                          {run.planId}
                        </span>
                      </span>
                      <span className="mono-figures flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-read-300">
                        {run.activeVersion ? <span>{versionName(run.activeVersion)}</span> : null}
                        <span>
                          {run.stepsPassed}/{run.stepsTotal} held
                        </span>
                        {run.healCount > 0 ? <span className="text-read-100">{run.healCount} repaired</span> : null}
                        <span>{ms(run.durationMs)}</span>
                        <span>{when(run.startedAt)}</span>
                      </span>
                    </button>

                    {run.status !== 'running' && run.status !== 'queued' ? (
                      <button
                        type="button"
                        onClick={() => onRerun(run)}
                        disabled={rerunDisabled}
                        aria-label={`Replay ${run.planId} with the same settings`}
                        title={`Replay ${run.planId} with the same settings`}
                        className={`label-cut mt-0.5 inline-flex shrink-0 items-center gap-1.5 border border-rule px-2 py-1 text-read-200 transition-colors hover:border-signal hover:text-signal disabled:opacity-50 ${focusRing}`}
                      >
                        <IconRetry size={12} />
                        Again
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
