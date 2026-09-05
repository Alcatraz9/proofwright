import fs from 'node:fs/promises';
import path from 'node:path';
import { SEED_PATHS } from '../config.js';
import { baselineSchema, type Baseline, type BaselineStep } from '../baseline/types.js';
import { db, execute, nowIso, queryOne } from './db.js';

/**
 * Baselines are keyed by planId, so a replay can ask "do we already have one?"
 * and skip recording entirely on every run after the first.
 *
 * The steps array is stored as one JSON blob rather than a table per step. It is
 * only ever read and written whole — a heal rewrites one step's locator but the
 * baseline is still saved as a unit — and normalising it would buy queries
 * nobody makes at the cost of reassembling a deeply nested shape on every read.
 */

interface BaselineRow {
  plan_id: string;
  baseline_id: string;
  created_at: string;
  updated_at: string;
  model: string;
  start_url: string;
  steps_json: string;
  visual_json: string | null;
}

function toBaseline(row: BaselineRow): Baseline {
  return baselineSchema.parse({
    baselineId: row.baseline_id,
    planId: row.plan_id,
    createdAt: row.created_at,
    model: row.model,
    startUrl: row.start_url,
    steps: JSON.parse(row.steps_json),
    visualBaselines: JSON.parse(row.visual_json ?? '[]'),
  });
}

export function saveBaseline(baseline: Baseline): void {
  const at = nowIso();
  db()
    .prepare(
      `INSERT INTO baselines (plan_id, baseline_id, created_at, updated_at, model, start_url, steps_json, visual_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         baseline_id = excluded.baseline_id,
         updated_at  = excluded.updated_at,
         model       = excluded.model,
         start_url   = excluded.start_url,
         steps_json  = excluded.steps_json,
         visual_json = excluded.visual_json`,
    )
    .run(
      baseline.planId,
      baseline.baselineId,
      baseline.createdAt,
      at,
      baseline.model,
      baseline.startUrl,
      JSON.stringify(baseline.steps),
      JSON.stringify(baseline.visualBaselines),
    );
}

export function loadBaseline(planId: string): Baseline | null {
  const row = queryOne<BaselineRow>('SELECT * FROM baselines WHERE plan_id = ?', planId);
  return row ? toBaseline(row) : null;
}

export function deleteBaseline(planId: string): boolean {
  return execute('DELETE FROM baselines WHERE plan_id = ?', planId) > 0;
}

/**
 * Reverts one step to the locator it had before its most recent heal, and drops
 * that heal record.
 *
 * Healing is allowed to write the baseline unattended because an accepted heal
 * has already satisfied the step's original recorded outcome against the live
 * app. That is a strong guarantee but not a human's judgement, so the audit
 * trail exists and this is the one-click way back out of it.
 */
export function revertLastHeal(
  planId: string,
  stepId: string,
): { reverted: true; step: BaselineStep } | { reverted: false; reason: string } {
  const baseline = loadBaseline(planId);
  if (!baseline) return { reverted: false, reason: `No baseline for "${planId}".` };

  const step = baseline.steps.find((s) => s.stepId === stepId);
  if (!step) return { reverted: false, reason: `No step "${stepId}" in that baseline.` };

  const record = step.healHistory.at(-1);
  if (!record) return { reverted: false, reason: `Step "${stepId}" has never been healed.` };

  step.locator = record.previousLocator;
  step.fingerprint = record.previousFingerprint;
  // The fallbacks recorded alongside the healed locator described the healed
  // element, so they are meaningless against the restored one. Clearing them
  // costs a drift warning on the next run and is honest; keeping them could
  // silently rescue the step with a locator for the wrong element.
  step.fallbackLocators = [];
  step.healHistory.pop();

  saveBaseline(baseline);
  return { reverted: true, step };
}

/** Reads the baseline JSON committed to the repo as seed data. */
export async function readLegacyBaselineFiles(): Promise<Baseline[]> {
  let files: string[];
  try {
    files = await fs.readdir(SEED_PATHS.baselines);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const baselines: Baseline[] = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const raw = await fs.readFile(path.join(SEED_PATHS.baselines, file), 'utf8');
    const parsed = baselineSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      baselines.push(parsed.data);
      continue;
    }
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 5);
    console.warn(
      `Seed: skipping baseline ${file} — does not match the current schema (${fields.join(', ')}). ` +
        'It needs re-recording against the app under test.',
    );
  }
  return baselines;
}
