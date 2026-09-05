import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  renderCart,
  renderCatalog,
  renderCheckout,
  renderConfirmation,
  renderError,
  renderLogin,
  renderProduct,
} from './pages.js';
import {
  FIXTURE_CREDENTIALS,
  findProduct,
  isVersionId,
  PRODUCTS,
  VERSIONS,
  type VersionId,
  type VersionSpec,
} from './versions.js';

/**
 * The fixture app's HTTP surface.
 *
 * Mounted three ways:
 *   /app/…      the active version. Every plan and baseline targets this, so the
 *               URL a step was recorded on stays the same when the UI changes
 *               underneath it. Put the version in the path and a redesign would
 *               read as a page divergence, and the run would stop before the
 *               healer was ever consulted.
 *   /app/v1/…   the three versions directly, always available, so a human can
 *   /app/v2/…   open two of them side by side and see what the run was up
 *   /app/v3/…   against.
 *
 * Session state is a signed-ish cookie rather than client-side storage, because
 * the failures worth demonstrating are HTTP-level: a 500 needs a real status
 * code, an expired session needs a real redirect to /login, and a missing route
 * needs a real 404. JavaScript in the page cannot produce any of those.
 */

const SESSION_COOKIE = 'qa_fixture_session';

/** Faults are armed out of band and fire once, so a run can be steered mid-flow. */
interface FaultState {
  /** Next page render returns a 500. */
  serverError: boolean;
  /** Next gated page holds the response, so the page looks busy rather than broken. */
  slow: boolean;
  /** Session is dropped, so the next gated page redirects to login. */
  expireSession: boolean;
}

const faults: FaultState = { serverError: false, slow: false, expireSession: false };

let activeVersion: VersionId = 'v1';

export function getActiveVersion(): VersionId {
  return activeVersion;
}

export function setActiveVersion(version: VersionId): void {
  activeVersion = version;
}

export function armFault(kind: keyof FaultState, on = true): void {
  faults[kind] = on;
}

export function faultState(): FaultState {
  return { ...faults };
}

function cookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const [name, ...rest] = part.trim().split('=');
      return [name ?? '', decodeURIComponent(rest.join('='))];
    }),
  );
}

function isSignedIn(req: IncomingMessage): boolean {
  return Boolean(cookies(req)[SESSION_COOKIE]);
}

/**
 * Response headers, which are the security posture of a release.
 *
 * A weak release sends none of them. A hardened one sends the set whose absence
 * has a consequence you can state in a sentence. `Secure` is deliberately absent
 * from the cookie even when hardened, because the fixture is served over http and
 * a Secure cookie would simply not be stored — so the finding for it stays, which
 * is honest: over http that flag genuinely cannot be verified.
 */
function securityHeaders(spec: VersionSpec): Record<string, string> {
  if (spec.security === 'weak') return {};
  return {
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=(), camera=(), microphone=()',
  };
}

function sessionCookie(spec: VersionSpec): string {
  const flags =
    spec.security === 'hardened'
      ? `${SESSION_COOKIE}=ok; Path=/app; HttpOnly; SameSite=Lax`
      : `${SESSION_COOKIE}=ok; Path=/app`;
  return flags;
}

function html(res: ServerResponse, status: number, body: string, spec?: VersionSpec): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // The app under test must never be cached, or a version switch would not be
    // visible to a browser that already has the old page.
    'cache-control': 'no-store',
    ...(spec ? securityHeaders(spec) : {}),
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, setCookie?: string): void {
  const headers: Record<string, string> = { location, 'cache-control': 'no-store' };
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A fixture has no business accepting a large body; cap it rather than
    // buffering whatever arrives.
    if (size > 64 * 1024) break;
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Which product the basket holds. Fixed, so a total never drifts between runs. */
const BASKET_PRODUCT = PRODUCTS[0]!;

export interface FixtureRequest {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path within the fixture mount, always starting with "/". */
  path: string;
  /** Link prefix for this mount — "/app" or "/app/v2". */
  base: string;
  spec: VersionSpec;
}

/**
 * Resolves a request under /app to a mount, then handles it.
 * Returns false when the path is not the fixture's to serve.
 */
export async function handleFixture(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith('/app')) return false;

  const rest = url.pathname.slice('/app'.length) || '/';
  const segments = rest.split('/').filter(Boolean);

  // /app/v2/... pins a version explicitly; /app/... follows the active one.
  let base = '/app';
  let spec = VERSIONS[activeVersion];
  let path = rest;
  if (segments[0] && isVersionId(segments[0])) {
    spec = VERSIONS[segments[0]];
    base = `/app/${segments[0]}`;
    path = `/${segments.slice(1).join('/')}`;
  }

  await route({ req, res, path, base, spec }, url);
  return true;
}

async function route(ctx: FixtureRequest, url: URL): Promise<void> {
  const { req, res, base, spec } = ctx;
  const path = ctx.path === '' ? '/' : ctx.path;

  // ---- fault injection ---------------------------------------------------
  // Armed by the dashboard rather than baked into a version, so one baseline can
  // be driven into several different verdicts without re-recording it.
  if (path.startsWith('/_fault/')) {
    const kind = path.slice('/_fault/'.length).replace(/\/$/, '');
    switch (kind) {
      case '500':
        faults.serverError = true;
        break;
      case 'slow':
        faults.slow = true;
        break;
      case 'expire-session':
        faults.expireSession = true;
        break;
      case 'clear':
        faults.serverError = false;
        faults.slow = false;
        faults.expireSession = false;
        break;
      default:
        html(res, 404, renderError(spec, base, 404, `No such fault: ${kind}`), spec);
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(faults));
    return;
  }

  // A real 500, consumed on use. The classifier must read the status and refuse
  // to heal, even though every element on the page is genuinely missing.
  if (faults.serverError) {
    faults.serverError = false;
    html(res, 500, renderError(spec, base, 500, 'Internal server error.'), spec);
    return;
  }

  if (path === '/logout') {
    redirect(res, base || '/app', `${SESSION_COOKIE}=; Path=/app; Max-Age=0`);
    return;
  }

  if (path === '/login' && req.method === 'POST') {
    const body = await readBody(req);
    const email = body.get('email') ?? '';
    const password = body.get('password') ?? '';
    const correct =
      email === FIXTURE_CREDENTIALS.email && password === FIXTURE_CREDENTIALS.password;

    // v3 inverts this. The button is found, the click lands, the form posts —
    // the app simply does not authenticate. Only the outcome assertion fails,
    // which is what makes it unhealable by structure rather than by a rule that
    // looks for the word "login".
    const authenticated = spec.loginInverted ? !correct : correct;

    if (!authenticated) {
      html(res, 200, renderLogin(spec, base, 'Login failed: invalid credentials', null), spec);
      return;
    }
    redirect(res, `${base}/catalog`, sessionCookie(spec));
    return;
  }

  if (path === '/' || path === '/login') {
    html(res, 200, renderLogin(spec, base, null, null), spec);
    return;
  }

  // ---- everything past here needs a session ------------------------------

  // An unknown path is answered before the session gate. A route that does not
  // exist is not a protected resource, and bouncing it to login would return 302
  // where the classifier needs a real 404 — the status code is the only thing
  // that distinguishes "this page is gone" from "this locator is stale", since
  // both present as every element being missing.
  const KNOWN = ['/catalog', '/cart', '/checkout', '/order', '/confirmation'];
  const isProductPath = /^\/product\/[a-z0-9-]+$/.test(path);
  if (!KNOWN.includes(path) && !isProductPath) {
    html(res, 404, renderError(spec, base, 404, `No such page: ${url.pathname}`), spec);
    return;
  }

  if (faults.expireSession) {
    faults.expireSession = false;
    // Dropped mid-flow: the browser lands on the login page while the step
    // expects the checkout page, which the replay catches as a divergence before
    // it looks for any element. Without that check a login form's plausible
    // inputs are one of the most damaging false heals available.
    redirect(res, `${base}/login`, `${SESSION_COOKIE}=; Path=/app; Max-Age=0`);
    return;
  }

  if (!isSignedIn(req)) {
    redirect(res, `${base}/login`);
    return;
  }

  if (faults.slow) {
    faults.slow = false;
    // Longer than the replay's not-ready budget, and reported as a busy page
    // rather than a broken one — the point is that the healer is never shown a
    // page that simply has not finished.
    await new Promise((resolve) => setTimeout(resolve, 12_000));
  }

  if (path === '/catalog') {
    html(res, 200, renderCatalog(spec, base, url.searchParams.get('q') ?? ''), spec);
    return;
  }

  const productMatch = /^\/product\/([a-z0-9-]+)$/.exec(path);
  if (productMatch) {
    const product = findProduct(productMatch[1]!);
    if (!product) {
      html(res, 404, renderError(spec, base, 404, 'No such product.'), spec);
      return;
    }
    html(res, 200, renderProduct(spec, base, product), spec);
    return;
  }

  if (path === '/cart') {
    const product =
      req.method === 'POST'
        ? (findProduct((await readBody(req)).get('productId') ?? '') ?? BASKET_PRODUCT)
        : BASKET_PRODUCT;
    html(res, 200, renderCart(spec, base, product), spec);
    return;
  }

  if (path === '/checkout') {
    html(res, 200, renderCheckout(spec, base, BASKET_PRODUCT), spec);
    return;
  }

  if (path === '/order' && req.method === 'POST') {
    await readBody(req);
    redirect(res, `${base}/confirmation`);
    return;
  }

  if (path === '/confirmation') {
    // Fixed, not random: a confirmation number that changed every run would make
    // an exact-value assertion impossible to write honestly.
    html(res, 200, renderConfirmation(spec, base, 'NS-84213'), spec);
    return;
  }

  html(res, 404, renderError(spec, base, 404, `No such page: ${url.pathname}`), spec);
}
