import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Forty lines instead of a routing dependency.
 *
 * There are four screens and one optional query parameter. A router library
 * would be more code in the bundle than the whole feature, and the free-tier
 * container is the constraint that makes that worth caring about. The Node static
 * handler serves `index.html` for any unmatched path, so deep links work.
 */

export interface Route {
  path: string;
  query: URLSearchParams;
}

interface RouterValue extends Route {
  navigate: (to: string, options?: { replace?: boolean }) => void;
  setQuery: (updates: Record<string, string | null>, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentRoute(): Route {
  return {
    path: window.location.pathname.replace(/\/+$/, '') || '/',
    query: new URLSearchParams(window.location.search),
  };
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPop = (): void => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    if (options?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setRoute(currentRoute());
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const setQuery = useCallback(
    (updates: Record<string, string | null>, options?: { replace?: boolean }) => {
      const query = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) query.delete(key);
        else query.set(key, value);
      }
      const search = query.size > 0 ? `?${query}` : '';
      const to = `${window.location.pathname}${search}`;
      // Query changes replace by default: opening a different run should not
      // bury the previous one in the back stack.
      if (options?.replace === false) window.history.pushState(null, '', to);
      else window.history.replaceState(null, '', to);
      setRoute(currentRoute());
    },
    [],
  );

  const value = useMemo<RouterValue>(() => ({ ...route, navigate, setQuery }), [route, navigate, setQuery]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter must be used inside RouterProvider.');
  return value;
}

export function Link({
  to,
  children,
  className = '',
  title,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      title={title}
      className={className}
      onClick={(event) => {
        // Modified clicks and middle clicks keep their native meaning: opening
        // two releases in two tabs is something the demo asks people to do.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
