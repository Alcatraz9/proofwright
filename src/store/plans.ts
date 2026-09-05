import fs from 'node:fs/promises';
import path from 'node:path';
import { SEED_PATHS } from '../config.js';
import { storedPlanSchema, type IntentPlan, type StoredPlan } from '../intent/types.js';
import { db, execute, nowIso, queryAll, queryOne } from './db.js';

/**
 * A plan is the identity every later stage keys off, so the id is chosen by the
 * caller and never derived from anything the model wrote — a model that reworded
 * a test name would otherwise fork the record and orphan its baseline.
 */

export type PlanStatus = 'DRAFT' | 'APPROVED';

export interface PlanRecord extends StoredPlan {
  status: PlanStatus;
  approvedAt: string | null;
  updatedAt: string;
}

export interface PlanSummary {
  planId: string;
  name: string;
  description: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  targetUrl: string;
  stepCount: number;
  hasBaseline: boolean;
  lastRunStatus: string | null;
  lastRunAt: string | null;
}

export function toPlanId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unnamed-plan';
}

interface PlanRow {
  plan_id: string;
  created_at: string;
  updated_at: string;
  model: string;
  target_url: string;
  instruction: string;
  status: string;
  approved_at: string | null;
  plan_json: string;
}

function toRecord(row: PlanRow): PlanRecord {
  const stored = storedPlanSchema.parse({
    planId: row.plan_id,
    createdAt: row.created_at,
    model: row.model,
    source: { targetUrl: row.target_url, instruction: row.instruction },
    plan: JSON.parse(row.plan_json),
  });
  return {
    ...stored,
    status: row.status === 'APPROVED' ? 'APPROVED' : 'DRAFT',
    approvedAt: row.approved_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Newly generated plans land as DRAFT. Re-saving an existing plan keeps its id
 * but sends it back to DRAFT, because an edited plan has not been approved —
 * that is the difference between a review gate and a rubber stamp.
 */
export function savePlan(params: {
  plan: IntentPlan;
  model: string;
  targetUrl: string;
  instruction: string;
  planId?: string;
  status?: PlanStatus;
}): { planId: string; stored: PlanRecord } {
  const planId = params.planId ?? toPlanId(params.plan.name);
  const at = nowIso();
  const status = params.status ?? 'DRAFT';

  db()
    .prepare(
      `INSERT INTO plans (plan_id, created_at, updated_at, model, target_url, instruction, status, approved_at, plan_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         updated_at  = excluded.updated_at,
         model       = excluded.model,
         target_url  = excluded.target_url,
         instruction = excluded.instruction,
         status      = excluded.status,
         approved_at = NULL,
         plan_json   = excluded.plan_json`,
    )
    .run(
      planId,
      at,
      at,
      params.model,
      params.targetUrl,
      params.instruction,
      status,
      JSON.stringify(params.plan),
    );

  const stored = loadPlan(planId);
  if (!stored) throw new Error(`Plan ${planId} vanished immediately after being written.`);
  return { planId, stored };
}

export function loadPlan(planId: string): PlanRecord | null {
  const row = queryOne<PlanRow>('SELECT * FROM plans WHERE plan_id = ?', planId);
  return row ? toRecord(row) : null;
}

/**
 * Replaces the plan body from a human edit. Editing always returns the plan to
 * DRAFT even if it was approved: the approval applied to what was reviewed, not
 * to whatever it has become since.
 */
export function updatePlanBody(planId: string, plan: IntentPlan): PlanRecord | null {
  const existing = loadPlan(planId);
  if (!existing) return null;

  db()
    .prepare(
      `UPDATE plans SET plan_json = ?, updated_at = ?, status = 'DRAFT', approved_at = NULL
       WHERE plan_id = ?`,
    )
    .run(JSON.stringify(plan), nowIso(), planId);

  return loadPlan(planId);
}

export function approvePlan(planId: string): PlanRecord | null {
  const existing = loadPlan(planId);
  if (!existing) return null;
  if (existing.plan.steps.length === 0) {
    throw new Error(`Plan ${planId} has no steps; there is nothing to approve.`);
  }

  const at = nowIso();
  db()
    .prepare(`UPDATE plans SET status = 'APPROVED', approved_at = ?, updated_at = ? WHERE plan_id = ?`)
    .run(at, at, planId);

  return loadPlan(planId);
}

/** Sends an approved plan back for review without touching its body. */
export function unapprovePlan(planId: string): PlanRecord | null {
  if (!loadPlan(planId)) return null;
  db()
    .prepare(`UPDATE plans SET status = 'DRAFT', approved_at = NULL, updated_at = ? WHERE plan_id = ?`)
    .run(nowIso(), planId);
  return loadPlan(planId);
}

export function deletePlan(planId: string): boolean {
  return execute('DELETE FROM plans WHERE plan_id = ?', planId) > 0;
}

/**
 * One query for the whole dashboard list, including whether a baseline exists
 * and how the most recent run went — the three things the list has to show.
 */
export function listPlanSummaries(): PlanSummary[] {
  const rows = queryAll<
    PlanRow & { has_baseline: number; last_run_status: string | null; last_run_at: string | null }
  >(
    `SELECT p.*,
              b.plan_id IS NOT NULL AS has_baseline,
              (SELECT status     FROM runs r WHERE r.plan_id = p.plan_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
              (SELECT started_at FROM runs r WHERE r.plan_id = p.plan_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_at
         FROM plans p
         LEFT JOIN baselines b ON b.plan_id = p.plan_id
        ORDER BY p.updated_at DESC`,
  );

  return rows.map((row) => {
    const plan = JSON.parse(row.plan_json) as IntentPlan;
    return {
      planId: row.plan_id,
      name: plan.name,
      description: plan.description,
      status: row.status === 'APPROVED' ? 'APPROVED' : 'DRAFT',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      approvedAt: row.approved_at,
      targetUrl: row.target_url,
      stepCount: plan.steps.length,
      hasBaseline: Boolean(row.has_baseline),
      lastRunStatus: row.last_run_status,
      lastRunAt: row.last_run_at,
    };
  });
}

export function listPlans(): string[] {
  const rows = queryAll<{ plan_id: string }>(
    'SELECT plan_id FROM plans ORDER BY updated_at DESC',
  );
  return rows.map((r) => r.plan_id);
}

/**
 * Reads the plan JSON committed to the repo as seed data.
 * Used only to seed an empty database — see store/seed.ts.
 */
export async function readLegacyPlanFiles(): Promise<StoredPlan[]> {
  let files: string[];
  try {
    files = await fs.readdir(SEED_PATHS.plans);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const plans: StoredPlan[] = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const raw = await fs.readFile(path.join(SEED_PATHS.plans, file), 'utf8');
    const parsed = storedPlanSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      plans.push(parsed.data);
      continue;
    }
    // Loud, because a silent skip here is indistinguishable from "there was no
    // seed data" — and it hid a stale artifact that predated a schema change.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 5);
    console.warn(`Seed: skipping plan ${file} — does not match the current schema (${fields.join(', ')}).`);
  }
  return plans;
}
