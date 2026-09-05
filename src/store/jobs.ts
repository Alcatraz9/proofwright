import { execute, nowIso, queryAll, queryOne } from './db.js';

/**
 * Long-running work that is not a test run.
 *
 * Recording a baseline drives a real browser through the whole flow and takes the
 * better part of a minute, so it cannot be a blocking request — and it has to queue
 * against runs, because two Chromium instances on a small container is how the
 * container dies.
 *
 * Kept separate from `runs` rather than modelled as one. A recording is not a test
 * result: it has no verdict, no pass rate and no steps that passed or failed, and
 * putting it in the runs table would corrupt every aggregate the dashboard computes.
 * The event log is the same shape, so the streaming path is shared.
 */

/**
 * Kinds of queued browser work.
 *
 * Not cosmetic. Job events are foreign-keyed to this table, so any work the queue
 * announces needs a row here first — the explore stage was queued without one and
 * failed on the constraint before it opened a browser.
 */
export type JobKind = 'record-baseline' | 'explore';
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  planId: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

interface JobRow {
  job_id: string;
  kind: string;
  plan_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  message: string | null;
}

function toRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind as JobKind,
    planId: row.plan_id,
    status: row.status as JobStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    message: row.message,
  };
}

export function createJob(params: { jobId: string; kind: JobKind; planId: string }): void {
  execute(
    `INSERT INTO jobs (job_id, kind, plan_id, status, started_at) VALUES (?, ?, ?, 'queued', ?)`,
    params.jobId,
    params.kind,
    params.planId,
    nowIso(),
  );
}

export function markJobStatus(jobId: string, status: JobStatus): void {
  execute('UPDATE jobs SET status = ? WHERE job_id = ?', status, jobId);
}

export function finishJob(jobId: string, status: JobStatus, message: string | null): void {
  execute(
    'UPDATE jobs SET status = ?, finished_at = ?, message = ? WHERE job_id = ?',
    status,
    nowIso(),
    message,
    jobId,
  );
}

export function loadJob(jobId: string): JobRecord | null {
  const row = queryOne<JobRow>('SELECT * FROM jobs WHERE job_id = ?', jobId);
  return row ? toRecord(row) : null;
}

export function listJobs(planId?: string, limit = 20): JobRecord[] {
  const rows = planId
    ? queryAll<JobRow>(
        'SELECT * FROM jobs WHERE plan_id = ? ORDER BY started_at DESC LIMIT ?',
        planId,
        limit,
      )
    : queryAll<JobRow>('SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?', limit);
  return rows.map(toRecord);
}

/** Anything left mid-flight belongs to a process that is gone. */
export function reconcileOrphanedJobs(): number {
  return execute(
    `UPDATE jobs SET status = 'error', finished_at = ?, message = 'Interrupted by a restart.'
      WHERE status IN ('queued', 'running')`,
    nowIso(),
  );
}

// ---------------------------------------------------------------------------
// Event log — same contract as run events, so the SSE path is shared
// ---------------------------------------------------------------------------

export interface StoredJobEvent {
  seq: number;
  at: string;
  type: string;
  payload: unknown;
}

export function appendJobEvent(jobId: string, type: string, payload: unknown): number {
  const row = queryOne<{ next: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM job_events WHERE job_id = ?',
    jobId,
  ) ?? { next: 1 };

  execute(
    'INSERT INTO job_events (job_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)',
    jobId,
    row.next,
    nowIso(),
    type,
    JSON.stringify(payload ?? null),
  );
  return row.next;
}

export function listJobEvents(jobId: string, afterSeq = 0): StoredJobEvent[] {
  return queryAll<{ seq: number; at: string; type: string; payload: string }>(
    'SELECT seq, at, type, payload FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq',
    jobId,
    afterSeq,
  ).map((row) => ({
    seq: row.seq,
    at: row.at,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
  }));
}
