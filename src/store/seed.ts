import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { readLegacyBaselineFiles, saveBaseline } from './baselines.js';
import { readLegacyPlanFiles, savePlan } from './plans.js';
import { reconcileOrphanedRuns } from './runs.js';
import { importCache, type CacheEntry } from './heal-cache.js';
import { reconcileOrphanedJobs } from './jobs.js';
import { PATHS, SEED_PATHS } from '../config.js';

/**
 * Brings a fresh database up to a demoable state.
 *
 * The free Hugging Face tier gives a writable but ephemeral filesystem, so a
 * restart is a cold start: the database is gone. Without this, the first person
 * to open the dashboard after a restart sees an empty screen and has to author a
 * plan — and authoring costs model calls — before anything can be demonstrated.
 *
 * Seeding reads the plan and baseline JSON committed to the repo, so a cold boot
 * lands on a plan that is already approved and already has a recorded baseline.
 * A judge's first click is a replay, which needs no model at all.
 */
export async function seedIfEmpty(): Promise<{
  seeded: boolean;
  plans: number;
  baselines: number;
  artifacts: number;
  healCacheEntries: number;
  orphansReconciled: number;
}> {
  // Runs are reconciled on every boot, not just an empty one: a container that
  // died mid-run left a row claiming to still be running, and no process is
  // coming back to finish it.
  const orphansReconciled = reconcileOrphanedRuns() + reconcileOrphanedJobs();

  const existing = db().prepare('SELECT COUNT(*) AS n FROM plans').get() as { n: number };
  if (existing.n > 0) {
    return {
      seeded: false,
      plans: 0,
      baselines: 0,
      artifacts: 0,
      healCacheEntries: 0,
      orphansReconciled,
    };
  }

  const legacyPlans = await readLegacyPlanFiles();
  for (const stored of legacyPlans) {
    savePlan({
      plan: stored.plan,
      model: stored.model,
      targetUrl: stored.source.targetUrl,
      instruction: stored.source.instruction,
      planId: stored.planId,
      // Seeded plans arrive approved. They shipped in the repo having already
      // been reviewed, and leaving them DRAFT would put an approval click
      // between a cold start and the first demo.
      status: 'APPROVED',
    });
  }

  // Only baselines whose plan actually seeded — an orphan baseline would fail
  // its foreign key and abort the whole seed.
  const planIds = new Set(legacyPlans.map((p) => p.planId));
  const legacyBaselines = (await readLegacyBaselineFiles()).filter((b) => planIds.has(b.planId));
  for (const baseline of legacyBaselines) saveBaseline(baseline);

  // Screenshots recorded when the seed baseline was made. Without these the first
  // heal on a fresh container has no "before" image, which is the half of the heal
  // card that shows what the test was originally looking for.
  const artifacts = await copySeedArtifacts();

  // Proposals for the seeded scenarios, so a fresh container's first repair does not
  // spend a model call against a per-day quota.
  const healCacheEntries = await importSeedHealCache();

  return {
    seeded: true,
    plans: legacyPlans.length,
    baselines: legacyBaselines.length,
    artifacts,
    healCacheEntries,
    orphansReconciled,
  };
}

/** Copies committed screenshots into the writable artifacts root. */
async function copySeedArtifacts(): Promise<number> {
  let copied = 0;

  const walk = async (from: string, to: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(from, { withFileTypes: true });
    } catch {
      return; // no seed artifacts committed
    }

    await fs.mkdir(to, { recursive: true });
    for (const entry of entries) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await walk(source, target);
        continue;
      }
      // Never overwrites. A file already in the writable root was produced by a real
      // run and is more current than anything shipped in the image.
      try {
        await fs.copyFile(source, target, fs.constants?.COPYFILE_EXCL ?? 1);
        copied += 1;
      } catch {
        /* already present */
      }
    }
  };

  await walk(SEED_PATHS.artifacts, PATHS.artifacts);
  return copied;
}

async function importSeedHealCache(): Promise<number> {
  try {
    const raw = await fs.readFile(SEED_PATHS.healCache, 'utf8');
    const entries = JSON.parse(raw) as CacheEntry[];
    if (!Array.isArray(entries)) return 0;
    return importCache(entries);
  } catch {
    return 0; // nothing committed, or unreadable — a warm cache is an optimisation
  }
}
