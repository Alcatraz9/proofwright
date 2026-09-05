import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * One fetch, re-runnable.
 *
 * `deps` drives refetching and `reload` forces it — which the screens need after
 * every mutation, because approving a plan, switching a release or reverting a
 * heal all change state the server owns and this client deliberately does not
 * mirror. Refetching is cheaper than keeping a second copy of the truth honest.
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Kept in a ref so an inline closure passed as `fetcher` does not restart the
  // effect on every render.
  const latest = useRef(fetcher);
  latest.current = fetcher;

  useEffect(() => {
    let live = true;
    setLoading(true);
    latest
      .current()
      .then((value) => {
        if (live) {
          setData(value);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);
  return { data, loading, error, reload };
}

/** Re-runs `reload` on an interval. Used only where the server state can change
 * without this client having asked — the queue, and the active release. */
export function usePoll(reload: () => void, intervalMs: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(reload, intervalMs);
    return () => window.clearInterval(timer);
  }, [reload, intervalMs, enabled]);
}
