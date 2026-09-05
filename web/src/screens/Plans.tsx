import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ApiError } from '../api/client.ts';
import type { BaselineView, IntentPlan, IntentStep, PlanRecord, PlanSummary, RunSummary } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import {
  Button,
  Code,
  Empty,
  ErrorNote,
  Field,
  focusRing,
  inputClass,
  Panel,
  PanelHeader,
  Reveal,
  Spinner,
} from '../components/ui.tsx';
import { Chip, PlanStatusChip, RunStatusChip } from '../components/status.tsx';
import { IconDisclose } from '../components/icons.tsx';
import { ago, when } from '../lib/format.ts';
import { parseLocator, STRATEGY_NOTE } from '../lib/locator.ts';
import { Link, useRouter } from '../lib/router.tsx';

/**
 * Plans, and the gate.
 *
 * A draft cannot run. The server returns 409 for it, and the interface refuses it
 * too, because a gate one interface can walk around is not a gate. Editing sends a
 * plan back to draft — the approval applied to what was reviewed, not to whatever
 * it has become since — and the editor says so before you save rather than after.
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
 * approving. The same pattern is used for both approve and un-approve.
 */
function ConfirmGate({
  action,
  plan,
  updatedAt,
  busy,
  onConfirm,
  onCancel,
}: {
  action: 'approve' | 'unapprove';
  plan: IntentPlan;
  updatedAt: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isApprove = action === 'approve';
  const warnings = isApprove ? approvalWarnings(plan) : [];

  return (
    <div
      role="alertdialog"
      aria-label={isApprove ? 'Confirm plan approval' : 'Confirm returning plan to draft'}
      className="rounded-plate border border-rule bg-plate-200 px-4 py-3 space-y-2.5"
    >
      <p className="text-[13px] font-semibold text-read-100">
        {isApprove ? 'Approve this plan?' : 'Return this plan to draft?'}
      </p>

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

      {isApprove && warnings.length > 0 ? (
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

      {!isApprove ? (
        <p className="measure text-[12px] leading-relaxed text-read-300">
          The plan will return to draft and cannot be run until it is approved again.
        </p>
      ) : null}

      <div className="flex gap-2 pt-1">
        <Button
          tone={isApprove ? 'primary' : 'danger'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? <Spinner /> : null}
          {isApprove ? 'Yes, approve' : 'Yes, return to draft'}
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
  const [busy, setBusy] = useState<'approve' | 'unapprove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'approve' | 'unapprove' | null>(null);

  const record = detail.data?.plan ?? null;
  const baseline = detail.data?.baseline ?? null;
  const runs = detail.data?.runs ?? [];

  const gate = async (action: 'approve' | 'unapprove'): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      if (action === 'approve') await api.approve(planId);
      else await api.unapprove(planId);
      setConfirming(null);
      detail.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
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
            {confirming !== null ? (
              <ConfirmGate
                action={confirming}
                plan={record.plan}
                updatedAt={record.updatedAt}
                busy={busy !== null}
                onConfirm={() => void gate(confirming)}
                onCancel={() => setConfirming(null)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {record.status === 'APPROVED' ? (
                  <Button onClick={() => setConfirming('unapprove')} disabled={busy !== null}>
                    Send back for review
                  </Button>
                ) : (
                  <Button
                    tone="primary"
                    onClick={() => setConfirming('approve')}
                    disabled={busy !== null || record.plan.steps.length === 0}
                  >
                    Approve this plan
                  </Button>
                )}

                {runnable ? (
                  <Link to="/" className={`label-cut text-signal hover:text-signal-ink ${focusRing}`}>
                    Run it
                  </Link>
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

      <Reveal delay={60}>
        <PlanEditor record={record} onSaved={detail.reload} />
      </Reveal>

      {baseline ? (
        <Reveal delay={100}>
          <BaselinePanel baseline={baseline} />
        </Reveal>
      ) : null}

      {runs.length > 0 ? (
        <Reveal delay={140}>
          <PlanRuns runs={runs} />
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

function PlanEditor({ record, onSaved }: { record: PlanRecord; onSaved: () => void }) {
  const [draft, setDraft] = useState<IntentPlan>(record.plan);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmingSave, setConfirmingSave] = useState(false);

  useEffect(() => {
    setDraft(record.plan);
    setIssues([]);
    setSaved(false);
    setConfirmingSave(false);
  }, [record]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(record.plan), [draft, record.plan]);

  const issuesFor = (index: number): { path: string; message: string }[] =>
    issues.filter((issue) => issue.path.startsWith(`steps.${index}.`) || issue.path === `steps.${index}`);

  const updateStep = (index: number, patch: Partial<IntentStep>): void => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
    setSaved(false);
    setConfirmingSave(false);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setIssues([]);
    setError(null);
    try {
      await api.savePlan(record.planId, draft);
      setSaved(true);
      setConfirmingSave(false);
      onSaved();
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.issues) setIssues(apiError.issues);
      setError(apiError.message);
    } finally {
      setSaving(false);
    }
  };

  /** If the plan is approved, saving returns it to draft — require deliberate confirmation. */
  const handleSave = (): void => {
    if (record.status === 'APPROVED') {
      setConfirmingSave(true);
    } else {
      void save();
    }
  };

  return (
    <Panel>
      <PanelHeader
        title="Review the steps"
        subtitle="Held to the same schema the model's output is, so a hand-edited plan cannot be looser than a generated one."
        right={
          <span className="mono-figures text-[12px] text-read-300">
            {draft.steps.length} step{draft.steps.length === 1 ? '' : 's'}
          </span>
        }
      />

      {record.status === 'APPROVED' ? (
        <p className="measure border-b border-signal/30 bg-plate-000 px-4 py-3 text-[13px] leading-relaxed text-signal">
          This plan is approved. Saving any edit returns it to draft, because the approval applied to what was
          reviewed — not to whatever it becomes next. It will need approving again before it can run.
        </p>
      ) : null}

      <div>
        {draft.steps.map((step, index) => (
          <CollapsibleStep
            key={step.id}
            index={index}
            step={step}
            issues={issuesFor(index)}
            onChange={(patch) => updateStep(index, patch)}
          />
        ))}
      </div>

      {issues.length > 0 ? (
        <div className="space-y-1.5 border-t border-alarm/40 bg-plate-000 px-4 py-3">
          <p className="text-[13px] font-medium text-alarm-ink">
            The edited plan does not satisfy the plan schema. Nothing was saved.
          </p>
          {issues.map((issue) => (
            <p key={`${issue.path}-${issue.message}`} className="mono-figures text-[12px] text-alarm-ink/85">
              {issue.path || '(root)'}: {issue.message}
            </p>
          ))}
        </div>
      ) : error ? (
        <div className="px-4 py-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center gap-3 border-t border-rule px-4 py-3.5">
        {confirmingSave ? (
          <div
            role="alertdialog"
            aria-label="Confirm saving edits to an approved plan"
            className="w-full rounded-plate border border-signal/40 bg-plate-000 px-4 py-3 space-y-2.5"
          >
            <p className="text-[13px] font-semibold text-signal">Save and return to draft?</p>
            <p className="measure text-[12px] leading-relaxed text-read-200">
              This plan is approved. Saving returns it to draft — it will need approving again before it can run.
            </p>
            <div className="flex gap-2 pt-1">
              <Button tone="danger" onClick={() => void save()} disabled={saving}>
                {saving ? <Spinner /> : null}
                Yes, save and return to draft
              </Button>
              <Button onClick={() => setConfirmingSave(false)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button tone="primary" onClick={handleSave} disabled={!dirty || saving}>
              {saving ? <Spinner /> : null}
              Save edits
            </Button>
            <Button onClick={() => setDraft(record.plan)} disabled={!dirty || saving}>
              Discard
            </Button>
            <span className="text-[12px] text-read-300">
              {saved
                ? 'Saved. The plan is back in draft and needs approving again.'
                : dirty
                  ? 'Unsaved edits.'
                  : 'No changes.'}
            </span>
          </>
        )}
      </footer>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Collapsible step — progressive disclosure
// ---------------------------------------------------------------------------

function CollapsibleStep({
  index,
  step,
  issues,
  onChange,
}: {
  index: number;
  step: IntentStep;
  issues: { path: string; message: string }[];
  onChange: (patch: Partial<IntentStep>) => void;
}) {
  // Auto-expand if the step has validation errors
  const hasErrors = issues.length > 0;
  const [expanded, setExpanded] = useState(hasErrors);

  // Keep expanded if errors appear while collapsed
  useEffect(() => {
    if (hasErrors) setExpanded(true);
  }, [hasErrors]);

  const stepLabel = `Step ${index + 1}: ${step.action} ${step.target?.description ?? step.value ?? ''}`.trim();
  const regionId = `step-editor-${step.id}`;

  return (
    <div className={`border-b border-rule last:border-b-0 ${hasErrors ? 'bg-plate-000' : ''}`}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        aria-label={stepLabel}
        onClick={() => setExpanded((prev) => !prev)}
        className={`flex w-full items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-plate-200/30 ${focusRing}`}
      >
        <span className="label-cut mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-plate border border-rule bg-plate-200 text-read-200">
          {index + 1}
        </span>

        <span className="mt-0.5 flex-none" aria-hidden="true">
          <IconDisclose open={expanded} size={14} className="text-read-300" />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <Code>{step.id}</Code>
            <span className="text-[12px] font-medium text-read-100">{step.action}</span>
            <span className="min-w-0 truncate text-[12px] text-read-200">
              {step.target?.description ?? step.value ?? ''}
            </span>
          </span>
          {step.intent ? (
            <span className="measure truncate text-[12px] leading-snug text-read-300">
              {step.intent}
            </span>
          ) : null}
        </span>

        {hasErrors ? (
          <span className="label-cut mt-0.5 flex-none text-alarm-ink">{issues.length} error{issues.length === 1 ? '' : 's'}</span>
        ) : !step.expectedOutcome?.description ? (
          <span className="label-cut mt-0.5 flex-none text-signal/70" title="The specification does not state an outcome for this step. The recorded baseline may still hold assertions for it.">no stated outcome</span>
        ) : null}
      </button>

      {expanded ? (
        <div id={regionId} role="region" aria-label={stepLabel} className="px-4 pb-4">
          <StepEditor step={step} issues={issues} onChange={onChange} />
        </div>
      ) : null}
    </div>
  );
}

function StepEditor({
  step,
  issues,
  onChange,
}: {
  step: IntentStep;
  issues: { path: string; message: string }[];
  onChange: (patch: Partial<IntentStep>) => void;
}) {
  const issueFor = (field: string): string | undefined =>
    issues.find((issue) => issue.path.endsWith(`.${field}`) || issue.path.endsWith(`.${field}.description`))
      ?.message;

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Action" hint="A closed vocabulary — a value outside it is rejected by the schema." error={issueFor('action')}>
          <input
            className={inputClass}
            value={step.action}
            onChange={(event) => onChange({ action: event.target.value })}
          />
        </Field>

        <Field
          label="Target description"
          hint="In human terms, never a selector. This layer has to survive a redesign."
          error={issueFor('target')}
        >
          <input
            className={inputClass}
            value={step.target?.description ?? ''}
            placeholder={step.action === 'navigate' ? 'Not used by navigate' : 'e.g. add to cart button'}
            onChange={(event) =>
              onChange({
                target: event.target.value
                  ? { description: event.target.value, context: step.target?.context ?? null }
                  : null,
              })
            }
          />
        </Field>

        <Field label="Value" hint="For navigate this is the URL; for press, the key name." error={issueFor('value')}>
          <input
            className={inputClass}
            value={step.value ?? ''}
            onChange={(event) => onChange({ value: event.target.value || null })}
          />
        </Field>

        <Field
          label="Value reference"
          hint="An environment variable name for anything secret. The plan stores the name, never the value."
          error={issueFor('valueRef')}
        >
          <input
            className={inputClass}
            value={step.valueRef ?? ''}
            placeholder="TEST_PASSWORD"
            onChange={(event) => onChange({ valueRef: event.target.value || null })}
          />
        </Field>

        <Field
          label="Expected outcome"
          hint="What a human would see afterwards. A step with no post-condition gives the healer nothing to verify against."
          error={issueFor('expectedOutcome')}
        >
          <input
            className={inputClass}
            value={step.expectedOutcome?.description ?? ''}
            onChange={(event) =>
              onChange({ expectedOutcome: event.target.value ? { description: event.target.value } : null })
            }
          />
        </Field>

        <Field
          label="Expected value"
          hint="Only when the tester named a literal. This is what makes a changed price fail instead of being healed."
          error={issueFor('expectedValue')}
        >
          <input
            className={inputClass}
            value={step.expectedValue ?? ''}
            onChange={(event) => onChange({ expectedValue: event.target.value || null })}
          />
        </Field>
      </div>

      <p className="measure mt-2.5 text-[12px] leading-snug text-read-300">
        Quoted from the instruction: "{step.sourcePhrase}"
      </p>
    </div>
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

function PlanRuns({ runs }: { runs: RunSummary[] }) {
  const { navigate } = useRouter();
  return (
    <Panel>
      <PanelHeader title="Runs of this plan" subtitle="Opening one replays it from its recorded events." />
      <ul>
        {runs.map((run) => (
          <li key={run.runId} className="border-b border-rule last:border-b-0">
            <button
              type="button"
              onClick={() => navigate(`/?run=${encodeURIComponent(run.runId)}`)}
              className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left transition-colors hover:bg-plate-200/40 ${focusRing}`}
            >
              <RunStatusChip status={run.status} />
              {run.activeVersion ? <Chip tone="accent">{run.activeVersion}</Chip> : null}
              {run.healCount > 0 ? <Chip tone="heal">{run.healCount} repaired</Chip> : null}
              <span className="mono-figures ml-auto text-[12px] text-read-300">
                {run.stepsPassed}/{run.stepsTotal} · {when(run.startedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
