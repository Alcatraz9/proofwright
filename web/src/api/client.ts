import type {
  FixtureState,
  Health,
  IntentPlan,
  PlanRecord,
  PlanSummary,
  BaselineView,
  RunDetail,
  RunStats,
  RunSummary,
  StartedRun,
  FaultKind,
  Mission,
  MissionMode,
  MissionStatus,
  MissionSummary,
  QualityReport,
  StartedMission,
} from './types.ts';

/**
 * Every call is same-origin. In development Vite proxies `/api` through to the
 * Node process; in the container the Node process serves both. Nothing here
 * needs a base URL, and there is no CORS to configure.
 */

export interface ApiError extends Error {
  status: number;
  /** Populated when a plan edit fails schema validation. */
  issues?: { path: string; message: string }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const detail = body as { error?: string; issues?: { path: string; message: string }[] } | null;
    const err = new Error(detail?.error ?? `${res.status} ${res.statusText}`) as ApiError;
    err.status = res.status;
    if (detail?.issues) err.issues = detail.issues;
    throw err;
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/api/health'),

  // ---- the application under test ---------------------------------------

  fixture: () => request<FixtureState>('/api/fixture'),

  /** The demo control: same URL, same recorded test, a different UI underneath. */
  setVersion: (version: string) =>
    request<{ activeVersion: string }>('/api/fixture/version', {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),

  setFault: (kind: FaultKind, on: boolean) =>
    request<{ faults: Record<FaultKind, boolean> }>('/api/fixture/fault', {
      method: 'POST',
      body: JSON.stringify({ kind, on }),
    }),

  // ---- plans -------------------------------------------------------------

  plans: () => request<{ plans: PlanSummary[] }>('/api/plans').then((r) => r.plans),

  plan: (planId: string) =>
    request<{ plan: PlanRecord; baseline: BaselineView | null; runs: RunSummary[] }>(
      `/api/plans/${encodeURIComponent(planId)}`,
    ),

  /** Returns 400 with `issues[]` when the edited plan violates the schema. */
  savePlan: (planId: string, plan: IntentPlan) =>
    request<{ plan: PlanRecord }>(`/api/plans/${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ plan }),
    }).then((r) => r.plan),

  approve: (planId: string) =>
    request<{ plan: PlanRecord }>(`/api/plans/${encodeURIComponent(planId)}/approve`, {
      method: 'POST',
    }).then((r) => r.plan),

  unapprove: (planId: string) =>
    request<{ plan: PlanRecord }>(`/api/plans/${encodeURIComponent(planId)}/unapprove`, {
      method: 'POST',
    }).then((r) => r.plan),

  // ---- baselines ---------------------------------------------------------

  revertHeal: (planId: string, stepId: string) =>
    request<{ reverted: boolean; reason?: string }>(
      `/api/baselines/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/revert`,
      { method: 'POST' },
    ),

  // ---- runs --------------------------------------------------------------

  runs: (params: { planId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.planId) query.set('planId', params.planId);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.size > 0 ? `?${query}` : '';
    return request<{ runs: RunSummary[] }>(`/api/runs${suffix}`).then((r) => r.runs);
  },

  run: (runId: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),

  startRun: (body: { planId: string; heal?: boolean; threshold?: number; strictVisual?: boolean }) =>
    request<StartedRun>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),

  cancelRun: (runId: string) =>
    request<{ cancelled: boolean }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),

  stats: (limit = 30) => request<RunStats>(`/api/stats?limit=${limit}`),

  // -------------------------------------------------------------------------
  // Missions
  // -------------------------------------------------------------------------

  missions: (limit = 20) =>
    request<{ missions: MissionSummary[] }>(`/api/missions?limit=${limit}`).then((r) => r.missions),

  mission: (missionId: string) =>
    request<Mission>(`/api/missions/${encodeURIComponent(missionId)}`),

  startMission: (body: {
    targetUrl: string;
    instruction?: string;
    prd?: string;
    mode?: MissionMode;
    credentials?: { TEST_EMAIL: string; TEST_PASSWORD: string };
  }) => request<StartedMission>('/api/missions', { method: 'POST', body: JSON.stringify(body) }),

  cancelMission: (missionId: string) =>
    request<{ missionId: string; status: MissionStatus }>(
      `/api/missions/${encodeURIComponent(missionId)}/cancel`,
      { method: 'POST' },
    ),

  /**
   * The report is enveloped by the server, and unwrapped here so no caller has to
   * know that. `createdAt` is dropped: the report carries its own `generatedAt`.
   */
  report: (missionId: string) =>
    request<{ report: QualityReport; createdAt: string }>(
      `/api/missions/${encodeURIComponent(missionId)}/report`,
    ).then((r) => r.report),

  /** The markdown path, for the export control. Not fetched — handed to the browser. */
  reportMarkdownUrl: (missionId: string) =>
    `/api/missions/${encodeURIComponent(missionId)}/report.md`,
};
