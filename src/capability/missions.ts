import { z } from 'zod';
import { DEFAULT_TARGET_URL } from '../orchestrator/machine.js';
import {
  missionSchema,
  missionSummarySchema,
  missionModeSchema,
} from '../orchestrator/types.js';
import { abortMission, startMissionInBackground } from '../orchestrator/supervisor.js';
import {
  createMission,
  listMissions,
  loadMission,
  finishMission,
} from '../store/missions.js';
import { register } from './registry.js';
import { applyProvidedValues } from '../orchestrator/values.js';
import { badRequest, notFound } from './types.js';

const urlField = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute URL, including the scheme' },
  );

export const startMission = register({
  name: 'edgeforge_start_mission',
  title: 'Start a test mission',
  description: [
    'Point ProofWright at a running web application and it drives the whole testing lifecycle',
    'itself: plans the tests, resolves them against the live DOM, executes them, and repairs',
    'the ones that broke because the interface moved. No step in between needs a human.',
    '',
    'targetUrl is the only required argument. Supply instruction to steer scope in plain',
    'English ("focus on checkout and authentication"); leave it out and the scope is derived',
    'from the application. Supply prd with a requirements document to scope planning to it and',
    'get back which stated requirements nothing verifies.',
    '',
    'The mission runs for minutes, so this returns a missionId straight away. Read it back',
    'with edgeforge_get_mission, which carries the verdict and the orchestrator\'s reasoning',
    'at each stage.',
  ].join('\n'),
  kind: 'long_running',
  http: { method: 'POST', path: '/api/missions' },
  input: z.object({
    targetUrl: urlField.optional(),
    instruction: z.string().trim().min(8).optional(),
    mode: missionModeSchema.default('autonomous'),
    /**
     * Named values the plan may need, most often a login. Env-var shaped keys, e.g.
     * { "TEST_EMAIL": "...", "TEST_PASSWORD": "..." }. Held in the process only:
     * never stored on the mission, never written to a decision, never reported.
     */
    credentials: z.record(z.string(), z.string()).optional(),
    /**
     * A product requirements document, as text. Informs what the planner scopes to,
     * and afterwards the report says which stated requirements nothing verifies —
     * which is a different gap from the application-derived one, and usually the
     * one a PM is asking about.
     */
    prd: z.string().trim().min(40).optional(),
  }),
  output: z.object({
    missionId: z.string(),
    status: z.string(),
      poll: z.string(),
  }),
  handler: (input) => {
    const targetUrl = input.targetUrl ?? DEFAULT_TARGET_URL;
    const missionId = `m-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Always called, even with no credentials: applying an empty set is how the
    // PREVIOUS mission's credentials get withdrawn. Skipping the call was the
    // leak — "no credentials supplied" silently meant "whatever the last
    // mission supplied".
    const supplied = applyProvidedValues(input.credentials ?? {});

    createMission({
      missionId,
      mode: input.mode,
      targetUrl,
      instruction: input.instruction ?? null,
      prd: input.prd ?? null,
    });

    /**
     * Started off the browser queue. The orchestrator itself only decides and
     * waits; each stage that drives a browser enqueues and is awaited there, so
     * browser concurrency is still honoured without a thinking mission holding
     * the only slot.
     */
    startMissionInBackground(missionId);

    return {
      missionId,
      status: 'queued',
      poll: `/api/missions/${missionId}`,
      // Names only, so a caller can confirm what landed without the values echoing back.
      credentialsAccepted: supplied,
    };
  },
});

export const getMission = register({
  name: 'edgeforge_get_mission',
  title: 'Read a mission',
  description: [
    'Full state of one mission: which stage it is in, the verdict once it finishes, and the',
    'ordered list of decisions the orchestrator made — what it did at each stage boundary and',
    'why, including any stage it skipped and on what grounds.',
    '',
    'Read the decisions rather than only the status. A mission that finished needs_review is',
    'not a failure; it means the system declined to repair something and wants a person, and',
    'the reason is in the log.',
  ].join('\n'),
  kind: 'read',
  http: { method: 'GET', path: '/api/missions/:missionId' },
  input: z.object({ missionId: z.string().min(1) }),
  output: missionSchema,
  handler: (input) => {
    const mission = loadMission(input.missionId);
    if (!mission) throw notFound(`No mission "${input.missionId}".`);
    return mission;
  },
});

export const listMissionsCapability = register({
  name: 'edgeforge_list_missions',
  title: 'List missions',
  description:
    'Recent missions, newest first, without their decision logs — use edgeforge_get_mission for one mission in full.',
  kind: 'read',
  http: { method: 'GET', path: '/api/missions' },
  input: z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }),
  output: z.object({ missions: z.array(missionSummarySchema) }),
  handler: (input) => ({ missions: listMissions(input.limit) }),
});

export const cancelMission = register({
  name: 'edgeforge_cancel_mission',
  title: 'Cancel a mission',
  description:
    'Stops a queued or running mission. A mission that already reached a verdict cannot be cancelled.',
  kind: 'write',
  http: { method: 'POST', path: '/api/missions/:missionId/cancel' },
  input: z.object({ missionId: z.string().min(1) }),
  output: z.object({ missionId: z.string(), status: z.string() }),
  handler: (input) => {
    const mission = loadMission(input.missionId);
    if (!mission) throw notFound(`No mission "${input.missionId}".`);
    if (!['queued', 'running'].includes(mission.status)) {
      throw badRequest(`Mission "${input.missionId}" already finished as ${mission.status}.`);
    }
    // Also cancels whichever stage is in the queue: the recording job and the run
    // are separate queue entries, and a mission stopped without them would return
    // while a browser was still driving the application.
    const stageIds = [
      `mission-${input.missionId}-baseline`,
      ...(mission.runId ? [mission.runId] : []),
    ];
    abortMission(input.missionId, stageIds);
    finishMission(input.missionId, 'cancelled');
    return { missionId: input.missionId, status: 'cancelled' };
  },
});
