import type { IncomingMessage, ServerResponse } from 'node:http';
import { capabilities, invoke, toolManifest } from './registry.js';
import { CapabilityError } from './types.js';

/**
 * REST over the capability registry.
 *
 * No route is written by hand. Each capability declares its method and path, and
 * `:param` segments bind by name and merge into the argument object, so the same
 * handler serves `GET /api/missions/abc` and the MCP call
 * `{ missionId: "abc" }` without knowing which one arrived. Query string and JSON
 * body merge in too, which is what lets `limit` work as `?limit=50` here and as a
 * named argument there.
 *
 * The ordering rule that matters: static segments beat parameters, so
 * `/api/missions/:missionId/cancel` cannot be swallowed by `/api/missions/:missionId`.
 */

interface Compiled {
  method: string;
  segments: string[];
  name: string;
}

/**
 * Compiled on first use, not at module load.
 *
 * ESM evaluates this module when the server imports it, which happens before the
 * import that registers the capabilities — so a table built at load time is built
 * from an empty registry, and every route 404s while the catalogue endpoint still
 * works, because that one reads the registry per request. Deferring until the
 * first request is what makes registration order irrelevant.
 */
let compiledRoutes: Compiled[] | null = null;

function routes(): Compiled[] {
  if (compiledRoutes) return compiledRoutes;
  compiledRoutes = capabilities()
    .map((capability) => ({
      method: capability.http.method,
      segments: capability.http.path.split('/').filter(Boolean),
      name: capability.name,
    }))
    .sort((a, b) => paramCount(a.segments) - paramCount(b.segments));
  return compiledRoutes;
}

function paramCount(segments: string[]): number {
  return segments.filter((segment) => segment.startsWith(':')).length;
}

function match(
  compiledRoute: Compiled,
  method: string,
  segments: string[],
): Record<string, string> | null {
  if (compiledRoute.method !== method) return null;
  if (compiledRoute.segments.length !== segments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index += 1) {
    const expected = compiledRoute.segments[index]!;
    const actual = segments[index]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/**
 * Returns true when a capability handled the request.
 *
 * Called before the hand-written routes so capability paths take precedence, and
 * returning false leaves the existing router entirely untouched.
 */
export async function handleCapabilityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean);

  // The catalogue. Serving this over HTTP as well as MCP means the tools are
  // discoverable from a browser or curl, not only from an agent host.
  if (url.pathname === '/api/capabilities' && method === 'GET') {
    send(res, 200, { tools: toolManifest() });
    return true;
  }

  for (const route of routes()) {
    const params = match(route, method, segments);
    if (!params) continue;

    const query = Object.fromEntries(url.searchParams.entries());
    const body = method === 'GET' ? {} : await readBody(req);
    const input = { ...query, ...body, ...params };

    try {
      send(res, method === 'POST' ? statusForPost(route.name) : 200, await invoke(route.name, input));
    } catch (error) {
      if (error instanceof CapabilityError) {
        send(res, error.status, { error: error.message });
      } else {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }

  return false;
}

/** A capability that starts background work answers 202, not 200. */
function statusForPost(name: string): number {
  return capabilities().find((capability) => capability.name === name)?.kind === 'long_running'
    ? 202
    : 200;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 1_000_000) throw new CapabilityError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new CapabilityError(400, 'Body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
