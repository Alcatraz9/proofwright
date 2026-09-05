import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PATHS } from '../config.js';

/**
 * Serves captured screenshots.
 *
 * The request path becomes a filesystem path, which is the classic way to hand an
 * attacker the contents of a disk. Two independent defences, because one of them
 * being subtly wrong is exactly how this goes wrong in practice:
 *
 *   1. The URL is decoded and normalised, and anything that is not a plain PNG
 *      under a simple path is rejected outright.
 *   2. The resolved absolute path is then required to sit inside the artifacts
 *      root. Resolution happens first, so `..` segments and symlinked directories
 *      are already collapsed by the time the check runs — checking the raw string
 *      for `..` would miss encodings and would miss links entirely.
 *
 * The generating side sanitises ids too. Neither check trusts the other.
 */

const ROUTE_PREFIX = '/artifacts/';

export async function handleArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith(ROUTE_PREFIX)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return true;
  }

  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length));
  } catch {
    res.writeHead(400).end('Malformed path.');
    return true;
  }

  // Images only, and only names we could have generated ourselves.
  if (!/^[A-Za-z0-9._\-/]+\.png$/.test(relative)) {
    res.writeHead(404).end('Not found.');
    return true;
  }

  const root = path.resolve(PATHS.artifacts);
  const absolute = path.resolve(root, relative);

  // The containment check, on the resolved path. `path.relative` is used rather
  // than a prefix comparison because a prefix test passes for a sibling directory
  // whose name merely starts with the root's name.
  const contained = path.relative(root, absolute);
  if (contained.startsWith('..') || path.isAbsolute(contained)) {
    res.writeHead(404).end('Not found.');
    return true;
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absolute);
  } catch {
    res.writeHead(404).end('Not found.');
    return true;
  }
  if (!stat.isFile()) {
    res.writeHead(404).end('Not found.');
    return true;
  }

  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': stat.size,
    // Content-addressed by run and step, so a given path never changes. Cached
    // hard, because a run's evidence is immutable once written.
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(absolute);
    stream.on('error', () => {
      res.end();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });

  return true;
}
