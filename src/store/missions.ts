import { execute, nowIso, queryAll, queryOne } from './db.js';
import { formCount, type SiteMap } from '../explore/types.js';
import type {
  CoverageRound,
  Decision,
  Mission,
  MissionMode,
  MissionStatus,
  MissionSummary,
  Stage,
} from '../orchestrator/types.js';

interface Row {
  mission_id: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  status: string;
  mode: string;
  stage: string | null;
  target_url: string;
  instruction: string | null;
  prd: string | null;
  plan_id: string | null;
  run_id: string | null;
  decisions_json: string;
  site_map_json: string | null;
  coverage_rounds_json: string;
  error: string | null;
}

function toMission(row: Row): Mission {
  return {
    missionId: row.mission_id,
    status: row.status as MissionStatus,
    mode: row.mode as MissionMode,
    stage: (row.stage as Stage | null) ?? null,
    targetUrl: row.target_url,
    instruction: row.instruction,
    prd: row.prd,
    planId: row.plan_id,
    runId: row.run_id,
    decisions: JSON.parse(row.decisions_json) as Decision[],
    siteMap: row.site_map_json ? (JSON.parse(row.site_map_json) as SiteMap) : null,
    coverageRounds: JSON.parse(row.coverage_rounds_json ?? '[]') as CoverageRound[],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function createMission(params: {
  missionId: string;
  mode: MissionMode;
  targetUrl: string;
  instruction: string | null;
  prd?: string | null;
}): Mission {
  const at = nowIso();
  execute(
    `INSERT INTO missions (mission_id, created_at, updated_at, status, mode, stage, target_url, instruction, prd, decisions_json)
     VALUES (?, ?, ?, 'queued', ?, NULL, ?, ?, ?, '[]')`,
    params.missionId,
    at,
    at,
    params.mode,
    params.targetUrl,
    params.instruction,
    params.prd ?? null,
  );
  return loadMission(params.missionId)!;
}

export function loadMission(missionId: string): Mission | null {
  const row = queryOne<Row>('SELECT * FROM missions WHERE mission_id = ?', missionId);
  return row ? toMission(row) : null;
}

export function listMissions(limit = 20): MissionSummary[] {
  return queryAll<Row>(
    'SELECT * FROM missions ORDER BY created_at DESC LIMIT ?',
    Math.max(1, Math.min(limit, 200)),
  ).map((row) => {
    const { decisions, siteMap, ...rest } = toMission(row);
    return {
      ...rest,
      decisionCount: decisions.length,
      pageCount: siteMap ? siteMap.pages.length : 0,
      formCount: siteMap ? formCount(siteMap) : 0,
    };
  });
}

/**
 * Keep what the crawl saw.
 *
 * Written once, after the explore stage, rather than accumulated: the crawler
 * produces the whole map in one pass and a half-written map would be worse than
 * none, because a reader cannot tell a partial map from a small application.
 */
export function saveSiteMap(missionId: string, siteMap: SiteMap): void {
  execute(
    'UPDATE missions SET site_map_json = ?, updated_at = ? WHERE mission_id = ?',
    JSON.stringify(siteMap),
    nowIso(),
    missionId,
  );
}

/**
 * Append one coverage reading.
 *
 * Same read-modify-write as the decision log and for the same reason: a mission
 * that dies mid-flight is when the series matters most, and the queue serialises
 * missions so there is no writer to race.
 */
export function appendCoverageRound(missionId: string, round: CoverageRound): void {
  const current = loadMission(missionId);
  if (!current) return;
  execute(
    'UPDATE missions SET coverage_rounds_json = ?, updated_at = ? WHERE mission_id = ?',
    JSON.stringify([...current.coverageRounds, round]),
    nowIso(),
    missionId,
  );
}

export function setMissionStage(missionId: string, stage: Stage): void {
  execute(
    `UPDATE missions SET stage = ?, status = 'running', updated_at = ? WHERE mission_id = ?`,
    stage,
    nowIso(),
    missionId,
  );
}

/**
 * Appended one at a time rather than written once at the end.
 *
 * A mission that dies mid-flight is exactly when the decision log matters most,
 * so it is durable as it goes. Read-modify-write on a JSON column is not how a
 * production system would store an append-only log, but missions are serialised
 * by the queue and the alternative is a second table for a hackathon.
 */
export function appendDecision(missionId: string, decision: Decision): void {
  const current = loadMission(missionId);
  if (!current) return;
  const decisions = [...current.decisions, decision];
  execute(
    'UPDATE missions SET decisions_json = ?, updated_at = ? WHERE mission_id = ?',
    JSON.stringify(decisions),
    nowIso(),
    missionId,
  );
}

/**
 * Correct the most recent reading's `followedBy`.
 *
 * A reading is written the moment it is taken, so the interface can show it while
 * a re-plan that may take half a minute is still in flight. Only one transition is
 * not knowable at that moment — whether the re-plan succeeds — so that one is
 * written optimistically and amended here if it does not.
 */
export function amendLastCoverageRound(
  missionId: string,
  followedBy: CoverageRound['followedBy'],
): void {
  const current = loadMission(missionId);
  if (!current || !current.coverageRounds.length) return;
  const rounds = [...current.coverageRounds];
  const last = rounds[rounds.length - 1];
  if (!last) return;
  rounds[rounds.length - 1] = { ...last, followedBy };
  execute(
    'UPDATE missions SET coverage_rounds_json = ?, updated_at = ? WHERE mission_id = ?',
    JSON.stringify(rounds),
    nowIso(),
    missionId,
  );
}

export function attachPlan(missionId: string, planId: string): void {
  execute(
    'UPDATE missions SET plan_id = ?, updated_at = ? WHERE mission_id = ?',
    planId,
    nowIso(),
    missionId,
  );
}

export function attachRun(missionId: string, runId: string): void {
  execute(
    'UPDATE missions SET run_id = ?, updated_at = ? WHERE mission_id = ?',
    runId,
    nowIso(),
    missionId,
  );
}

export function finishMission(
  missionId: string,
  status: MissionStatus,
  error: string | null = null,
): void {
  const at = nowIso();
  execute(
    'UPDATE missions SET status = ?, error = ?, updated_at = ?, finished_at = ? WHERE mission_id = ?',
    status,
    error,
    at,
    at,
    missionId,
  );
}

/**
 * A mission whose process died is not still running, whatever the row says.
 *
 * The same reconciliation the runs and jobs tables do on boot, for the same
 * reason: an in-memory queue cannot survive a restart, so a row left `running`
 * is a lie the next reader would believe.
 */
export function reconcileOrphanedMissions(): number {
  return execute(
    `UPDATE missions
        SET status = 'error',
            error = 'The server restarted while this mission was in flight.',
            updated_at = ?,
            finished_at = ?
      WHERE status IN ('queued', 'running')`,
    nowIso(),
    nowIso(),
  );
}
