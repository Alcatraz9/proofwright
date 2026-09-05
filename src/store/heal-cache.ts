import { createHash } from 'node:crypto';
import { execute, nowIso, queryAll, queryOne } from './db.js';
import type { HealProposal } from '../heal/types.js';
import type { Fingerprint, Locator } from '../baseline/types.js';

/**
 * Remembers what the model proposed for a given failure.
 *
 * The distinction that makes this safe: a proposal is a *suggestion*. Every
 * cached proposal is still resolved to a locator against the live page, still
 * executed, and still judged by the step's original recorded outcome. Reusing one
 * therefore cannot turn a wrong heal into a passing test — it only avoids asking
 * an identical question twice.
 *
 * The motivation is quota. Free-tier limits are counted per day, and a demo shows
 * the same heal repeatedly; without this, a later showing fails for want of quota
 * rather than for any reason in the software. It also makes a demonstration
 * reproducible, which a live model call is not.
 */

export interface CachedProposal {
  proposal: HealProposal;
  model: string;
  createdAt: string;
  hits: number;
}

/**
 * A candidate as stored, identified by something that outlives the session.
 *
 * The proposal itself names elements by the extractor's `ref`, which is assigned
 * per extraction pass — `s1e12` means the twelfth element of the first pass and
 * nothing more. Caching that verbatim produced a cache that hit and then resolved
 * to nothing, because the refs on the next run were different: the heal was
 * reported as unlocatable while the element sat on the page under a new handle.
 *
 * So the identity is stored beside the ref and the ref is re-derived from the live
 * snapshot on a hit.
 */
export interface StoredCandidate {
  identity: string;
  confidence: number;
  reason: string;
}

export interface StoredProposal {
  candidates: StoredCandidate[];
  reason: string;
}

/** Role, accessible name and test id: enough to find the same element again. */
export function candidateIdentity(element: {
  role: string;
  accessibleName: string;
  testId: string | null;
  tagName: string;
}): string {
  return [element.role, element.accessibleName, element.testId ?? '', element.tagName].join('|');
}

/**
 * A signature for "this failure, on this page".
 *
 * Built from the intent, the action, the locator that broke, the fingerprint of
 * what used to be there, and the identity of every element currently on the page.
 * Element *identities* rather than the raw snapshot, because refs are assigned per
 * extraction pass and would make every run a cache miss.
 *
 * Page content is included on purpose. If the page has changed, the previous
 * answer may no longer be the right one, and a stale hit would be worse than a
 * miss.
 */
export function healSignature(params: {
  intent: string;
  action: string;
  staleLocator: Locator;
  fingerprint: Fingerprint;
  elementKeys: string[];
}): string {
  const material = JSON.stringify({
    intent: params.intent,
    action: params.action,
    stale: params.staleLocator,
    was: {
      role: params.fingerprint.role,
      name: params.fingerprint.accessibleName,
      tag: params.fingerprint.tagName,
      testId: params.fingerprint.testId,
      id: params.fingerprint.id,
    },
    page: [...params.elementKeys].sort(),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Reads a cached proposal and re-binds it to the elements on the page now.
 *
 * A stored candidate whose identity is no longer present is dropped rather than
 * guessed at. If that empties the candidate list the caller is given a miss, so
 * the model is asked afresh instead of the run being told there was nothing to
 * suggest — a cache that can silently turn a real answer into "no candidate" would
 * be worse than no cache.
 */
export function readCachedProposal(
  signature: string,
  liveElements: { ref: string; role: string; accessibleName: string; testId: string | null; tagName: string }[],
): CachedProposal | null {
  const row = queryOne<{
    proposal_json: string;
    model: string;
    created_at: string;
    hits: number;
  }>('SELECT proposal_json, model, created_at, hits FROM heal_cache WHERE signature = ?', signature);
  if (!row) return null;

  const stored = JSON.parse(row.proposal_json) as StoredProposal;
  const byIdentity = new Map(liveElements.map((element) => [candidateIdentity(element), element.ref]));

  const candidates = stored.candidates
    .map((candidate) => {
      const ref = byIdentity.get(candidate.identity);
      return ref ? { ref, confidence: candidate.confidence, reason: candidate.reason } : null;
    })
    .filter((candidate): candidate is { ref: string; confidence: number; reason: string } =>
      candidate !== null,
    );

  // An entry that recorded "nothing serves this intent" is still a valid answer and
  // is worth reusing; an entry that had candidates but can no longer place any of
  // them is not.
  if (candidates.length === 0 && stored.candidates.length > 0) return null;

  execute('UPDATE heal_cache SET hits = hits + 1 WHERE signature = ?', signature);

  return {
    proposal: { candidates, reason: stored.reason },
    model: row.model,
    createdAt: row.created_at,
    hits: row.hits + 1,
  };
}

export function writeCachedProposal(
  signature: string,
  proposal: HealProposal,
  model: string,
  liveElements: { ref: string; role: string; accessibleName: string; testId: string | null; tagName: string }[],
): void {
  const byRef = new Map(liveElements.map((element) => [element.ref, element]));

  const stored: StoredProposal = {
    reason: proposal.reason,
    candidates: proposal.candidates
      .map((candidate) => {
        const element = byRef.get(candidate.ref);
        return element
          ? {
              identity: candidateIdentity(element),
              confidence: candidate.confidence,
              reason: candidate.reason,
            }
          : null;
      })
      .filter((candidate): candidate is StoredCandidate => candidate !== null),
  };

  execute(
    `INSERT INTO heal_cache (signature, proposal_json, model, created_at, hits)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(signature) DO UPDATE SET
       proposal_json = excluded.proposal_json,
       model         = excluded.model,
       created_at    = excluded.created_at`,
    signature,
    JSON.stringify(stored),
    model,
    nowIso(),
  );
}

export interface CacheEntry {
  signature: string;
  proposal: StoredProposal;
  model: string;
}

/** Every entry, for committing as seed data. */
export function exportCache(): CacheEntry[] {
  return queryAll<{ signature: string; proposal_json: string; model: string }>(
    'SELECT signature, proposal_json, model FROM heal_cache ORDER BY signature',
  ).map((row) => ({
    signature: row.signature,
    proposal: JSON.parse(row.proposal_json) as StoredProposal,
    model: row.model,
  }));
}

/**
 * Loads committed entries into an empty cache.
 *
 * Safe because a signature includes the identity of every element on the failing
 * page: if the fixture changes, the signature changes, the entry misses, and the
 * model is asked afresh. A stale seed cannot produce a wrong repair — and could not
 * even if it hit, since the candidate is still executed and still judged by the
 * step's original recorded outcome.
 */
export function importCache(entries: CacheEntry[]): number {
  let written = 0;
  for (const entry of entries) {
    execute(
      `INSERT INTO heal_cache (signature, proposal_json, model, created_at, hits)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(signature) DO NOTHING`,
      entry.signature,
      JSON.stringify(entry.proposal),
      entry.model,
      nowIso(),
    );
    written += 1;
  }
  return written;
}

export function cacheStats(): { entries: number; hits: number } {
  const row = queryOne<{ entries: number; hits: number }>(
    'SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM heal_cache',
  );
  return row ?? { entries: 0, hits: 0 };
}
