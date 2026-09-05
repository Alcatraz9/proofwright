import fs from 'node:fs/promises';
import { SEED_PATHS } from '../config.js';
import { exportCache } from '../store/heal-cache.js';

/**
 * Writes the current heal-proposal cache out as committable seed data.
 *
 *   npm run export:cache
 *
 * Run this after exercising the heal scenarios once, then commit the file. A fresh
 * container then repairs the seeded scenarios without a model call, which matters
 * because free-tier quota is counted per day and a demonstration is shown repeatedly.
 *
 * This commits model output, which is only honest because a proposal is a suggestion:
 * the candidate is still executed against the live page and still judged by the step's
 * original recorded outcome, and every run reports whether its proposal was cached.
 */
async function main(): Promise<void> {
  const entries = exportCache();
  if (entries.length === 0) {
    console.log('The cache is empty. Run the heal scenarios first, then export.');
    return;
  }

  await fs.writeFile(SEED_PATHS.healCache, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${entries.length} cached proposal(s) to ${SEED_PATHS.healCache}`);
  for (const entry of entries) {
    const best = entry.proposal.candidates[0];
    console.log(
      `  ${entry.signature.slice(0, 12)}  ${entry.proposal.candidates.length} candidate(s)` +
        `${best ? `  best: ${best.identity} @ ${best.confidence}` : '  (none — a correct "nothing serves this" answer)'}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
