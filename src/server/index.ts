import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { INTERNAL_ORIGIN, RUN_CONCURRENCY, SERVER } from '../config.js';
import { armFault, faultState, getActiveVersion, handleFixture, setActiveVersion } from '../fixtures/app.js';
import { isVersionId, VERSIONS, VERSION_IDS } from '../fixtures/versions.js';
import { intentPlanSchema } from '../intent/types.js';
import {
  approvePlan,
  deletePlan,
  listPlanSummaries,
  loadPlan,
  savePlan,
  toPlanId,
  unapprovePlan,
  updatePlanBody,
} from '../store/plans.js';
import { deleteBaseline, loadBaseline, revertLastHeal, loadSpecSource } from '../store/baselines.js';
import {
  createRun,
  listArtifacts,
  listRunEvents,
  listRuns,
  loadRun,
  runStats,
  type RunStatus,
} from '../store/runs.js';
import { seedIfEmpty } from '../store/seed.js';
import { publish, subscribe, type StreamKind } from './events.js';
import { cancel, enqueue, queueState } from './queue.js';
import { executeRun } from './execute-run.js';
import { handleArtifact } from './artifacts.js';
import { generateIntentPlan } from '../intent/generate.js';
import { recordBaselineJob } from './record-baseline.js';
import {
  createJob,
  listJobEvents,
  listJobs,
  loadJob,
  reconcileOrphanedJobs,
} from '../store/jobs.js';
import { dashboardBuilt, handleStatic, inspectDashboard, preloadDashboard } from './static.js';

/**
 * One process serves three things: the JSON API, the live event streams, and the
 * application under test.
 *
 * Co-locating the app under test is not a shortcut. A hosted runner needs a
 * target it can actually reach, and pointing a free-tier container at some
 * external site makes every demo dependent on that site being up, unchanged and
 * willing to be automated. Serving it here makes the whole thing hermetic and
 * removes cross-origin questions entirely.
 */

import { handleCapabilityRequest } from '../capability/http.js';
import '../capability/missions.js';
import '../capability/reports.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return (raw ? JSON.parse(raw) : {}) as T;
}

/**
 * Server-sent events rather than a WebSocket. Everything streamed here travels
 * one way, and SSE reconnects on its own, needs no handshake, and survives
 * proxies that would drop an upgrade. A socket would earn its keep only if the
 * client had to push mid-run.
 */
function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  streamId: string,
  afterSeq: number,
  kind: StreamKind = 'run',
): void {
  // A run and a recording are stored in different tables — one is a verdict, the
  // other is progress — but the framing, the replay-on-connect and the keep-alive are
  // identical, so only the lookup differs.
  const readHistory = kind === 'job' ? listJobEvents : listRunEvents;
  const isFinished = (): boolean => {
    if (kind === 'job') {
      const job = loadJob(streamId);
      return Boolean(job) && !['queued', 'running'].includes(job!.status);
    }
    const run = loadRun(streamId);
    return Boolean(run) && !['queued', 'running'].includes(run!.summary.status);
  };
  const runId = streamId;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends will otherwise hold the stream in a buffer and deliver
    // it in one lump at the end, which looks exactly like a hung run.
    'x-accel-buffering': 'no',
  });

  const send = (event: { seq: number; type: string; payload: unknown; at: string }): void => {
    res.write(`id: ${event.seq}\nevent: ${event.type}\n`);
    res.write(`data: ${JSON.stringify({ seq: event.seq, at: event.at, type: event.type, payload: event.payload })}\n\n`);
  };

  // Replay what was missed before attaching to the live feed. A client that
  // connects mid-run, or reconnects after a dropped connection, then sees the
  // whole run rather than only the remainder. Last-Event-ID makes the browser's
  // own automatic reconnect resume correctly without any client code.
  const lastEventId = Number(req.headers['last-event-id'] ?? afterSeq);
  const from = Number.isFinite(lastEventId) ? lastEventId : 0;
  let highest = from;
  for (const stored of readHistory(runId, from)) {
    send(stored);
    highest = stored.seq;
  }

  const unsubscribe = subscribe(runId, (event) => {
    // The replay above may have already delivered this one.
    if (event.seq <= highest) return;
    highest = event.seq;
    send(event);
    if (event.type === 'STREAM_END') {
      unsubscribe();
      res.end();
    }
  });

  // Finished work has no more events coming, so a stream opened against it is closed
  // as soon as its history has been replayed rather than left hanging.
  if (isFinished()) {
    unsubscribe();
    res.end();
    return;
  }

  // Comment frames keep intermediaries from timing the connection out during a
  // long step, and give the client something to notice a dead socket by.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  const close = (): void => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  req.on('close', close);
  req.on('error', close);
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;

  // Capability-backed routes first. Each is declared once in the registry and
  // reached identically over MCP, so there is no second definition to drift.
  if (await handleCapabilityRequest(req, res, url)) return true;

  const method = req.method ?? 'GET';

  if (path === '/api/health') {
    json(res, 200, {
      ok: true,
      activeVersion: getActiveVersion(),
      faults: faultState(),
      queue: queueState(),
      concurrency: RUN_CONCURRENCY,
      // Surfaced so "the dashboard is blank" is answerable without guessing.
      dashboard: inspectDashboard(),
    });
    return true;
  }

  // ---- the app under test -------------------------------------------------

  if (path === '/api/fixture' && method === 'GET') {
    json(res, 200, {
      activeVersion: getActiveVersion(),
      faults: faultState(),
      versions: VERSION_IDS.map((id) => ({
        id,
        displayName: VERSIONS[id].displayName,
        story: VERSIONS[id].story,
        demonstrates: VERSIONS[id].demonstrates,
        accessibility: VERSIONS[id].accessibility,
        security: VERSIONS[id].security,
        url: `/app/${id}/`,
      })),
    });
    return true;
  }

  /**
   * Switching the active version is the demo: the same recorded baseline, the
   * same URL, a different UI underneath it. This is what a deploy looks like to
   * a test suite.
   */
  if (path === '/api/fixture/version' && method === 'POST') {
    const body = await readJson<{ version?: string }>(req);
    if (!body.version || !isVersionId(body.version)) {
      json(res, 400, { error: `version must be one of ${VERSION_IDS.join(', ')}.` });
      return true;
    }
    setActiveVersion(body.version);
    json(res, 200, { activeVersion: getActiveVersion() });
    return true;
  }

  if (path === '/api/fixture/fault' && method === 'POST') {
    const body = await readJson<{ kind?: string; on?: boolean }>(req);
    const kinds = ['serverError', 'slow', 'expireSession'] as const;
    if (!body.kind || !(kinds as readonly string[]).includes(body.kind)) {
      json(res, 400, { error: `kind must be one of ${kinds.join(', ')}.` });
      return true;
    }
    armFault(body.kind as (typeof kinds)[number], body.on ?? true);
    json(res, 200, { faults: faultState() });
    return true;
  }

  // ---- plans --------------------------------------------------------------

  if (path === '/api/plans' && method === 'GET') {
    json(res, 200, { plans: listPlanSummaries() });
    return true;
  }

  /**
   * The entry point the whole system was missing: a test described in English.
   *
   * Synchronous, because generation is a handful of model calls and finishes in
   * seconds — unlike recording, which drives a browser and is queued. The reply
   * carries everything a reviewer needs to judge the result, including how many
   * attempts the validator needed and any warnings, because a plan that took three
   * tries to satisfy the rules deserves a closer read than one that passed first time.
   *
   * The plan lands as DRAFT. Nothing runs it until a human says so.
   */
  if (path === '/api/plans' && method === 'POST') {
    const body = await readJson<{ instruction?: string; targetUrl?: string; planId?: string }>(req);

    const instruction = (body.instruction ?? '').trim();
    if (instruction.length < 8) {
      json(res, 400, {
        error: 'Describe the test in a sentence or two — what should it do, and what should it check?',
      });
      return true;
    }

    // Defaults to the bundled app under test, so the flow is usable without first
    // having to know a URL. Loopback, because the browser runs in this container.
    const targetUrl = (body.targetUrl ?? `${INTERNAL_ORIGIN}/app/`).trim();
    try {
      new URL(targetUrl);
    } catch {
      json(res, 400, { error: `"${targetUrl}" is not a URL.` });
      return true;
    }

    const attempts: { attempt: number; errors: string[] }[] = [];
    try {
      const generated = await generateIntentPlan({
        targetUrl,
        instruction,
        onAttempt: ({ attempt, errors }) => {
          if (errors.length > 0) attempts.push({ attempt, errors });
        },
      });

      const planId = (body.planId ?? toPlanId(generated.plan.name)).trim();
      if (!/^[A-Za-z0-9._-]+$/.test(planId)) {
        json(res, 400, { error: 'planId may contain letters, digits, dot, dash and underscore only.' });
        return true;
      }

      const { stored } = savePlan({
        plan: generated.plan,
        model: generated.model,
        targetUrl,
        instruction,
        planId,
      });

      json(res, 201, {
        plan: stored,
        model: generated.model,
        // How hard the model had to work to satisfy the rules, and what it got wrong.
        // A plan the validator rejected twice is worth reading more carefully.
        validatorAttempts: generated.attempts,
        rejections: attempts,
        warnings: generated.warnings,
        requiredValueRefs: generated.plan.requiredValueRefs,
        nextStep: `POST /api/plans/${planId}/baseline to record it against the application.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A quota or a model refusal is not a bad request from the caller, and saying so
      // sends someone to fix the wrong thing.
      json(res, 502, { error: `The plan could not be generated: ${message}` });
    }
    return true;
  }

  /**
   * The generated test file, served from the database rather than the
   * filesystem: tests/generated/ is gitignored and ephemeral, so this is the
   * copy that survives a restart. Plain text with a download filename, because
   * the point of emitting Playwright specs is that a tester can take them away.
   */
  const specMatch = /^\/api\/plans\/([A-Za-z0-9._-]+)\/spec$/.exec(path);
  if (specMatch && method === 'GET') {
    const planId = specMatch[1]!;
    const source = loadSpecSource(planId);
    if (source === null) {
      json(res, 404, {
        error: `No generated spec for "${planId}". A spec exists once the plan has recorded and executed.`,
      });
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/typescript; charset=utf-8',
      'content-disposition': `attachment; filename="${planId}.spec.ts"`,
    });
    res.end(source);
    return true;
  }

  const planMatch = /^\/api\/plans\/([A-Za-z0-9._-]+)$/.exec(path);
  if (planMatch) {
    const planId = planMatch[1]!;

    if (method === 'GET') {
      const plan = loadPlan(planId);
      if (!plan) {
        json(res, 404, { error: `No plan "${planId}".` });
        return true;
      }
      const baseline = loadBaseline(planId);
      json(res, 200, {
        plan,
        baseline: baseline
          ? {
              baselineId: baseline.baselineId,
              createdAt: baseline.createdAt,
              model: baseline.model,
              startUrl: baseline.startUrl,
              steps: baseline.steps,
            }
          : null,
        runs: listRuns({ planId, limit: 20 }),
      });
      return true;
    }

    // A human edit of the generated plan. Validated against the same schema the
    // model's output is held to, so a hand-edited plan cannot be looser than a
    // generated one.
    if (method === 'PATCH') {
      const body = await readJson<{ plan?: unknown }>(req);
      const parsed = intentPlanSchema.safeParse(body.plan);
      if (!parsed.success) {
        json(res, 400, {
          error: 'The edited plan does not satisfy the plan schema.',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return true;
      }
      const updated = updatePlanBody(planId, parsed.data);
      if (!updated) {
        json(res, 404, { error: `No plan "${planId}".` });
        return true;
      }
      json(res, 200, { plan: updated });
      return true;
    }

    if (method === 'DELETE') {
      // The baseline goes with it. A baseline without its plan is unrunnable and
      // unreadable — the plan is what says what the test was for.
      deleteBaseline(planId);
      json(res, deletePlan(planId) ? 200 : 404, { deleted: planId });
      return true;
    }
  }

  const recordMatch = /^\/api\/plans\/([A-Za-z0-9._-]+)\/baseline$/.exec(path);
  if (recordMatch && method === 'POST') {
    const planId = recordMatch[1]!;
    const plan = loadPlan(planId);
    if (!plan) {
      json(res, 404, { error: `No plan "${planId}".` });
      return true;
    }

    // Deliberately allowed on a DRAFT plan.
    //
    // Recording and running both execute against the application, so gating one and
    // not the other would be incoherent. The distinction that matters is supervision:
    // recording is an exploratory action a person is watching, and it is what reveals
    // whether the plan is even executable and which locators it resolves to. Reviewing
    // abstract steps without those locators is a far weaker review. Running — the
    // automated, repeated, unattended action — is what stays gated on approval.
    const jobId = `record-${planId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    createJob({ jobId, kind: 'record-baseline', planId });

    const { position } = enqueue({
      runId: jobId,
      kind: 'job',
      execute: (signal) => recordBaselineJob({ jobId, planId, signal }),
    });

    json(res, 202, { jobId, queuePosition: position, stream: `/api/jobs/${jobId}/stream` });
    return true;
  }

  // ---- jobs ---------------------------------------------------------------

  if (path === '/api/jobs' && method === 'GET') {
    json(res, 200, { jobs: listJobs(url.searchParams.get('planId') ?? undefined) });
    return true;
  }

  const jobStreamMatch = /^\/api\/jobs\/([A-Za-z0-9._-]+)\/stream$/.exec(path);
  if (jobStreamMatch && method === 'GET') {
    const jobId = jobStreamMatch[1]!;
    const job = loadJob(jobId);
    if (!job) {
      json(res, 404, { error: `No job "${jobId}".` });
      return true;
    }
    openEventStream(req, res, jobId, Number(url.searchParams.get('afterSeq') ?? 0), 'job');
    return true;
  }

  const jobMatch = /^\/api\/jobs\/([A-Za-z0-9._-]+)$/.exec(path);
  if (jobMatch && method === 'GET') {
    const job = loadJob(jobMatch[1]!);
    if (!job) {
      json(res, 404, { error: `No job "${jobMatch[1]}".` });
      return true;
    }
    json(res, 200, { job, events: listJobEvents(jobMatch[1]!) });
    return true;
  }

  const cancelJobMatch = /^\/api\/jobs\/([A-Za-z0-9._-]+)\/cancel$/.exec(path);
  if (cancelJobMatch && method === 'POST') {
    json(res, 200, { cancelled: cancel(cancelJobMatch[1]!) });
    return true;
  }

  const approveMatch = /^\/api\/plans\/([A-Za-z0-9._-]+)\/(approve|unapprove)$/.exec(path);
  if (approveMatch && method === 'POST') {
    const [, planId, action] = approveMatch as unknown as [string, string, string];
    try {
      const updated = action === 'approve' ? approvePlan(planId) : unapprovePlan(planId);
      if (!updated) {
        json(res, 404, { error: `No plan "${planId}".` });
        return true;
      }
      json(res, 200, { plan: updated });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // ---- baselines ----------------------------------------------------------

  const revertMatch = /^\/api\/baselines\/([A-Za-z0-9._-]+)\/steps\/([A-Za-z0-9._-]+)\/revert$/.exec(path);
  if (revertMatch && method === 'POST') {
    const [, planId, stepId] = revertMatch as unknown as [string, string, string];
    const result = revertLastHeal(planId, stepId);
    json(res, result.reverted ? 200 : 400, result);
    return true;
  }

  // ---- runs ---------------------------------------------------------------

  if (path === '/api/runs' && method === 'GET') {
    const planId = url.searchParams.get('planId') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? 50);
    json(res, 200, { runs: listRuns({ planId, limit }) });
    return true;
  }

  if (path === '/api/runs' && method === 'POST') {
    const body = await readJson<{
      planId?: string;
      heal?: boolean;
      threshold?: number;
      strictVisual?: boolean;
    }>(req);
    const planId = body.planId;
    if (!planId) {
      json(res, 400, { error: 'planId is required.' });
      return true;
    }

    const plan = loadPlan(planId);
    if (!plan) {
      json(res, 404, { error: `No plan "${planId}".` });
      return true;
    }
    // The approval gate. Enforced here as well as in the CLI, because a gate one
    // interface can walk around is not a gate.
    if (plan.status !== 'APPROVED') {
      json(res, 409, { error: `Plan "${planId}" is ${plan.status}. Approve it before running.` });
      return true;
    }
    const baseline = loadBaseline(planId);
    if (!baseline) {
      json(res, 409, { error: `No baseline recorded for "${planId}" yet.` });
      return true;
    }

    const runId = `${planId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const healing = body.heal ?? false;

    // Recorded before it is queued, so the client has a row to open a stream
    // against and a waiting run is visible rather than looking lost.
    createRun({
      runId,
      planId,
      startUrl: baseline.startUrl,
      activeVersion: getActiveVersion(),
      healingEnabled: healing,
      stepsTotal: baseline.steps.length,
    });

    const { position } = enqueue({
      runId,
      execute: (signal) =>
        executeRun({
          runId,
          planId,
          healing,
          threshold: body.threshold,
          strictVisual: body.strictVisual ?? false,
          signal,
        }),
    });

    json(res, 202, { runId, queuePosition: position, stream: `/api/runs/${runId}/stream` });
    return true;
  }

  const runStreamMatch = /^\/api\/runs\/([A-Za-z0-9._-]+)\/stream$/.exec(path);
  if (runStreamMatch && method === 'GET') {
    const runId = runStreamMatch[1]!;
    if (!loadRun(runId)) {
      json(res, 404, { error: `No run "${runId}".` });
      return true;
    }
    openEventStream(req, res, runId, Number(url.searchParams.get('afterSeq') ?? 0));
    return true;
  }

  const runCancelMatch = /^\/api\/runs\/([A-Za-z0-9._-]+)\/cancel$/.exec(path);
  if (runCancelMatch && method === 'POST') {
    const runId = runCancelMatch[1]!;
    json(res, 200, { cancelled: cancel(runId) });
    return true;
  }

  const runMatch = /^\/api\/runs\/([A-Za-z0-9._-]+)$/.exec(path);
  if (runMatch && method === 'GET') {
    const found = loadRun(runMatch[1]!);
    if (!found) {
      json(res, 404, { error: `No run "${runMatch[1]}".` });
      return true;
    }
    json(res, 200, {
      ...found,
      events: listRunEvents(runMatch[1]!),
      artifacts: listArtifacts(runMatch[1]!),
    });
    return true;
  }

  if (path === '/api/stats' && method === 'GET') {
    json(res, 200, runStats(Number(url.searchParams.get('limit') ?? 30)));
    return true;
  }

  return false;
}

export async function createServer(): Promise<http.Server> {
  const seeded = await seedIfEmpty();
  if (seeded.seeded) {
    console.log(
      `Seeded a fresh database: ${seeded.plans} plan(s), ${seeded.baselines} baseline(s), ` +
        `${seeded.artifacts} screenshot(s), ${seeded.healCacheEntries} cached heal proposal(s).`,
    );
  }
  if (seeded.orphansReconciled > 0) {
    console.log(
      `${seeded.orphansReconciled} run(s) were left mid-flight by a previous process and are marked as errored.`,
    );
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    void (async () => {
      try {
        if (await api(req, res, url)) return;
        if (await handleArtifact(req, res, url)) return;
        if (await handleFixture(req, res, url)) return;
        // Last, so it cannot shadow any of the above. A static root that answers
        // before /api turns a missing endpoint into an HTML page, and a client
        // expecting JSON then reports a parse error rather than a 404.
        if (await handleStatic(req, res, url)) return;

        json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      } catch (err) {
        // A thrown handler must not take the process down — the run queue and any
        // open event streams are living in it.
        if (!res.headersSent) {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        } else {
          res.end();
        }
      }
    })();
  });
}

export async function start(): Promise<void> {
  const server = await createServer();

  // Before accepting a single request. The bundle is read into memory here so that
  // serving it never depends on a filesystem read at request time — this process
  // has twice outlived its ability to open files it read successfully at startup,
  // and a dashboard that goes blank hours in is the worst possible failure to
  // debug from outside. Synchronous on purpose: there must be no window where the
  // server is answering requests from a half-populated cache.
  const dashboard = preloadDashboard();

  server.listen(SERVER.port, SERVER.host, () => {
    console.log(`Listening on http://${SERVER.host}:${SERVER.port}`);
    console.log(
      `  Dashboard      /               ${
        dashboardBuilt() ? '' : '(not built — run "npm run web:build")'
      }`,
    );
    console.log(`  API            /api/health`);
    console.log(`  App under test /app/            (active: ${getActiveVersion()})`);
    for (const id of VERSION_IDS) console.log(`                 /app/${id}/         ${VERSIONS[id].displayName}`);
    console.log(`  Run concurrency ${RUN_CONCURRENCY}`);

    // Asserted from the bytes actually held, because a dashboard that returns a
    // correct content-length and an empty body is indistinguishable from a server
    // that is not running, and says nothing in the log while doing it.
    if (!dashboard.built) {
      console.warn('  Dashboard      NOT BUILT — run "npm run web:build". The API still works.');
    } else if (dashboard.error) {
      console.error(`  Dashboard      UNSERVABLE — ${dashboard.error}`);
    } else {
      console.log(
        `  Dashboard      ok (${dashboard.entryBytes} bytes, ${dashboard.assets} asset(s), from ${dashboard.source})`,
      );
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} — closing.`);
      server.close(() => process.exit(0));
    });
  }
}
