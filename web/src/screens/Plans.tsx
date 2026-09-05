import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import type { BaselineView, IntentPlan, PlanSummary, RunSummary } from '../api/types.ts';
import { useAsync, usePoll } from '../hooks/useAsync.ts';
import {
  Button,
  Code,
  Empty,
  ErrorNote,
  focusRing,
  Panel,
  PanelHeader,
  Reveal,
  Spinner,
  Toggle,
} from '../components/ui.tsx';
import { Chip, PlanStatusChip, RunStatusChip } from '../components/status.tsx';
import { IconStop } from '../components/icons.tsx';
import { StepChannel } from '../components/StepChannel.tsx';
import { foldEvents } from '../state/runModel.ts';
import { ago, when } from '../lib/format.ts';
import { parseLocator, STRATEGY_NOTE } from '../lib/locator.ts';
import { Link, useRouter } from '../lib/router.tsx';

/**
 * Plans, and the gate.
 *
 * A draft cannot run. The server returns 409 for it, and the interface refuses it
 * too, because a gate one interface can walk around is not a gate.
 *
 * Read-only, by removal. The step editor and the un-approve control were both here
 * and are both gone: a plan is what the pipeline generated and a person signed off,
 * and the two ways to quietly change that out from under the signature were the
 * editor and the return-to-draft button. What remains is the sign-off, the recorded
 * baseline, and the ability to run it.
 */

export function Plans() {
  const { path } = useRouter();
  const planId = path.startsWith('/plans/') ? decodeURIComponent(path.slice('/plans/'.length)) : null;
  return planId ? <PlanDetail planId={planId} /> : <PlanList />;
}

function PlanList() {
  const plans = useAsync(() => api.plans(), []);

  return (
    <Reveal>
      <Panel>
        <PanelHeader
          title="Test plans"
          subtitle="A plan is the reviewed description of what the test does. The baseline is what was recorded from it, and the approval is the human step between the two."
        />

        {plans.loading && !plans.data ? (
          <div className="px-4 py-8">
            <Spinner />
          </div>
        ) : plans.error ? (
          <div className="px-4 py-4">
            <ErrorNote>{plans.error}</ErrorNote>
          </div>
        ) : (plans.data ?? []).length === 0 ? (
          <Empty
            title="No plans"
            body="A fresh database seeds itself from the committed fixture plan, so this should not normally be empty."
          />
        ) : (
          <ul>
            {(plans.data ?? []).map((plan) => (
              <PlanRow key={plan.planId} plan={plan} />
            ))}
          </ul>
        )}
      </Panel>
    </Reveal>
  );
}

/**
 * One specification in the index.
 *
 * The four facts about a specification are separate facts and are set as separate
 * labelled fields: whether it is signed off, whether a baseline exists, how its last
 * replay ended, and how big it is. They previously ran together on one wrapping line
 * — "Signed off  Baseline recorded — Pass  7 steps" — which reads as one phrase and
 * left the right two thirds of the row empty.
 *
 * Each field carries its own label rather than relying on a header row, so the same
 * markup reflows from a row to a stack without a second tree and without a header
 * that can drift out of step with the cells under it.
 */
function PlanRow({ plan }: { plan: PlanSummary }) {
  const runnable = plan.status === 'APPROVED' && plan.hasBaseline;
  return (
    <li className="border-b border-rule last:border-b-0">
      <Link
        to={`/plans/${encodeURIComponent(plan.planId)}`}
        className={`block px-4 py-4 transition-colors hover:bg-plate-200/40 ${focusRing}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
          <div className="min-w-0 flex-1 basis-72">
            <p className="text-[14px] font-semibold text-read-100">{plan.name}</p>
            <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">{plan.description}</p>
            <p className="mono-figures mt-1.5 text-[12px] text-read-300">{plan.planId}</p>
          </div>

          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Field2 label="Sign-off">
              <PlanStatusChip status={plan.status} />
            </Field2>
            <Field2 label="Baseline">
              <span className={`label-cut ${plan.hasBaseline ? 'text-read-100' : 'text-signal'}`}>
                {plan.hasBaseline ? 'Recorded' : 'None recorded'}
              </span>
            </Field2>
            <Field2 label="Last replay">
              {plan.lastRunStatus ? (
                <RunStatusChip status={plan.lastRunStatus} />
              ) : (
                <span className="label-cut">Never</span>
              )}
            </Field2>
            <Field2 label="Steps">
              <span className="mono-figures text-[13px] text-read-100">{plan.stepCount}</span>
            </Field2>
            <Field2 label="Updated">
              <span className="mono-figures text-[13px] text-read-100">{ago(plan.updatedAt)}</span>
            </Field2>
            <Field2 label="Replayable">
              <span className={`label-cut ${runnable ? 'text-read-100' : 'text-signal'}`}>
                {runnable ? 'Yes' : 'Not yet'}
              </span>
            </Field2>
          </dl>
        </div>
      </Link>
    </li>
  );
}

/** A labelled field in a record row. Named to avoid colliding with the form Field. */
function Field2({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-[6.5rem] border-l border-rule pl-3">
      <dt className="label-cut">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation gate
// ---------------------------------------------------------------------------

/**
 * Surfaced before sign-off: steps the specification does not say an outcome for.
 *
 * Worded carefully. A step with no stated outcome here may still have recorded
 * assertions in the baseline — the recorded baseline lower down this same screen
 * shows exactly that — so this cannot claim the step is unable to catch a
 * regression. What it can say is that the specification does not state what should
 * be true afterwards, which is what a reviewer is being asked to sign off on, and
 * that a repair on such a step has nothing of the specification's own to be checked
 * against.
 */
function approvalWarnings(plan: IntentPlan): string[] {
  const warnings: string[] = [];
  plan.steps.forEach((step, i) => {
    if (!step.expectedOutcome?.description) {
      warnings.push(
        `Step ${i + 1} (${step.id}) states no expected outcome. Any repair on it would rest on judgement rather than on the specification.`,
      );
    }
  });
  return warnings;
}

/**
 * Inline confirm/cancel that replaces the trigger button. Shows a pre-approval
 * summary (step count, last edit, warnings) so the reviewer sees what they are
 * approving.
 */
function ConfirmGate({
  plan,
  updatedAt,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: IntentPlan;
  updatedAt: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const warnings = approvalWarnings(plan);

  return (
    <div
      role="alertdialog"
      aria-label="Confirm plan approval"
      className="rounded-plate border border-rule bg-plate-200 px-4 py-3 space-y-2.5"
    >
      <p className="text-[13px] font-semibold text-read-100">Approve this plan?</p>

      <dl className="text-[12px] text-read-200 space-y-1">
        <div className="flex gap-2">
          <dt className="label-cut">Steps</dt>
          <dd className="mono-figures">{plan.steps.length}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="label-cut">Last edited</dt>
          <dd className="mono-figures">{when(updatedAt)}</dd>
        </div>
      </dl>

      {warnings.length > 0 ? (
        <div
          role="alert"
          className="rounded-plate border border-signal/40 bg-plate-000 px-3 py-2 space-y-1"
        >
          <p className="label-cut text-signal">
            {warnings.length === 1 ? '1 step states no outcome' : `${warnings.length} steps state no outcome`}
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            {warnings.map((w) => (
              <li key={w} className="measure text-[12px] leading-relaxed text-signal/80">{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex gap-2 pt-1">
        <Button tone="primary" onClick={onConfirm} disabled={busy}>
          {busy ? <Spinner /> : null}
          Yes, approve
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan detail
// ---------------------------------------------------------------------------

function PlanDetail({ planId }: { planId: string }) {
  const detail = useAsync(() => api.plan(planId), [planId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  /**
   * Which run is on screen, and which one this page is still waiting on.
   *
   * Two pieces of state rather than one, because they answer different questions.
   * `openRunId` is what the reader chose to look at — a run they started, or one
   * they picked out of the list, finished or not. `activeRunId` is only ever a run
   * this page launched and that has not ended, and it exists to keep the launch
   * button honest: opening a finished run from three days ago must not make the
   * button claim the runner is busy.
   */
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const record = detail.data?.plan ?? null;
  const baseline = detail.data?.baseline ?? null;
  const runs = detail.data?.runs ?? [];

  /**
   * Keep the run list current while any of them is still going.
   *
   * Slower than the open run's own poll, because this is the index rather than
   * the instrument: it exists so a run started somewhere else — another tab, the
   * CLI — appears here and can be opened, and so a row's step count is not frozen
   * at whatever it was when the page loaded. It stops as soon as nothing is live.
   */
  const anyLive = runs.some((run) => run.status === 'queued' || run.status === 'running');
  usePoll(detail.reload, 4000, anyLive);

  const approve = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.approve(planId);
      setConfirming(false);
      detail.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (detail.loading && !detail.data) {
    return (
      <div className="px-4 py-8">
        <Spinner />
      </div>
    );
  }
  if (detail.error || !record) {
    return (
      <Panel className="px-4 py-4">
        <ErrorNote>{detail.error ?? `No plan "${planId}".`}</ErrorNote>
      </Panel>
    );
  }

  const runnable = record.status === 'APPROVED' && baseline !== null;

  return (
    <div className="space-y-4">
      <Reveal>
        <Panel>
          <PanelHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                {record.plan.name}
                <PlanStatusChip status={record.status} />
              </span>
            }
            subtitle={record.plan.description}
            right={
              <Link to="/plans" className={`label-cut text-signal hover:text-signal-ink ${focusRing}`}>
                All plans
              </Link>
            }
          />

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 text-[13px] sm:grid-cols-4">
            <Meta label="Plan id" value={<Code>{record.planId}</Code>} />
            <Meta label="Start URL" value={<Code className="break-all">{record.plan.startUrl}</Code>} />
            <Meta label="Generated by" value={record.model} />
            <Meta
              label="Approved"
              value={record.approvedAt ? when(record.approvedAt) : 'Not approved'}
            />
          </dl>

          {record.plan.requiredValueRefs.length > 0 ? (
            <p className="measure border-t border-rule px-4 py-3 text-[13px] leading-relaxed text-read-300">
              Needs{' '}
              {record.plan.requiredValueRefs.map((ref, index) => (
                <span key={ref}>
                  {index > 0 ? ', ' : ''}
                  <Code>{ref}</Code>
                </span>
              ))}{' '}
              from the environment at execution time. A stored plan holds the name, never the value.
            </p>
          ) : null}

          {error ? (
            <div className="px-4 pb-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}

          <footer className="border-t border-rule px-4 py-3.5 space-y-3">
            {confirming ? (
              <ConfirmGate
                plan={record.plan}
                updatedAt={record.updatedAt}
                busy={busy}
                onConfirm={() => void approve()}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                {record.status === 'APPROVED' ? null : (
                  <Button
                    tone="primary"
                    onClick={() => setConfirming(true)}
                    disabled={busy || record.plan.steps.length === 0}
                  >
                    Approve this plan
                  </Button>
                )}

                {runnable ? (
                  <RunLauncher
                    planId={planId}
                    inFlight={activeRunId !== null}
                    onStarted={(id) => {
                      setActiveRunId(id);
                      setOpenRunId(id);
                    }}
                  />
                ) : (
                  <span className="text-[12px] text-read-300">
                    {baseline === null
                      ? 'No baseline is recorded, so there is nothing to replay yet.'
                      : 'A draft cannot be run. Approve it first.'}
                  </span>
                )}
              </div>
            )}
          </footer>
        </Panel>
      </Reveal>

      {openRunId !== null ? (
        <LiveRun
          key={openRunId}
          runId={openRunId}
          planId={planId}
          onEnded={() => {
            setActiveRunId((current) => (current === openRunId ? null : current));
            detail.reload();
          }}
          onBaselineChanged={detail.reload}
          onDismiss={() => setOpenRunId(null)}
        />
      ) : null}

      {baseline ? (
        <Reveal delay={100}>
          <BaselinePanel baseline={baseline} />
        </Reveal>
      ) : null}

      {runs.length > 0 ? (
        <Reveal delay={140}>
          <PlanRuns runs={runs} openRunId={openRunId} onOpen={setOpenRunId} />
        </Reveal>
      ) : null}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="label-cut">{label}</dt>
      <dd className="mt-1 break-words text-[13px] text-read-200">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor — with progressive disclosure
// ---------------------------------------------------------------------------

/**
 * Starts a replay and keeps it on screen while it happens.
 *
 * "Run it" used to be a link to the front door, which started nothing — the run
 * lived on a separate console screen that no longer exists. It now posts the run
 * and holds it here, on the plan that owns it, because the question a reader has
 * after pressing it is about this plan and answering it elsewhere means finding
 * the way back.
 *
 * Polled rather than streamed, matching how an investigation follows its own
 * stages. The server does offer an event stream, and a stream is the better
 * instrument for a long run — but a replay is seconds to a couple of minutes, a
 * poll cannot get stuck half-open, and re-reading the whole event log each time
 * means a reconnect needs no resume logic. `foldEvents` is the same reducer the
 * recorded view uses, so a run in flight and a run read back from the store draw
 * from one code path and cannot disagree.
 *
 * Healing is deliberately not offered here. The endpoint defaults it off, so this
 * is a plain replay: the specification against the baseline, and what happened.
 */
function RunLauncher({
  planId,
  inFlight,
  onStarted,
}: {
  planId: string;
  inFlight: boolean;
  onStarted: (runId: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [everRan, setEverRan] = useState(false);
  const [heal, setHeal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const started = await api.startRun({ planId, heal });
      setEverRan(true);
      onStarted(started.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Button tone="primary" onClick={() => void start()} disabled={starting || inFlight}>
        {starting || inFlight ? <Spinner /> : null}
        {inFlight ? 'Running' : everRan ? 'Run it again' : 'Run it'}
      </Button>

      {/*
        Armed before the run and locked once it starts, because the server is told
        once, at the point the run is queued. A control that kept moving while the
        run was in flight would be describing a decision that had already been made.

        The hint states the limit rather than the feature. A repair only happens on
        a failure the runner has already classified as the test's fault — a locator
        that no longer resolves, with no recorded fallback that still does. A step
        that found its element and got the wrong answer is the application, and is
        escalated untouched; that separation is the product, and an arming control
        that implied "fixes failures" would be claiming the opposite.
      */}
      <Toggle
        checked={heal}
        onChange={setHeal}
        disabled={inFlight || starting}
        label="Auto heal"
        hint="Repairs a step whose locator no longer resolves. A step that resolved and then failed its outcome is the application's, and is reported rather than repaired."
      />

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </>
  );
}

/**
 * One run, redrawn as it reports.
 *
 * Serves a run this page just launched and a run picked out of the list below
 * identically, which is the point: a run in flight is not a different kind of
 * thing from a finished one, it is the same record with fewer events in it so far.
 * A run that has already ended simply folds to its final state on the first poll
 * and stops.
 *
 * Polled rather than streamed, matching how an investigation follows its own
 * stages. The server does offer an event stream, and a stream is the better
 * instrument for a long run — but a replay is seconds to a couple of minutes, a
 * poll cannot get stuck half-open, and re-reading the whole event log each time
 * means a reconnect needs no resume logic. `foldEvents` is the same reducer the
 * recorded view uses, so a run in flight and a run read back from the store draw
 * from one code path and cannot disagree.
 *
 * `onEnded` fires once. Without the latch, every poll of a finished run would
 * refetch the plan for as long as the panel stayed open.
 */
function LiveRun({
  runId,
  planId,
  onEnded,
  onBaselineChanged,
  onDismiss,
}: {
  runId: string;
  planId: string;
  onEnded: () => void;
  onBaselineChanged: () => void;
  onDismiss: () => void;
}) {
  const detail = useAsync(() => api.run(runId), [runId]);
  const notified = useRef(false);
  const [halting, setHalting] = useState(false);
  const [haltError, setHaltError] = useState<string | null>(null);

  const view = useMemo(() => foldEvents(detail.data?.events ?? []), [detail.data?.events]);
  const live = detail.data !== null && !view.ended;

  usePoll(detail.reload, 1200, live);

  useEffect(() => {
    if (view.ended && !notified.current) {
      notified.current = true;
      onEnded();
    }
  }, [view.ended, onEnded]);

  const queued = view.queued !== null && view.started === null;
  const heading = view.ended ? 'Run finished' : queued ? 'Queued' : 'Running';

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span>{heading}</span>
            {/* A run id is plan id + ISO timestamp — long, and mono, so it will
                not break on its own. Left unbroken it drives the header wider
                than the panel and the Close control goes off the edge. */}
            <span className="mono-figures min-w-0 break-all text-[13px] font-normal text-read-300">
              {runId}
            </span>
          </span>
        }
        /* Read off RUN_STARTED rather than the arming control, so this says what
           the run was actually given — the toggle can have moved since, and this
           panel also serves runs it did not launch. */
        subtitle={
          queued
            ? `Waiting for the run slot. ${view.queued?.ahead ?? 0} ahead of it.`
            : `Replaying the approved specification against the recorded baseline. Repairs are ${
                view.started?.healing ? 'armed' : 'off'
              }.`
        }
        right={
          <div className="flex items-center gap-2">
            {live ? <Spinner /> : null}
            {/*
              Offered only while there is something to stop. The server takes both
              states: a queued run is lifted out of the queue, a running one has its
              abort signal raised and unwinds where it is.

              No confirm step. Halting a replay destroys nothing — the run is
              recorded as cancelled, the baseline is untouched, and the remedy for a
              mistake is to press Run it again.
            */}
            {live ? (
              <Button
                tone="danger"
                disabled={halting}
                onClick={() => {
                  setHalting(true);
                  setHaltError(null);
                  api
                    .cancelRun(runId)
                    // Refresh rather than assume: the cancel may land after the run
                    // already finished, and the events are what say which happened.
                    .then(() => detail.reload())
                    .catch((err: unknown) =>
                      setHaltError(err instanceof Error ? err.message : String(err)),
                    )
                    .finally(() => setHalting(false));
                }}
              >
                <IconStop size={13} />
                {halting ? 'Halting' : 'Halt'}
              </Button>
            ) : null}
            <button
              type="button"
              onClick={onDismiss}
              className={`label-cut border border-rule px-2 py-1 text-read-200 transition-colors hover:border-signal hover:text-signal ${focusRing}`}
            >
              Close
            </button>
          </div>
        }
      />

      {detail.error ? (
        <div className="px-4 py-3">
          <ErrorNote>{detail.error}</ErrorNote>
        </div>
      ) : null}

      {haltError ? (
        <div className="px-4 py-3">
          <ErrorNote>{haltError}</ErrorNote>
        </div>
      ) : null}

      {view.errors.length > 0 ? (
        <div className="space-y-2 px-4 py-3">
          {view.errors.map((err, index) => (
            <ErrorNote key={index}>{err.message}</ErrorNote>
          ))}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <StepChannel
          steps={view.steps}
          totalSteps={view.totalSteps}
          planId={planId}
          onBaselineChanged={onBaselineChanged}
        />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Baseline and runs
// ---------------------------------------------------------------------------

function BaselinePanel({ baseline }: { baseline: BaselineView }) {
  return (
    <Panel>
      <PanelHeader
        title="Recorded baseline"
        subtitle="What was actually resolved on the page, with the locator chosen for each step and every repair it has taken since."
        right={<span className="mono-figures text-[12px] text-read-300">{when(baseline.createdAt)}</span>}
      />
      <ol>
        {baseline.steps.map((step) => {
          const primary = step.locator;
          const strategy = primary?.strategy ?? null;
          return (
            <li key={step.stepId} className="border-b border-rule px-4 py-3.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-read-100">{step.action}</span>
                <Code>{step.stepId}</Code>
                {strategy ? (
                  <span
                    className="label-cut rounded-plate border border-rule bg-plate-200 px-1.5 py-0.5"
                    title={STRATEGY_NOTE[strategy as keyof typeof STRATEGY_NOTE]}
                  >
                    {strategy}
                  </span>
                ) : (
                  <span className="text-[12px] text-read-300">no element — acts on the page</span>
                )}
                {step.healHistory.length > 0 ? (
                  <Chip tone="heal">
                    {step.healHistory.length} repair{step.healHistory.length === 1 ? '' : 's'}
                  </Chip>
                ) : null}
                <span className="mono-figures ml-auto text-[12px] text-read-300">
                  {step.fallbackLocators.length} fallback{step.fallbackLocators.length === 1 ? '' : 's'}
                </span>
              </div>

              <p className="measure mt-1 text-[12px] leading-relaxed text-read-300">{step.intent}</p>

              {step.expectedOutcome.assertions.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {step.expectedOutcome.assertions.map((assertion, i) => (
                    <li key={`${assertion.type}-${i}`}>
                      <Chip>
                        {assertion.type}
                        {assertion.value ? `: ${assertion.value}` : ''}
                      </Chip>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="measure mt-2 text-[12px] text-read-300">
                  No post-condition. An honest record that nothing verifiable changed — and the reason a repair on
                  this step would count as unverified.
                </p>
              )}

              {step.healHistory.length > 0 ? (
                <details className="mt-2.5">
                  <summary className={`label-cut cursor-pointer text-signal hover:text-signal-ink ${focusRing}`}>
                    {step.healHistory.length} repair{step.healHistory.length === 1 ? '' : 's'}
                  </summary>
                  <div className="mt-1.5 space-y-1.5 border-l border-rule pl-3">
                    {step.healHistory.map((heal) => {
                      const from = parseLocator(describeStoredLocator(heal.previousLocator));
                      return (
                        <p key={heal.healedAt} className="measure text-[12px] leading-relaxed text-read-200">
                          <span className="label-cut mr-2 text-read-100">Repaired {when(heal.healedAt)}</span>
                          from <Code className="break-all">{from?.raw ?? '—'}</Code> — {heal.reason}
                        </p>
                      );
                    })}
                  </div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/** The stored baseline holds locators as structures; only the stream pre-renders
 * them. Rendered the same way here so both places read identically. */
function describeStoredLocator(locator: {
  strategy: string;
  value: string | null;
  role: string | null;
  name: string | null;
  nth: number | null;
}): string {
  const base =
    locator.strategy === 'role'
      ? `role=${locator.role}[name="${locator.name ?? ''}"]`
      : locator.strategy === 'labelledBy'
        ? `after label "${locator.value ?? ''}"`
        : `${locator.strategy}="${locator.value ?? ''}"`;
  return locator.nth === null ? base : `${base} >> nth=${locator.nth}`;
}

/**
 * What this plan has been run as, and a way into any of them.
 *
 * The rows were briefly inert — they used to open a replay on the console, and
 * when that screen went there was nowhere for them to lead. They lead here now,
 * to the same panel a freshly launched run uses, which makes a run in flight
 * something you can walk up to rather than something you had to have started
 * yourself. Reopening the page mid-run, or starting one and scrolling away, both
 * stop being dead ends.
 *
 * A run still going says so on the row, because the difference between "this is
 * happening now" and "this happened on Tuesday" is the whole reason to click.
 */
function PlanRuns({
  runs,
  openRunId,
  onOpen,
}: {
  runs: RunSummary[];
  openRunId: string | null;
  onOpen: (runId: string) => void;
}) {
  return (
    <Panel>
      <PanelHeader
        title="Runs of this plan"
        subtitle="Every recorded execution, newest first. Open one to see its steps — including one still in flight."
      />
      <ul>
        {runs.map((run) => {
          const live = run.status === 'queued' || run.status === 'running';
          const open = run.runId === openRunId;
          return (
            <li key={run.runId} className="border-b border-rule last:border-b-0">
              <button
                type="button"
                aria-current={open ? 'true' : undefined}
                onClick={() => onOpen(run.runId)}
                className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left transition-colors ${focusRing} ${
                  open ? 'bg-plate-200/60' : 'hover:bg-plate-200/40'
                }`}
              >
                <RunStatusChip status={run.status} />
                {run.activeVersion ? <Chip tone="accent">{run.activeVersion}</Chip> : null}
                {run.healCount > 0 ? <Chip tone="heal">{run.healCount} repaired</Chip> : null}
                {live ? <Spinner /> : null}
                <span className="mono-figures ml-auto text-[12px] text-read-300">
                  {run.stepsPassed}/{run.stepsTotal} · {when(run.startedAt)}
                </span>
                <span className="label-cut w-16 shrink-0 text-right">
                  {open ? 'Open' : live ? 'Watch' : 'View'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
