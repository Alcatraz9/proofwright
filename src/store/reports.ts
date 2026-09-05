import { execute, nowIso, queryOne } from './db.js';
import type { QualityReport } from '../report/types.js';

/**
 * Reports are stored rather than regenerated on request.
 *
 * A report describes one mission at one moment. Recomputing it later would read
 * whatever the plans and runs look like *now* — after a later mission healed a
 * locator or a plan was edited — and quietly answer a different question than the
 * one asked. The stored copy is the record.
 */
interface Row {
  mission_id: string;
  created_at: string;
  json: string;
  markdown: string;
}

export function saveReport(missionId: string, report: QualityReport, markdown: string): void {
  execute(
    `INSERT INTO reports (mission_id, created_at, json, markdown)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(mission_id) DO UPDATE SET created_at = excluded.created_at,
                                           json = excluded.json,
                                           markdown = excluded.markdown`,
    missionId,
    nowIso(),
    JSON.stringify(report),
    markdown,
  );
}

export function loadReport(
  missionId: string,
): { report: QualityReport; markdown: string; createdAt: string } | null {
  const row = queryOne<Row>('SELECT * FROM reports WHERE mission_id = ?', missionId);
  if (!row) return null;
  return {
    report: JSON.parse(row.json) as QualityReport,
    markdown: row.markdown,
    createdAt: row.created_at,
  };
}
