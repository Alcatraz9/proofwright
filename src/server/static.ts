import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROOT } from '../config.js';

/**
 * Serves the built dashboard.
 *
 * Mounted last, after the API, the artifacts route and the application under
 * test, so it cannot shadow any of them. That ordering is the whole reason this
 * is a separate handler rather than a catch-all: a static root that answers
 * before `/api` turns a missing endpoint into an HTML page, and a client that
 * receives HTML where it expected JSON reports a parse error instead of a 404.
 *
 * Two caching rules, because the two kinds of file have opposite requirements.
 * Vite fingerprints everything under `assets/`, so those names change whenever
 * their contents do and can be cached for a year. `index.html` is the one file
 * whose name is stable and whose contents point at the fingerprinted ones, so it
 * must never be cached — a stale copy references assets that no longer exist and
 * the dashboard comes up blank.
 */

const DIST = path.join(ROOT, 'web', 'dist');

/**
 * Prefixes the server owns. Running last is not sufficient protection for these:
 * an *unmatched* path under one of them — a typo'd endpoint, a deleted artifact —
 * falls through to here, and answering it with the dashboard turns a 404 into an
 * HTML page. A client expecting JSON then reports a parse error, which is a much
 * worse diagnostic than the 404 it asked for.
 */
const RESERVED = ['/api', '/artifacts', '/app'];

function reserved(pathname: string): boolean {
  return RESERVED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

let missingWarned = false;

interface Held {
  body: Buffer;
  contentType: string;
}

/**
 * The built dashboard, held in memory.
 *
 * Read once at boot rather than per request, because this server has twice
 * reached a state where a long-lived process could no longer open files it had
 * read successfully at startup — `open` returning ENOSYS on a path that a fresh
 * process in the same environment reads without complaint. The cause was not
 * recoverable either time: the failure surfaces hours in, and the process holding
 * the evidence is the one that has to be replaced to restore service.
 *
 * Rather than keep chasing it, remove the dependency. The bundle is a few hundred
 * kilobytes, it is immutable for the lifetime of the process by construction — a
 * rebuild produces new fingerprinted names and requires a restart to be picked up
 * anyway — and it is the one asset whose absence makes the entire product look
 * dead rather than degraded. Holding it costs less than the failure it removes.
 *
 * Anything not preloaded still falls back to a disk read, so a file added to the
 * build directory later is served normally.
 */
const CACHE = new Map<string, Held>();
let preloadError: string | null = null;

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Loads the bundle into memory. Safe to call more than once; later calls replace
 * the contents, so a rebuild can be picked up without a restart if wanted.
 *
 * Deliberately synchronous. It runs once at boot before the listener is accepting
 * requests, and doing it synchronously means there is no window in which the
 * server is answering requests with a half-populated cache.
 */
export function preloadDashboard(): DashboardStatus {
  CACHE.clear();
  preloadError = null;

  const entry = path.join(DIST, 'index.html');
  if (!fs.existsSync(entry)) {
    preloadError = `No build at ${DIST}`;
    return { built: false, entryBytes: 0, assets: 0, error: preloadError, source: 'disk' };
  }

  try {
    CACHE.set('/index.html', { body: fs.readFileSync(entry), contentType: contentTypeFor(entry) });

    const assetsDir = path.join(DIST, 'assets');
    if (fs.existsSync(assetsDir)) {
      for (const name of fs.readdirSync(assetsDir)) {
        const absolute = path.join(assetsDir, name);
        if (!fs.statSync(absolute).isFile()) continue;
        CACHE.set(`/assets/${name}`, {
          body: fs.readFileSync(absolute),
          contentType: contentTypeFor(absolute),
        });
      }
    }

    // Loose files beside index.html — favicons, robots.txt, a manifest.
    for (const name of fs.readdirSync(DIST)) {
      const absolute = path.join(DIST, name);
      if (name === 'assets' || name === 'index.html') continue;
      if (!fs.statSync(absolute).isFile()) continue;
      CACHE.set(`/${name}`, {
        body: fs.readFileSync(absolute),
        contentType: contentTypeFor(absolute),
      });
    }
  } catch (err) {
    preloadError = err instanceof Error ? err.message : String(err);
  }

  return inspectDashboard();
}

/**
 * True when the dashboard can be served. Answered from the cache first, so a
 * filesystem that has become unreadable does not make a loaded dashboard report
 * itself as missing.
 */
export function dashboardBuilt(): boolean {
  return CACHE.has('/index.html') || fs.existsSync(path.join(DIST, 'index.html'));
}

export interface DashboardStatus {
  built: boolean;
  /** Bytes actually held for the entry document, not its stat size. */
  entryBytes: number;
  assets: number;
  error: string | null;
  /** Whether requests are answered from memory or fall through to disk. */
  source: 'memory' | 'disk';
}

/**
 * Reports what the server is actually able to serve.
 *
 * `existsSync` and a `stat` were not enough. This server once answered every
 * request with a correct status, a correct content-type and a correct
 * content-length while delivering **zero bytes of body** — so the interface was
 * blank, nothing was logged, and the only available conclusion from outside was
 * that the application was not running. Every check that mattered passed.
 *
 * So the figure reported is the size of the body actually held for the entry
 * document, which is the thing that will be written to the socket. It is the
 * difference between "the file is there" and "the file can be served", and only
 * the second one is worth asserting.
 */
export function inspectDashboard(): DashboardStatus {
  const held = CACHE.get('/index.html');

  if (held) {
    const assets = [...CACHE.keys()].filter((key) => key.startsWith('/assets/')).length;
    return {
      built: true,
      entryBytes: held.body.byteLength,
      assets,
      error: held.body.byteLength === 0 ? 'The entry document is empty.' : preloadError,
      source: 'memory',
    };
  }

  // Nothing held: either the preload has not run, or it failed. Fall back to
  // describing the disk so the message names the real problem.
  const entry = path.join(DIST, 'index.html');
  if (!fs.existsSync(entry)) {
    return {
      built: false,
      entryBytes: 0,
      assets: 0,
      error: preloadError ?? `No build at ${DIST}`,
      source: 'disk',
    };
  }

  try {
    const bytes = fs.readFileSync(entry).byteLength;
    let assets = 0;
    try {
      assets = fs.readdirSync(path.join(DIST, 'assets')).length;
    } catch {
      /* a build with no assets directory is odd but not fatal */
    }
    return {
      built: true,
      entryBytes: bytes,
      assets,
      error: preloadError ?? (bytes === 0 ? 'The entry document is empty.' : null),
      source: 'disk',
    };
  } catch (err) {
    return {
      built: true,
      entryBytes: 0,
      assets: 0,
      error: err instanceof Error ? err.message : String(err),
      source: 'disk',
    };
  }
}

export async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (reserved(url.pathname)) return false;

  if (!dashboardBuilt()) {
    if (!missingWarned) {
      missingWarned = true;
      console.warn(`No dashboard build at ${DIST}. Run "npm run web:build" to serve the interface.`);
    }
    return false;
  }

  let requested: string;
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Malformed path.');
    return true;
  }

  const resolved = resolveWithin(DIST, requested);
  if (!resolved) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found.');
    return true;
  }

  // Held in memory: answered without touching the filesystem. The cache key is
  // derived from the *resolved* path rather than the raw request, so traversal and
  // encoding have already been collapsed and a cache hit cannot escape the root.
  const key = `/${path.relative(DIST, resolved).split(path.sep).join('/')}`;
  const held = CACHE.get(key);
  if (held) {
    sendBuffer(req, res, held, isFingerprinted(requested));
    return true;
  }

  // A real file under the build root is served as itself. Anything else is a
  // client route, and gets index.html so a deep link works on a cold load.
  if (await isFile(resolved)) {
    await send(req, res, resolved, isFingerprinted(requested));
    return true;
  }

  // Never fall back to HTML for something that was clearly asking for an asset:
  // a missing script answered with a page is a confusing failure, and a 404 is
  // the honest one.
  if (path.extname(requested)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found.');
    return true;
  }

  const entry = CACHE.get('/index.html');
  if (entry) {
    sendBuffer(req, res, entry, false);
    return true;
  }

  await send(req, res, path.join(DIST, 'index.html'), false);
  return true;
}

function sendBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  held: Held,
  immutable: boolean,
): void {
  res.writeHead(200, {
    'content-type': held.contentType,
    'content-length': held.body.byteLength,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(held.body);
}

/**
 * Resolves a request path inside a root, or returns null.
 *
 * The check is made on the resolved absolute path rather than by looking for `..`
 * in the raw string, so encoded traversal and symlinked directories are already
 * collapsed by the time it runs. `path.relative` rather than a prefix comparison,
 * because a prefix test also passes for a sibling directory whose name merely
 * starts with the root's.
 */
function resolveWithin(root: string, requested: string): string | null {
  const absolute = path.resolve(root, `.${path.posix.normalize(requested)}`);
  const contained = path.relative(root, absolute);
  if (contained.startsWith('..') || path.isAbsolute(contained)) return null;
  return absolute;
}

function isFingerprinted(requested: string): boolean {
  return requested.startsWith('/assets/');
}

async function isFile(absolute: string): Promise<boolean> {
  try {
    return (await fsp.stat(absolute)).isFile();
  } catch {
    return false;
  }
}

async function send(
  req: IncomingMessage,
  res: ServerResponse,
  absolute: string,
  immutable: boolean,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absolute);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(absolute);

    // Logged, not swallowed.
    //
    // This branch previously ended the response silently, which produced the most
    // misleading failure this server has had: headers with a correct content-length
    // and zero bytes of body. The dashboard came up blank, every status code was
    // 200, and nothing appeared in the log — so it looked like the app was not
    // running at all. A read that fails after headers are sent cannot be reported to
    // the client, which is exactly why it has to be reported to the operator.
    stream.on('error', (err: unknown) => {
      console.error(
        `Failed to read ${absolute} after headers were sent: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.end();
      resolve();
    });

    stream.on('end', resolve);
    stream.pipe(res);
  });
}
