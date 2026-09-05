import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PATHS } from '../config.js';

/**
 * One SQLite file, opened once per process.
 *
 * The prototype kept plans, baselines and runs as flat JSON keyed by planId,
 * which was right for a CLI: one command, one writer, one file. A server breaks
 * both halves of that. Two runs finishing at once would read-modify-write the
 * same file and the later write would silently erase the earlier one — the old
 * stores did a plain overwrite with no lock. And the dashboard needs to *read*
 * run history, which the flat store could not do at all: it had a save function
 * and nothing else.
 *
 * SQLite is still a single file with no server to operate, so this costs nothing
 * in deployment and buys atomic writes plus a queryable history.
 */

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;

  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  const database = new DatabaseSync(PATHS.db);

  // WAL lets the dashboard read while a run is writing. Without it a long write
  // blocks every reader and the live view stalls exactly when it matters most.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');

  migrate(database);
  handle = database;
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/**
 * Plain forward-only schema creation. A hackathon does not need migration
 * tooling, but it does need this to be safe to run on every boot, because the
 * free-tier filesystem is ephemeral and half of all boots start from nothing.
 */
function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      plan_id      TEXT PRIMARY KEY,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      model        TEXT NOT NULL,
      target_url   TEXT NOT NULL,
      instruction  TEXT NOT NULL,
      -- DRAFT until a human approves it. Nothing may be recorded or replayed
      -- from a DRAFT: the approval gate is the point, not a formality.
      status       TEXT NOT NULL DEFAULT 'DRAFT',
      approved_at  TEXT,
      plan_json    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS baselines (
      plan_id      TEXT PRIMARY KEY REFERENCES plans(plan_id) ON DELETE CASCADE,
      baseline_id  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      model        TEXT NOT NULL,
      start_url    TEXT NOT NULL,
      steps_json   TEXT NOT NULL,
      -- Recorded appearance per page per viewport. Separate from steps_json
      -- because it is keyed by page, not by step.
      visual_json  TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id             TEXT PRIMARY KEY,
      plan_id            TEXT NOT NULL,
      started_at         TEXT NOT NULL,
      finished_at        TEXT,
      -- queued | running | passed | failed | needs_review | cancelled | error
      status             TEXT NOT NULL,
      start_url          TEXT NOT NULL,
      -- Which fixture version was live. A run is only interpretable against the
      -- UI it ran on, and the whole demo turns on changing that underneath it.
      active_version     TEXT,
      healing_enabled    INTEGER NOT NULL DEFAULT 0,
      steps_total        INTEGER NOT NULL DEFAULT 0,
      steps_passed       INTEGER NOT NULL DEFAULT 0,
      heal_count         INTEGER NOT NULL DEFAULT 0,
      visual_findings    INTEGER NOT NULL DEFAULT 0,
      a11y_violations    INTEGER NOT NULL DEFAULT 0,
      security_findings  INTEGER NOT NULL DEFAULT 0,
      llm_calls          INTEGER NOT NULL DEFAULT 0,
      duration_ms        INTEGER,
      -- Full RunResult once finished. Null while queued or running.
      result_json        TEXT
    );

    CREATE INDEX IF NOT EXISTS runs_by_plan ON runs(plan_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS runs_by_time ON runs(started_at DESC);

    -- Every streamed event, in order. A judge who opens the dashboard halfway
    -- through a run can replay the stream from the beginning instead of seeing
    -- a blank timeline until the next event happens to fire.
    CREATE TABLE IF NOT EXISTS run_events (
      run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      seq      INTEGER NOT NULL,
      at       TEXT NOT NULL,
      type     TEXT NOT NULL,
      payload  TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      step_id  TEXT,
      -- screenshot | baseline | diff
      kind     TEXT NOT NULL,
      viewport TEXT,
      rel_path TEXT NOT NULL,
      at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS artifacts_by_run ON artifacts(run_id);

    -- Long-running work that is not a test run: recording a baseline, principally.
    -- Deliberately not modelled as a run. A recording has no verdict and no passing
    -- steps, so putting it in the runs table would corrupt every dashboard aggregate.
    CREATE TABLE IF NOT EXISTS jobs (
      job_id       TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      plan_id      TEXT NOT NULL,
      status       TEXT NOT NULL,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      message      TEXT
    );

    CREATE INDEX IF NOT EXISTS jobs_by_plan ON jobs(plan_id, started_at DESC);

    -- Same shape as run_events, so one streaming path serves both.
    CREATE TABLE IF NOT EXISTS job_events (
      job_id   TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
      seq      INTEGER NOT NULL,
      at       TEXT NOT NULL,
      type     TEXT NOT NULL,
      payload  TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    );

    -- Cached heal proposals, keyed by the failure they answer.
    --
    -- A proposal is a suggestion, never a verdict: whatever comes back from here
    -- is still resolved to a locator, still executed against the live page, and
    -- still judged by the step's original recorded outcome. So reusing one cannot
    -- make a wrong heal pass — it only skips asking the same question twice.
    --
    -- This exists because the same demonstration gets run repeatedly, and free-tier
    -- quota is counted per day. Without it, the fifth showing of a heal fails for
    -- want of quota rather than for any reason to do with the software.
    CREATE TABLE IF NOT EXISTS heal_cache (
      signature     TEXT PRIMARY KEY,
      proposal_json TEXT NOT NULL,
      model         TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      hits          INTEGER NOT NULL DEFAULT 0
    );

    -- Single-row key/value for instance state that is not per-plan, currently
    -- just which fixture version the app under test is serving.
    CREATE TABLE IF NOT EXISTS missions (
      mission_id     TEXT PRIMARY KEY,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      finished_at    TEXT,
      status         TEXT NOT NULL,
      mode           TEXT NOT NULL,
      stage          TEXT,
      target_url     TEXT NOT NULL,
      instruction    TEXT,
      prd            TEXT,
      plan_id        TEXT,
      run_id         TEXT,
      decisions_json TEXT NOT NULL DEFAULT '[]',
      site_map_json  TEXT,
      coverage_rounds_json TEXT NOT NULL DEFAULT '[]',
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS missions_created_at ON missions (created_at DESC);

    CREATE TABLE IF NOT EXISTS reports (
      mission_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      json       TEXT NOT NULL,
      markdown   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
  `);

  // Forward migrations for databases created by an earlier version. SQLite has no
  // "add column if not exists", and the statement throws when the column is
  // already there, so each is attempted and its duplicate error ignored.
  for (const statement of [
    `ALTER TABLE baselines ADD COLUMN visual_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE missions ADD COLUMN site_map_json TEXT`,
    `ALTER TABLE missions ADD COLUMN coverage_rounds_json TEXT NOT NULL DEFAULT '[]'`,
  ]) {
    try {
      database.exec(statement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(message)) throw err;
    }
  }
}

export function getSetting(key: string): string | null {
  const row = queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `node:sqlite` types every column as `SQLOutputValue`, so a row comes back as
 * an untyped bag. These two wrappers are the only place that gets asserted
 * away, which keeps the assertion reviewable instead of repeated at forty call
 * sites where a drifting column name would go unnoticed.
 */
export function queryAll<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db().prepare(sql).all(...params) as unknown as T[];
}

export function queryOne<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db().prepare(sql).get(...params) as unknown as T | undefined;
}

/** Rows changed by an INSERT/UPDATE/DELETE. */
export function execute(sql: string, ...params: SQLInputValue[]): number {
  return Number(db().prepare(sql).run(...params).changes);
}
