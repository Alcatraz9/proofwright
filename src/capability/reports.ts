import { z } from 'zod';
import { qualityReportSchema } from '../report/types.js';
import { loadReport } from '../store/reports.js';
import { register } from './registry.js';
import { notFound } from './types.js';

export const getReport = register({
  name: 'edgeforge_get_report',
  title: 'Read a mission report',
  description: [
    "The synthesised test quality report for a finished mission: every scenario and its",
    'verdict, the healer actions with their confidence and evidence, the coverage gaps that',
    'remain, the untested flows ranked by risk, and a quality score that always shows the',
    'parts it was computed from.',
    '',
    'Read `quality.caveats` before quoting `quality.overall`. A score of 0.8 on a suite with',
    'no refusal coverage means something different from 0.8 on one that tests every refusal,',
    'and the caveats are where that difference is stated.',
  ].join('\n'),
  kind: 'read',
  http: { method: 'GET', path: '/api/missions/:missionId/report' },
  input: z.object({ missionId: z.string().min(1) }),
  output: z.object({ report: qualityReportSchema, createdAt: z.string() }),
  handler: (input) => {
    const stored = loadReport(input.missionId);
    if (!stored) {
      throw notFound(
        `No report for "${input.missionId}". A report is written when a mission finishes.`,
      );
    }
    return { report: stored.report, createdAt: stored.createdAt };
  },
});

export const getReportMarkdown = register({
  name: 'edgeforge_get_report_markdown',
  title: 'Read a mission report as markdown',
  description:
    'The same report rendered for a person to read or paste into a document, rather than for a program to parse. Ordered so the caveats that qualify the score come before the detail.',
  kind: 'read',
  http: { method: 'GET', path: '/api/missions/:missionId/report.md' },
  input: z.object({ missionId: z.string().min(1) }),
  output: z.object({ markdown: z.string() }),
  handler: (input) => {
    const stored = loadReport(input.missionId);
    if (!stored) throw notFound(`No report for "${input.missionId}".`);
    return { markdown: stored.markdown };
  },
});
