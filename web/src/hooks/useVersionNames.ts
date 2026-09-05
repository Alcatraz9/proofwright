import { useMemo } from 'react';
import { api } from '../api/client.ts';
import { useAsync } from './useAsync.ts';

/**
 * Fetches the fixture version list once, and returns a lookup function that
 * resolves a bare version id (e.g. "v4") to its human display name
 * (e.g. "redesign"). Returns the id unchanged when no match exists.
 *
 * The fixture endpoint is lightweight (<1 KB) and already polled by the App
 * shell header, so caching at the HTTP layer keeps this effectively free.
 */
export function useVersionNames(): (versionId: string | null | undefined) => string {
  const fixture = useAsync(() => api.fixture(), []);

  const nameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (fixture.data) {
      for (const v of fixture.data.versions) {
        map.set(v.id, v.displayName);
      }
    }
    return map;
  }, [fixture.data]);

  return (versionId: string | null | undefined): string => {
    if (!versionId) return '—';
    const name = nameMap.get(versionId);
    if (!name) return versionId;
    // The fixture's displayName already carries the id ("v1 — legacy"), so
    // prefixing it produced "v1 v1 — legacy" everywhere a run was listed. Only
    // prefix when the name does not already identify the release itself.
    return name.startsWith(versionId) ? name : `${versionId} — ${name}`;
  };
}
