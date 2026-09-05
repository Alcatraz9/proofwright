import { runResultSchema, type RunResult } from '../run/types.js';
import { db, execute, nowIso, queryAll, queryOne } from './db.js';

/**
 * Runs accumulate rather than overwrite — the history is the point.
 *
 * The flat-file version of this file was twelve lines with a single `saveRun`
 * and no way to read anything back. That was survivable for a CLI that printed
 * its verdict to stdout, but a dashboard is mostly a read of this table, so the
 * query side is the substance here.
 */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  /** Passed only because more steps healed than we are willing to accept silently. */
  | 'needs_review'
  | 'cancelled'
  | 'error';

export interface RunCounters {
  stepsTotal: number;
  stepsPassed: number;
  healCount: number;
  visualFindings: number;
  a11yViolations: number;
  securityFindings: number;
  llmCalls: number;
}

export interface RunSummary extends RunCounters {
  runId: string;
  planId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  startUrl: string;
  activeVersion: string | null;
  healingEnabled: boolean;
  durationMs: number | null;
}

interface RunRow {
  run_id: string;
  plan_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  start_url: string;
  active_version: string | null;
  healing_enabled: number;
  steps_total: number;
  steps_passed: number;
  heal_count: number;
  visual_findings: number;
  a11y_violations: number;
  security_findings: number;
  llm_calls: number;
  duration_ms: number | null;
  result_json: string | null;
}

function toSummary(row: RunRow): RunSummary {
  return {
    runId: row.run_id,
    planId: row.plan_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as RunStatus,
    startUrl: row.start_url,
    activeVersion: row.active_version,
    healingEnabled: Boolean(row.healing_enabled),
    durationMs: row.duration_ms,
    stepsTotal: row.steps_total,
    stepsPassed: row.steps_passed,
    healCount: row.heal_count,
    visualFindings: row.visual_findings,
    a11yViolations: row.a11y_violations,
    securityFindings: row.security_findings,
    llmCalls: row.llm_calls,
  };
}

/**
 * A run is recorded the moment it is queued, before anything executes.
 *
 * That ordering matters for a live dashboard: the client needs a runId to open
 * an event stream against, and it needs the row to exist so a queued run is
 * visible while it waits behind another. A run that dies mid-flight then leaves
 * a row saying so, rather than leaving no trace at all.
 */
export function createRun(params: {
  runId: string;
  planId: string;
  startUrl: string;
  activeVersion: string | null;
  healingEnabled: boolean;
  stepsTotal: number;
}): void {
  db()
    .prepare(
      `INSERT INTO runs (run_id, plan_id, started_at, status, start_url, active_version, healing_enabled, steps_total)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .run(
      params.runId,
      params.planId,
      nowIso(),
      params.startUrl,
      params.activeVersion,
      params.healingEnabled ? 1 : 0,
      params.stepsTotal,
    );
}

export function markRunStatus(runId: string, status: RunStatus): void {
  execute('UPDATE runs SET status = ? WHERE run_id = ?', status, runId);
}

/** Records the verdict and the counters the dashboard aggregates on. */
export function finishRun(params: {
  runId: string;
  status: RunStatus;
  result: RunResult | null;
  counters: Partial<RunCounters>;
}): void {
  const finishedAt = nowIso();
  const row = queryOne<{ started_at: string }>(
    'SELECT started_at FROM runs WHERE run_id = ?',
    params.runId,
  );
  const durationMs = row ? Date.parse(finishedAt) - Date.parse(row.started_at) : null;

  const counters = params.counters;
  const passed = params.result?.steps.filter((s) => s.status === 'passed').length;

  db()
    .prepare(
      `UPDATE runs SET
         finished_at       = ?,
         status            = ?,
         steps_passed      = COALESCE(?, steps_passed),
         heal_count        = COALESCE(?, heal_count),
         visual_findings   = COALESCE(?, visual_findings),
         a11y_violations   = COALESCE(?, a11y_violations),
         security_findings = COALESCE(?, security_findings),
         llm_calls         = COALESCE(?, llm_calls),
         duration_ms       = ?,
         result_json       = ?
       WHERE run_id = ?`,
    )
    .run(
      finishedAt,
      params.status,
      counters.stepsPassed ?? passed ?? null,
      counters.healCount ?? null,
      counters.visualFindings ?? null,
      counters.a11yViolations ?? null,
      counters.securityFindings ?? null,
      counters.llmCalls ?? null,
      durationMs,
      params.result ? JSON.stringify(params.result) : null,
      params.runId,
    );
}

/**
 * Convenience for the CLI path, which has no queue and no dashboard: records a
 * finished run in one call. The server instead creates the row when the run is
 * queued, so a waiting run is visible before it executes.
 */
export function saveRun(
  run: RunResult,
  extras: { activeVersion?: string | null; healingEnabled?: boolean } & Partial<RunCounters> = {},
): void {
  createRun({
    runId: run.runId,
    planId: run.planId,
    startUrl: run.startUrl,
    activeVersion: extras.activeVersion ?? null,
    healingEnabled: extras.healingEnabled ?? false,
    stepsTotal: run.steps.length,
  });
  finishRun({
    runId: run.runId,
    status: run.status === 'passed' ? 'passed' : 'failed',
    result: run,
    counters: extras,
  });
}

export function loadRun(runId: string): { summary: RunSummary; result: RunResult | null } | null {
  const row = queryOne<RunRow>('SELECT * FROM runs WHERE run_id = ?', runId);
  if (!row) return null;

  // A stored result that no longer parses is reported as absent rather than
  // thrown: the summary row is still true and still worth showing.
  let result: RunResult | null = null;
  if (row.result_json) {
    const parsed = runResultSchema.safeParse(JSON.parse(row.result_json));
    result = parsed.success ? parsed.data : null;
  }

  return { summary: toSummary(row), result };
}

export function listRuns(params: { planId?: string; limit?: number } = {}): RunSummary[] {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const rows = params.planId
    ? queryAll<RunRow>(
        'SELECT * FROM runs WHERE plan_id = ? ORDER BY started_at DESC LIMIT ?',
        params.planId,
        limit,
      )
    : queryAll<RunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', limit);
  return rows.map(toSummary);
}

/** Anything left `running` belongs to a process that is gone. */
export function reconcileOrphanedRuns(): number {
  return execute(
    `UPDATE runs SET status = 'error', finished_at = ?
      WHERE status IN ('queued', 'running')`,
    nowIso(),
  );
}

export interface RunStats {
  totalRuns: number;
  passRate: number;
  totalHeals: number;
  totalVisualFindings: number;
  totalA11yViolations: number;
  totalSecurityFindings: number;
  totalLlmCalls: number;
  avgDurationMs: number | null;
  /** Oldest first, so a chart can plot it without reversing. */
  trend: {
    runId: string;
    planId: string;
    startedAt: string;
    status: RunStatus;
    healCount: number;
    durationMs: number | null;
  }[];
}

export function runStats(limit = 30): RunStats {
  const totals = queryOne<{
    total: number;
    passed: number | null;
    heals: number | null;
    visual: number | null;
    a11y: number | null;
    security: number | null;
    llm: number | null;
    avg_ms: number | null;
  }>(
    `SELECT COUNT(*)                                              AS total,
              SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END)    AS passed,
              SUM(heal_count)                                       AS heals,
              SUM(visual_findings)                                  AS visual,
              SUM(a11y_violations)                                  AS a11y,
              SUM(security_findings)                                AS security,
              SUM(llm_calls)                                        AS llm,
              AVG(duration_ms)                                      AS avg_ms
         FROM runs
        WHERE status NOT IN ('queued', 'running')`,
  ) ?? {
    total: 0, passed: 0, heals: 0, visual: 0, a11y: 0, security: 0, llm: 0, avg_ms: null,
  };

  const trend = queryAll<{
    run_id: string;
    plan_id: string;
    started_at: string;
    status: string;
    heal_count: number;
    duration_ms: number | null;
  }>(
    `SELECT run_id, plan_id, started_at, status, heal_count, duration_ms
           FROM runs
          WHERE status NOT IN ('queued', 'running')
          ORDER BY started_at DESC
          LIMIT ?`,
    limit,
  )
    .map((r) => ({
      runId: r.run_id,
      planId: r.plan_id,
      startedAt: r.started_at,
      status: r.status as RunStatus,
      healCount: r.heal_count,
      durationMs: r.duration_ms,
    }))
    .reverse();

  return {
    totalRuns: totals.total,
    passRate: totals.total > 0 ? (totals.passed ?? 0) / totals.total : 0,
    totalHeals: totals.heals ?? 0,
    totalVisualFindings: totals.visual ?? 0,
    totalA11yViolations: totals.a11y ?? 0,
    totalSecurityFindings: totals.security ?? 0,
    totalLlmCalls: totals.llm ?? 0,
    avgDurationMs: totals.avg_ms,
    trend,
  };
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

export interface StoredRunEvent {
  seq: number;
  at: string;
  type: string;
  payload: unknown;
}

/**
 * Persisting the stream, not just broadcasting it, is what lets a client that
 * connects late catch up. Without this the dashboard shows an empty timeline
 * until the next event happens to fire, which on a slow step is most of the run.
 */
export function appendRunEvent(runId: string, type: string, payload: unknown): number {
  const row = queryOne<{ next: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?',
    runId,
  ) ?? { next: 1 };

  db()
    .prepare('INSERT INTO run_events (run_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)')
    .run(runId, row.next, nowIso(), type, JSON.stringify(payload ?? null));

  return row.next;
}

export function listRunEvents(runId: string, afterSeq = 0): StoredRunEvent[] {
  const rows = queryAll<{ seq: number; at: string; type: string; payload: string }>(
    'SELECT seq, at, type, payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq',
    runId,
    afterSeq,
  );

  return rows.map((r) => ({
    seq: r.seq,
    at: r.at,
    type: r.type,
    payload: JSON.parse(r.payload) as unknown,
  }));
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function recordArtifact(params: {
  runId: string;
  stepId: string | null;
  kind: 'screenshot' | 'baseline' | 'diff';
  viewport: string | null;
  relPath: string;
}): void {
  db()
    .prepare(
      'INSERT INTO artifacts (run_id, step_id, kind, viewport, rel_path, at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(params.runId, params.stepId, params.kind, params.viewport, params.relPath, nowIso());
}

export function listArtifacts(runId: string): {
  stepId: string | null;
  kind: string;
  viewport: string | null;
  relPath: string;
}[] {
  const rows = queryAll<{
    step_id: string | null;
    kind: string;
    viewport: string | null;
    rel_path: string;
  }>('SELECT step_id, kind, viewport, rel_path FROM artifacts WHERE run_id = ? ORDER BY id', runId);

  return rows.map((r) => ({
    stepId: r.step_id,
    kind: r.kind,
    viewport: r.viewport,
    relPath: r.rel_path,
  }));
}
