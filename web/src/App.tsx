import { useRef, useState } from 'react';
import { api } from './api/client.ts';
import { useAsync, usePoll } from './hooks/useAsync.ts';
import { useHotkeys, useChordShortcuts, useFocusTrap, type Shortcut, type ChordShortcut } from './hooks/useHotkeys.ts';
import { Console } from './screens/Console.tsx';
import { Missions } from './screens/Missions.tsx';
import { History } from './screens/History.tsx';
import { Plans } from './screens/Plans.tsx';
import { STEP_STATE_STYLE } from './components/status.tsx';
import { CHANNEL_STATES } from './components/StepChannel.tsx';
import { focusRing } from './components/ui.tsx';
import { IconClose, IconRetry } from './components/icons.tsx';
import { useVersionNames } from './hooks/useVersionNames.ts';
import { Link, useRouter } from './lib/router.tsx';

/**
 * Investigations own the front door. The product's promise is "give it a URL",
 * so the URL field is the first thing a visitor meets rather than something
 * found behind a tab switch. Console remains the live-run instrument view, one
 * hop away. Releases is gone: the bundled fixture served development, and the
 * product is pointed at external applications from here on.
 */
const NAV = [
  { to: '/', label: 'Investigations', match: (path: string) => path === '/' || path.startsWith('/missions') },
  { to: '/console', label: 'Console', match: (path: string) => path.startsWith('/console') },
  { to: '/plans', label: 'Plans', match: (path: string) => path.startsWith('/plans') },
  { to: '/history', label: 'History', match: (path: string) => path.startsWith('/history') },
];

export interface AppShortcutActions {
  startRun: () => void;
  cancelRun: () => void;
  toggleHealing: () => void;
}

export function App() {
  const { path, navigate } = useRouter();
  const health = useAsync(() => api.health(), []);
  const versionName = useVersionNames();
  usePoll(health.reload, 6000);

  const busy = (health.data?.queue.active.length ?? 0) + (health.data?.queue.pending.length ?? 0);
  const [helpOpen, setHelpOpen] = useState(false);

  // Return-focus target. Opening help from the keyboard used to leave
  // activeElement on <body>, so focus was lost when it closed.
  const helpButtonRef = useRef<HTMLButtonElement>(null);

  const [actions, setActions] = useState<AppShortcutActions>({
    startRun: () => {},
    cancelRun: () => {},
    toggleHealing: () => {},
  });

  const shortcuts: Shortcut[] = [
    { combo: '?', label: 'Open this panel', handler: () => setHelpOpen((prev) => !prev) },
    {
      combo: 'Escape',
      label: 'Close overlay',
      handler: () => {
        if (helpOpen) setHelpOpen(false);
        else return false;
      },
    },
    {
      combo: 'Ctrl+Enter',
      label: 'Replay the armed specification',
      handler: () => {
        if (!path.startsWith('/console')) navigate('/console');
        actions.startRun();
      },
      activeOn: ['/console'],
    },
    { combo: 'Ctrl+.', label: 'Halt the run in flight', handler: () => actions.cancelRun(), activeOn: ['/console'] },
    { combo: 'Ctrl+H', label: 'Arm or disarm repairs', handler: () => actions.toggleHealing(), activeOn: ['/console'] },
  ];

  const chordShortcuts: ChordShortcut[] = [
    { combo: 'g i', label: 'Investigations', handler: () => navigate('/') },
    { combo: 'g c', label: 'Console', handler: () => navigate('/console') },
    { combo: 'g p', label: 'Plans', handler: () => navigate('/plans') },
    { combo: 'g h', label: 'History', handler: () => navigate('/history') },
  ];

  useHotkeys(shortcuts, path);
  useChordShortcuts(chordShortcuts);

  return (
    <div className="min-h-dvh">
      <a
        href="#readout"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-signal focus:bg-plate-000 focus:px-3 focus:py-2 focus:text-[13px] focus:text-read-100 ${focusRing}`}
      >
        Skip to the readout
      </a>

      <header className="sticky top-0 z-30 border-b border-rule bg-plate-000">
        <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 pb-0 pt-3 sm:px-6">
          <Link to="/" className={`flex items-baseline gap-2.5 ${focusRing}`}>
            <span className="readout text-[17px] font-semibold tracking-[0.02em] text-read-100">EdgeForge</span>
            <span className="hidden text-[13px] text-read-300 sm:inline">Fault attribution for recorded suites</span>
          </Link>

          <div className="ml-auto flex items-center gap-4">
            {health.error ? (
              <span className="flex items-center gap-2">
                <span className="label-cut text-alarm-ink">Instance unreachable</span>
                <button
                  type="button"
                  onClick={() => health.reload()}
                  aria-label="Retry the connection"
                  className={`label-cut inline-flex items-center gap-1.5 border border-alarm/60 px-2 py-1 text-alarm-ink transition-colors hover:border-alarm ${focusRing}`}
                >
                  <IconRetry size={12} />
                  Retry
                </button>
              </span>
            ) : health.data ? (
              <span className="flex items-baseline gap-4">
                <span className="flex items-baseline gap-2">
                  <span className="label-cut">Deployed</span>
                  <span className="mono-figures text-[13px] text-signal">
                    {versionName(health.data.activeVersion)}
                  </span>
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="label-cut">Queue</span>
                  <span className="mono-figures text-[13px] text-read-100">{busy}</span>
                </span>
              </span>
            ) : null}

            <button
              ref={helpButtonRef}
              type="button"
              onClick={() => setHelpOpen((prev) => !prev)}
              aria-label="Legend and keyboard shortcuts"
              title="Legend and keyboard shortcuts (?)"
              className={`label-cut border border-rule px-2 py-1 text-read-200 transition-colors hover:border-signal hover:text-signal ${focusRing}`}
            >
              Legend
            </button>
          </div>

          <nav aria-label="Screens" className="-mb-px flex w-full items-end gap-0 overflow-x-auto">
            {NAV.map((item) => {
              const active = item.match(path);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`label-cut border-b-2 px-3 py-2.5 transition-colors ${focusRing} ${
                    active
                      ? 'border-signal text-read-100'
                      : 'border-transparent text-read-300 hover:border-rule-strong hover:text-read-100'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {health.error ? (
          <p className="measure border-t border-alarm/30 px-4 py-2.5 text-[12px] leading-relaxed text-read-200 sm:px-6">
            The instance is not answering. Check the server process is running and the tunnel is open, then press
            Retry.
          </p>
        ) : null}
      </header>

      <main id="readout" className="mx-auto max-w-[110rem] px-4 py-5 sm:px-6">
        <Screen path={path} onActions={path.startsWith('/console') ? setActions : undefined} />
      </main>

      <footer className="mx-auto max-w-[110rem] px-4 pb-10 pt-5 sm:px-6">
        <p className="measure border-t border-rule pt-3 text-[12px] leading-relaxed text-read-300">
          One process serves this readout, the API, the event stream and the application under test. Press{' '}
          <Key>?</Key> for the legend and shortcuts.
        </p>
      </footer>

      {helpOpen ? (
        <Legend
          shortcuts={shortcuts}
          chordShortcuts={chordShortcuts}
          currentPath={path}
          onClose={() => setHelpOpen(false)}
          returnFocusTo={helpButtonRef}
        />
      ) : null}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mono-figures rounded-plate border border-rule bg-plate-200 px-1.5 py-0.5 text-[12px] text-read-100">
      {children}
    </kbd>
  );
}

function Screen({ path, onActions }: { path: string; onActions?: (actions: AppShortcutActions) => void }) {
  if (path === '/') return <Missions />;
  if (path.startsWith('/missions')) return <Missions />;
  if (path.startsWith('/console')) return <Console onActions={onActions} />;
  if (path.startsWith('/plans')) return <Plans />;
  if (path.startsWith('/history')) return <History />;
  return <NotFound path={path} />;
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="py-16">
      <p className="readout text-[19px] text-read-100">No screen at this path.</p>
      <p className="mono-figures mt-2 text-[13px] text-read-300">{path}</p>
      <Link
        to="/"
        className={`label-cut mt-4 inline-block text-signal underline underline-offset-2 hover:text-signal-ink ${focusRing}`}
      >
        Back to the console
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const RUN_VERDICTS: { term: string; definition: string }[] = [
  { term: 'Pass', definition: 'Every step was found where the baseline said, and every recorded outcome held.' },
  {
    term: 'Failed',
    definition:
      'A step could not be completed. Either the application is at fault, or no replacement could satisfy the recorded outcome.',
  },
  {
    term: 'Held for review',
    definition:
      'The run finished, but something in it rests on judgement rather than on the application confirming it — an unverified repair, or more repairs than a stale locator explains.',
  },
  { term: 'Cancelled', definition: 'Halted before it finished.' },
  {
    term: 'Runner fault',
    definition: 'The harness itself failed. Nothing was established about the test or the application.',
  },
];

function Legend({
  shortcuts,
  chordShortcuts,
  currentPath,
  onClose,
  returnFocusTo,
}: {
  shortcuts: Shortcut[];
  chordShortcuts: ChordShortcut[];
  currentPath: string;
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, returnFocusTo);

  const here: Shortcut[] = [];
  const elsewhere: Shortcut[] = [];
  for (const s of shortcuts) {
    if (s.combo === 'Escape') continue;
    if (!s.activeOn) here.push(s);
    else if (s.activeOn.some((p) => currentPath === p || currentPath.startsWith(`${p}/`))) here.push(s);
    else elsewhere.push(s);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-plate-000/90 px-4 py-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Legend and keyboard shortcuts"
    >
      <div ref={dialogRef} className="w-full max-w-2xl rounded-plate border border-rule-strong bg-plate-100">
        <header className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h2 className="label-cut label-cut-bright">Legend</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`border border-rule p-1.5 text-read-200 transition-colors hover:border-signal hover:text-signal ${focusRing}`}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="space-y-6 px-4 py-4">
          <p className="measure text-[13px] leading-relaxed text-read-200">
            EdgeForge replays a recorded specification against a live application and asks one question of every
            failure: was the element not found, or was the result not what was recorded? The first is a stale test
            and is repaired. The second is the application, and is escalated — never repaired.
          </p>

          {/* The channel marks, shown as the marks themselves. A legend that
              describes a symbol without drawing it is a legend for a different page. */}
          <section>
            <h3 className="label-cut border-b border-rule pb-1.5">Channel marks</h3>
            <dl className="mt-3 space-y-3">
              {CHANNEL_STATES.map((state) => {
                const style = STEP_STATE_STYLE[state];
                const Mark = style.mark;
                const register = {
                  quiet: 'text-read-200',
                  stated: 'text-read-100',
                  attention: 'text-signal',
                  fault: 'text-alarm-ink',
                  dim: 'text-read-300',
                }[style.register];
                return (
                  <div key={state} className="flex gap-3">
                    <span className={`mt-0.5 shrink-0 ${register}`}>
                      <Mark size={16} />
                    </span>
                    <dt className={`w-32 shrink-0 text-[13px] font-semibold ${register}`}>{style.label}</dt>
                    <dd className="measure text-[12px] leading-relaxed text-read-300">{style.note}</dd>
                  </div>
                );
              })}
            </dl>
          </section>

          <section>
            <h3 className="label-cut border-b border-rule pb-1.5">Run verdicts</h3>
            <dl className="mt-3 space-y-3">
              {RUN_VERDICTS.map((entry) => (
                <div key={entry.term} className="flex gap-3">
                  <dt className="w-32 shrink-0 text-[13px] font-semibold text-read-100">{entry.term}</dt>
                  <dd className="measure text-[12px] leading-relaxed text-read-300">{entry.definition}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section>
            <h3 className="label-cut border-b border-rule pb-1.5">Keys</h3>
            <ul className="mt-3 space-y-2">
              {here.map((s) => (
                <li key={s.combo} className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-read-200">{s.label}</span>
                  <Key>{s.combo}</Key>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] text-read-200">Close overlay</span>
                <Key>Escape</Key>
              </li>
              {chordShortcuts.map((s) => (
                <li key={s.combo} className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-read-200">Go to {s.label}</span>
                  <span className="flex shrink-0 items-baseline gap-1">
                    {s.combo.split(' ').map((k) => (
                      <Key key={k}>{k}</Key>
                    ))}
                  </span>
                </li>
              ))}
              {elsewhere.map((s) => (
                <li key={s.combo} className="flex items-baseline justify-between gap-3 opacity-60">
                  <span className="text-[13px] text-read-300">{s.label} — console only</span>
                  <Key>{s.combo}</Key>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
