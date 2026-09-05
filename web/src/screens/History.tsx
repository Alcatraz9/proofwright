import { useState, useMemo } from 'react';
import { api } from '../api/client.ts';
import type { RunStats, RunStatus, RunSummary } from '../api/types.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { Empty, Panel, PanelHeader, Reveal, SectionTitle, Spinner, focusRing, inputClass } from '../components/ui.tsx';
import { Metric, RunStatusChip } from '../components/status.tsx';
import { IconDisclose } from '../components/icons.tsx';
import { ms, percent, when } from '../lib/format.ts';
import { useRouter, Link } from '../lib/router.tsx';

/**
 * History and trends.
 *
 * The charts are hand-drawn SVG rather than a charting dependency. `trend[]`
 * arrives oldest-first and ready to plot, there are four series, and a charting
 * library would be a larger download than the rest of the bundle — which matters
 * on the free tier this deploys to.
 */

// ---------------------------------------------------------------------------
// Chart fills – achromatic register, never colour-alone
// ---------------------------------------------------------------------------

const STATUS_FILL: Record<RunStatus, string> = {
  passed: 'var(--color-read-200)',
  failed: 'var(--color-alarm)',
  needs_review: 'var(--color-signal)',
  cancelled: 'var(--color-rule)',
  error: 'var(--color-alarm)',
  queued: 'var(--color-rule)',
  running: 'var(--color-read-300)',
};

/** Non-colour differentiators for each status — survives greyscale printing. */
const STATUS_PATTERN: Record<RunStatus, string | null> = {
  passed: null, // solid fill — the baseline
  failed: 'pattern-failed', // diagonal hatch
  needs_review: 'pattern-review', // dots
  cancelled: 'pattern-cancelled', // horizontal lines
  error: 'pattern-failed', // same hatch as failed
  queued: null,
  running: null,
};

const STATUS_LABEL: Record<RunStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  needs_review: 'Needs review',
  cancelled: 'Cancelled',
  error: 'Error',
  queued: 'Queued',
  running: 'Running',
};

/** Human-readable legend entries — only statuses that actually appear in charts. */
const LEGEND_ENTRIES: { status: RunStatus; label: string; patternId: string | null }[] = [
  { status: 'passed', label: 'Passed', patternId: null },
  { status: 'failed', label: 'Failed', patternId: 'pattern-failed' },
  { status: 'needs_review', label: 'Needs review', patternId: 'pattern-review' },
  { status: 'cancelled', label: 'Cancelled', patternId: 'pattern-cancelled' },
];

// ---------------------------------------------------------------------------
// Filter types for RunTable
// ---------------------------------------------------------------------------

type VerdictFilter = 'all' | 'passed' | 'failed' | 'needs_review';
type SortColumn = 'plan' | 'verdict' | 'release' | 'steps' | 'heals' | 'llmCalls' | 'duration' | 'started';
type SortDir = 'asc' | 'desc';

function compareRuns(a: RunSummary, b: RunSummary, col: SortColumn, dir: SortDir): number {
  let cmp = 0;
  switch (col) {
    case 'plan':
      cmp = a.planId.localeCompare(b.planId);
      break;
    case 'verdict':
      cmp = a.status.localeCompare(b.status);
      break;
    case 'release':
      cmp = (a.activeVersion ?? '').localeCompare(b.activeVersion ?? '');
      break;
    case 'steps':
      cmp = a.stepsPassed / Math.max(1, a.stepsTotal) - b.stepsPassed / Math.max(1, b.stepsTotal);
      break;
    case 'heals':
      cmp = a.healCount - b.healCount;
      break;
    case 'llmCalls':
      cmp = a.llmCalls - b.llmCalls;
      break;
    case 'duration':
      cmp = (a.durationMs ?? 0) - (b.durationMs ?? 0);
      break;
    case 'started':
      cmp = (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
      break;
  }
  return dir === 'asc' ? cmp : -cmp;
}

/** Build the console URL for a run. */
function runHref(runId: string): string {
  return `/?run=${encodeURIComponent(runId)}`;
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function History() {
  const stats = useAsync(() => api.stats(40), []);
  const runs = useAsync(() => api.runs({ limit: 50 }), []);

  return (
    <div className="flex flex-col gap-4">
      <Reveal className="order-2 lg:order-1">
        <Panel>
          <PanelHeader
            title="Trends"
            subtitle="Across every run this instance has recorded. A fresh container starts empty, because the free-tier filesystem does not survive a restart."
          />
          {stats.loading && !stats.data ? (
            <div className="px-4 py-8">
              <Spinner />
            </div>
          ) : stats.data ? (
            <StatsBody stats={stats.data} />
          ) : (
            <Empty title="No statistics yet" />
          )}
        </Panel>
      </Reveal>

      <Reveal delay={60} className="order-1 lg:order-2">
        <Panel>
          <PanelHeader
            title="All runs"
            subtitle="Opening a run replays it from its stored events, through the same console a live run streams into."
          />
          {runs.loading && !runs.data ? (
            <div className="px-4 py-8">
              <Spinner />
            </div>
          ) : (runs.data ?? []).length === 0 ? (
            <Empty title="No runs recorded" body="Start one from the console." />
          ) : (
            <RunTable runs={runs.data ?? []} />
          )}
        </Panel>
      </Reveal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats body
// ---------------------------------------------------------------------------

function StatsBody({ stats }: { stats: RunStats }) {
  return (
    <div className="space-y-5 px-4 py-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Runs" value={stats.totalRuns} />
        <Metric
          label="Pass rate"
          value={percent(stats.passRate)}
          tone={stats.passRate >= 0.8 ? 'pass' : stats.passRate >= 0.5 ? 'warn' : 'fail'}
          hint="Counts only a clean pass — a run that needed review is not one."
        />
        <Metric label="Heals" value={stats.totalHeals} tone={stats.totalHeals > 0 ? 'heal' : 'neutral'} />
        <Metric
          label="Model calls"
          value={stats.totalLlmCalls}
          tone="accent"
          hint="A cached proposal costs none, which is why a repeated demo is free."
        />
        <Metric label="Avg duration" value={ms(stats.avgDurationMs)} />
        <Metric
          label="Findings"
          value={stats.totalA11yViolations + stats.totalSecurityFindings + stats.totalVisualFindings}
          hint="Accessibility, security and visual, summed across runs."
        />
      </div>

      {stats.trend.length === 0 ? (
        <p className="text-[13px] text-read-300">Nothing to plot yet.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Chart
            title="Verdict over time"
            hint="Oldest first. Height is the run's duration; colour is its verdict."
            trend={stats.trend}
            value={(run) => run.durationMs ?? 0}
            format={(v) => ms(v)}
          />
          <Chart
            title="Heals per run"
            hint="Three is the cap. A run that hits it is reported as needing review, not as a pass."
            trend={stats.trend}
            value={(run) => run.healCount}
            format={(v) => String(v)}
            cap={3}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart legend — maps each status to its fill colour AND pattern swatch
// ---------------------------------------------------------------------------

function ChartLegend({ trend }: { trend: RunStats['trend'] }) {
  const presentStatuses = useMemo(() => {
    const seen = new Set<RunStatus>();
    for (const r of trend) seen.add(r.status);
    return LEGEND_ENTRIES.filter((e) => seen.has(e.status));
  }, [trend]);

  if (presentStatuses.length === 0) return null;

  return (
    <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1" role="list" aria-label="Chart legend">
      {/*
        The pattern definitions live once, in a zero-size svg, rather than inside
        the map. Emitting them per legend item repeated the same ids for every
        status present, and a duplicate id means every `url(#...)` reference in the
        document resolves to whichever one parsed first.

        The patterns are load-bearing rather than decorative: they are what keeps
        the chart legible without relying on fill colour alone.
      */}
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <defs>
          <pattern id="legend-pattern-failed" patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="3" stroke="var(--color-alarm)" strokeWidth="1.5" strokeOpacity="0.7" />
          </pattern>
          <pattern id="legend-pattern-review" patternUnits="userSpaceOnUse" width="4" height="4">
            <circle cx="2" cy="2" r="1" fill="var(--color-signal)" fillOpacity="0.7" />
          </pattern>
          <pattern id="legend-pattern-cancelled" patternUnits="userSpaceOnUse" width="4" height="3">
            <line x1="0" y1="1.5" x2="4" y2="1.5" stroke="var(--color-rule)" strokeWidth="1" strokeOpacity="0.7" />
          </pattern>
        </defs>
      </svg>

      {presentStatuses.map(({ status, label, patternId }) => (
        <span key={status} role="listitem" className="label-cut inline-flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
            <rect x="1" y="1" width="12" height="12" fill={STATUS_FILL[status]} opacity={0.82} />
            {patternId ? <rect x="1" y="1" width="12" height="12" fill={`url(#legend-${patternId})`} /> : null}
          </svg>
          {label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart with a11y data table, legend, Y-axis labels, pattern fills
// ---------------------------------------------------------------------------

function Chart({
  title,
  hint,
  trend,
  value,
  format,
  cap,
}: {
  title: string;
  hint: string;
  trend: RunStats['trend'];
  value: (run: RunStats['trend'][number]) => number;
  format: (value: number) => string;
  cap?: number;
}) {
  const { navigate } = useRouter();
  const values = trend.map(value);
  const peak = Math.max(1, ...values, cap ?? 0);
  const width = 100;
  const height = 38;
  const gap = trend.length > 30 ? 0.4 : 1;
  const barWidth = Math.max(0.8, (width - gap * (trend.length - 1)) / trend.length);

  const [dataOpen, setDataOpen] = useState(false);

  const chartDataId = `chart-data-${title.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <div className="border-t border-rule pt-3">
      <SectionTitle>{title}</SectionTitle>

      {/* Chart with Y-axis labels */}
      <div className="mt-2 flex items-stretch gap-2">
        {/* Y-axis labels */}
        <div className="flex shrink-0 flex-col justify-between py-0.5 text-right" aria-hidden="true">
          <span className="mono-figures text-[12px] text-read-300">{format(peak)}</span>
          {cap !== undefined && cap !== peak ? (
            <span className="mono-figures text-[12px] text-signal">{format(cap)}</span>
          ) : null}
          <span className="mono-figures text-[12px] text-read-300">0</span>
        </div>

        {/* Visual chart — decorative for a11y; real data is in the disclosed table */}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="h-24 min-w-0 flex-1 overflow-visible"
        >
          <defs>
            <pattern id="pattern-failed" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-alarm)" strokeWidth="1.5" strokeOpacity="0.6" />
            </pattern>
            <pattern id="pattern-review" patternUnits="userSpaceOnUse" width="5" height="5">
              <circle cx="2.5" cy="2.5" r="1.2" fill="var(--color-signal)" fillOpacity="0.6" />
            </pattern>
            <pattern id="pattern-cancelled" patternUnits="userSpaceOnUse" width="5" height="4">
              <line x1="0" y1="2" x2="5" y2="2" stroke="var(--color-rule)" strokeWidth="1" strokeOpacity="0.6" />
            </pattern>
          </defs>

          {cap !== undefined ? (
            <line
              x1={0}
              x2={width}
              y1={height - (cap / peak) * height}
              y2={height - (cap / peak) * height}
              stroke="var(--color-signal)"
              strokeWidth={0.3}
              strokeDasharray="1.5 1.5"
              opacity={0.7}
            />
          ) : null}

          {trend.map((run, index) => {
            const raw = values[index] ?? 0;
            const barHeight = Math.max(0.6, (raw / peak) * height);
            const patternId = STATUS_PATTERN[run.status];
            const x = index * (barWidth + gap);
            const y = height - barHeight;
            return (
              <g key={run.runId}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  fill={STATUS_FILL[run.status] ?? STATUS_FILL.error}
                  opacity={0.82}
                  className="cursor-pointer transition-opacity hover:opacity-100"
                  onClick={() => navigate(runHref(run.runId))}
                >
                  <title>{`${run.planId} · ${run.status} · ${format(raw)} · ${when(run.startedAt)}`}</title>
                </rect>
                {patternId ? (
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={barHeight}
                    fill={`url(#${patternId})`}
                    className="pointer-events-none"
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      {/* X-axis label */}
      <div className="mt-1 flex justify-between px-0.5" aria-hidden="true">
        <span className="mono-figures text-[12px] text-read-300">{trend.length > 0 ? when(trend[0]!.startedAt) : ''}</span>
        <span className="label-cut">oldest to newest</span>
        <span className="mono-figures text-[12px] text-read-300">{trend.length > 0 ? when(trend[trend.length - 1]!.startedAt) : ''}</span>
      </div>

      {/* Legend */}
      <ChartLegend trend={trend} />

      {/* Data table behind a disclosure */}
      <details className="mt-2 group" id={chartDataId} onToggle={(e) => setDataOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary
          className={`inline-flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-read-300 transition-colors hover:text-read-100 ${focusRing}`}
        >
          <IconDisclose size={12} className="transition-transform group-open:rotate-90" />
          <span className="group-open:hidden">Show the data</span>
          <span className="hidden group-open:inline">Hide the data</span>
        </summary>
        {/*
          Rendered only while open, rather than left to the browser to hide.
          A closed <details> hides its content with `content-visibility: hidden`,
          which skips painting but *preserves* the subtree's last known geometry —
          so every cell still reports a full-size bounding box and reads to any
          layout probe as sitting on top of whatever is actually on screen. That is
          the same phantom-occlusion trap an `sr-only` table set here before, in a
          different costume. Not rendering it is the only way the geometry is
          honestly absent.
        */}
        {dataOpen ? (
        <div className="mt-2" role="region" aria-label={`${title} data`}>
          <table className="w-full text-left text-[12px]" aria-label={`${title} data table`}>
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-rule text-read-300">
                <th scope="col" className="label-cut py-1.5 pr-3 font-normal">Plan</th>
                <th scope="col" className="label-cut py-1.5 pr-3 font-normal">Status</th>
                <th scope="col" className="label-cut py-1.5 pr-3 font-normal">Value</th>
                <th scope="col" className="label-cut py-1.5 font-normal">Started</th>
              </tr>
            </thead>
            <tbody>
              {trend.map((run, index) => (
                <tr key={run.runId} className="border-t border-rule">
                  <td className="py-1.5 pr-3">
                    <Link
                      to={runHref(run.runId)}
                      className={`text-read-200 underline decoration-rule underline-offset-2 hover:text-read-100 hover:decoration-signal ${focusRing}`}
                    >
                      {run.planId}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3 text-read-200">{STATUS_LABEL[run.status] ?? run.status}</td>
                  <td className="mono-figures py-1.5 pr-3 text-read-200">{format(values[index] ?? 0)}</td>
                  <td className="mono-figures py-1.5 text-read-300">{when(run.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        ) : null}
      </details>

      <p className="measure mt-2 text-[12px] leading-snug text-read-300">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sort indicator arrow (authored SVG, not unicode)
// ---------------------------------------------------------------------------

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="ml-1 text-read-300">
        <path d="M8 3l3 4H5z" fill="currentColor" opacity="0.5" />
        <path d="M8 13l3-4H5z" fill="currentColor" opacity="0.5" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="ml-1 text-signal">
      {dir === 'asc' ? (
        <path d="M8 3l4 5H4z" fill="currentColor" />
      ) : (
        <path d="M8 13l4-5H4z" fill="currentColor" />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------

function RunTable({ runs }: { runs: RunSummary[] }) {
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [versionFilter, setVersionFilter] = useState<string>('all');
  const [planFilter, setPlanFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<SortColumn>('started');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const versions = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) {
      if (r.activeVersion) set.add(r.activeVersion);
    }
    return Array.from(set).sort();
  }, [runs]);

  const plans = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) set.add(r.planId);
    return Array.from(set).sort();
  }, [runs]);

  const filtered = useMemo(() => {
    let result = runs;
    if (verdictFilter !== 'all') {
      result = result.filter((r) => r.status === verdictFilter);
    }
    if (versionFilter !== 'all') {
      result = result.filter((r) => r.activeVersion === versionFilter);
    }
    if (planFilter !== 'all') {
      result = result.filter((r) => r.planId === planFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (r) => r.runId.toLowerCase().includes(q) || r.planId.toLowerCase().includes(q),
      );
    }
    return [...result].sort((a, b) => compareRuns(a, b, sortCol, sortDir));
  }, [runs, verdictFilter, versionFilter, planFilter, searchQuery, sortCol, sortDir]);

  function toggleSort(col: SortColumn) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir(col === 'started' ? 'desc' : 'asc');
    }
  }

  const hasActiveFilter =
    verdictFilter !== 'all' || versionFilter !== 'all' || planFilter !== 'all' || searchQuery.trim() !== '';

  function clearAll() {
    setVerdictFilter('all');
    setVersionFilter('all');
    setPlanFilter('all');
    setSearchQuery('');
  }

  const filterControls = (
    <>
      {/* Text search */}
      <input
        type="search"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search run id or plan…"
        aria-label="Search runs by id or plan"
        className={`${inputClass} max-w-[14rem] !py-1.5 !text-[12px]`}
      />

      {/* Verdict filter chips */}
      {(
        [
          { key: 'all' as const, label: 'All' },
          { key: 'passed' as const, label: 'Passed' },
          { key: 'failed' as const, label: 'Failed' },
          { key: 'needs_review' as const, label: 'Needs review' },
        ] as const
      ).map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => setVerdictFilter(key)}
          className={`label-cut rounded-plate border px-2.5 py-1.5 transition-colors ${focusRing} ${
            verdictFilter === key
              ? 'border-signal bg-signal/15 text-signal'
              : 'border-rule bg-plate-000 text-read-300 hover:border-rule-strong hover:text-read-200'
          }`}
        >
          {label}
        </button>
      ))}

      {/* Version dropdown */}
      {versions.length > 1 ? (
        <select
          value={versionFilter}
          onChange={(e) => setVersionFilter(e.target.value)}
          aria-label="Filter by release version"
          className={`rounded-plate border border-rule bg-plate-000 px-2 py-1.5 text-[12px] text-read-200 ${focusRing}`}
        >
          <option value="all">All versions</option>
          {versions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : null}

      {/* Plan dropdown */}
      {plans.length > 1 ? (
        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value)}
          aria-label="Filter by plan"
          className={`rounded-plate border border-rule bg-plate-000 px-2 py-1.5 text-[12px] text-read-200 ${focusRing}`}
        >
          <option value="all">All plans</option>
          {plans.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      ) : null}

      {hasActiveFilter ? (
        <button
          type="button"
          onClick={clearAll}
          className={`label-cut text-read-300 hover:text-read-100 ${focusRing}`}
        >
          Clear filters
        </button>
      ) : null}
    </>
  );

  return (
    <div>
      {/*
        One filter bar, one list, one count.
        This screen previously rendered each of those twice — an always-visible bar
        plus a collapsible one, a table plus a card list, and two summaries — which
        is the defect that has already been fixed three times on the Releases screen
        and reappeared here. Two trees for one dataset drift apart, and the drift is
        invisible until someone looks at the width they do not work at.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-3">
        <span className="label-cut">Filter</span>
        {filterControls}
        {hasActiveFilter ? (
          <span className="mono-figures ml-auto text-[12px] text-read-300">
            {filtered.length} of {runs.length}
          </span>
        ) : null}
      </div>

      {/*
        One table, scrolling within its own wrapper on a narrow viewport rather than
        being replaced by a second layout. Eight columns of counts and durations
        genuinely are tabular data — the row and column relationships are what a
        screen reader needs, and column alignment is what makes the set scannable —
        so the table is kept and the overflow is confined to this element. The page
        itself never scrolls sideways.
      */}
      <div className="overflow-x-auto">
        <table
          id="run-history-table"
          aria-label="Run history"
          className="w-full min-w-[44rem] text-left text-[13px]"
        >
          <thead>
            <tr className="border-b border-rule">
              {(
                [
                  { col: 'plan' as const, label: 'Run', align: '' },
                  { col: 'verdict' as const, label: 'Verdict', align: '' },
                  { col: 'release' as const, label: 'Release', align: '' },
                  { col: 'steps' as const, label: 'Steps', align: 'text-right' },
                  { col: 'heals' as const, label: 'Repairs', align: 'text-right' },
                  { col: 'llmCalls' as const, label: 'Model calls', align: 'text-right' },
                  { col: 'duration' as const, label: 'Duration', align: 'text-right' },
                  { col: 'started' as const, label: 'Started', align: 'text-right' },
                ] as const
              ).map(({ col, label, align }, i) => (
                <th
                  key={col}
                  scope="col"
                  aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={`${i === 0 ? 'px-4' : 'px-3'} ${i === 7 ? 'pr-4' : ''} py-2.5 ${align}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col)}
                    className={`label-cut -mx-1 inline-flex items-center gap-0.5 px-1 ${focusRing}`}
                  >
                    {label}
                    <SortArrow active={sortCol === col} dir={sortDir} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-[13px] text-read-300">
                  No runs match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((run) => (
                <tr key={run.runId} className="border-t border-rule transition-colors hover:bg-plate-200/40">
                  <td className="px-4 py-2.5">
                    {/* A real link, so the row is reachable and activatable by keyboard.
                        The desktop table here previously used a click handler on the
                        row with no tabIndex, which made the wide layout less
                        accessible than the narrow one. */}
                    <Link to={runHref(run.runId)} className={`block ${focusRing}`}>
                      <span className="block text-[13px] font-semibold text-read-100">{run.planId}</span>
                      <span className="mono-figures block text-[12px] text-read-300">{run.runId}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <RunStatusChip status={run.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    {run.activeVersion ? (
                      <span className="label-cut text-signal">{run.activeVersion}</span>
                    ) : (
                      <span className="text-read-300">—</span>
                    )}
                  </td>
                  <td className="mono-figures px-3 py-2.5 text-right text-read-200">
                    {run.stepsPassed}/{run.stepsTotal}
                  </td>
                  <td className="mono-figures px-3 py-2.5 text-right">
                    <span className={run.healCount > 0 ? 'text-read-100' : 'text-read-300'}>{run.healCount}</span>
                  </td>
                  <td className="mono-figures px-3 py-2.5 text-right text-read-300">{run.llmCalls}</td>
                  <td className="mono-figures px-3 py-2.5 text-right text-read-300">{ms(run.durationMs)}</td>
                  <td className="mono-figures px-3 py-2.5 pr-4 text-right text-read-300">{when(run.startedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
