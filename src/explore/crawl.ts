import type { Page } from 'playwright';
import { testCredentials } from '../config.js';
import {
  REF_ATTRIBUTE,
  extractPage,
  type ExtractedElement,
  type PageSnapshot,
} from '../browser/extract.js';
import type { FormField, FormSpec, PageState, SiteMap } from './types.js';

/**
 * Breadth-first exploration of an application, making no model calls at all.
 *
 * Two reasons it is deterministic rather than agentic. The free-tier model quota
 * is twenty requests per day, and a crawl that spent one call per navigation
 * decision would exhaust the day's budget before a single test ran. And coverage
 * wants exhaustiveness, which a queue delivers better than judgement: the model's
 * contribution is deciding what is worth *testing* about what was found, which is
 * one call per page rather than one per click.
 *
 * What it will not do is act. It reads links and describes forms; it never submits
 * one, and it never clicks a control whose name suggests deletion. A crawler sent
 * to inspect an application that empties a shopping basket, cancels an order, or
 * deletes an account to see what happens has damaged the thing it was measuring —
 * and on a target the organisers supplied, that damage is not ours to cause.
 */

export interface CrawlOptions {
  entryUrl: string;
  /** Hard ceiling on pages extracted. The free tier is slow; depth beats breadth. */
  pageLimit?: number;
  /**
   * Clicks from the entry URL. Eight in practice defers to the page budget:
   * breadth-first order fills the page cap long before depth on any site with
   * fan-out, so this only bites on chain-shaped paths (list -> detail ->
   * sub-detail), which is exactly where a low limit was cutting real
   * exploration short. The page budget, not this, is the cost control.
   */
  depthLimit?: number;
  /** Wall-clock ceiling, because one slow page should not consume the mission. */
  timeBudgetMs?: number;
  signal?: AbortSignal;
  onPage?: (page: PageState) => void;
  /**
   * Used to get past a login form so the crawl can see the application rather than
   * its front door. Read from the environment by default, which is where the rest
   * of the system keeps them.
   */
  credentials?: { identity?: string; secret?: string };
}

/**
 * Links that end the session, which a crawl must never follow.
 *
 * Signing out is not destructive to the application, so it does not belong with the
 * hints below — it is destructive to the *crawl*. The first authenticated run
 * followed one, lost the session it had just established, and then mapped the login
 * page three times over while reporting five pages explored. A map like that reads
 * as coverage and is nothing of the kind.
 */
const SESSION_ENDING = ['logout', 'log-out', 'log out', 'signout', 'sign-out', 'sign out', 'exit'];

const DESTRUCTIVE_HINTS = [
  'delete',
  'remove',
  'cancel order',
  'cancel subscription',
  'deactivate',
  'close account',
  'clear',
  'empty',
  'discard',
  'revoke',
  'unsubscribe',
  'reset',
  'wipe',
  'destroy',
  'terminate',
];

export async function crawl(page: Page, options: CrawlOptions): Promise<SiteMap> {
  // Small on purpose: a mission needs enough map to plan a happy path against,
  // not an exhaustive survey. Every mapped form becomes coverage denominator
  // that planning and locator resolution then pay tokens for, and repeat
  // missions against the same URL reuse the stored map rather than crawling
  // again — so the budget only bounds the *first* look at an application.
  const pageLimit = options.pageLimit ?? 3;
  const depthLimit = options.depthLimit ?? 3;
  const timeBudgetMs = options.timeBudgetMs ?? 90_000;
  const startedAt = Date.now();

  const entryOrigin = new URL(options.entryUrl).origin;
  const visited = new Set<string>();
  /** URL shapes (path templates) already represented in the map. */
  const visitedShapes = new Set<string>();
  const pages: PageState[] = [];
  const unvisited: { url: string; reason: string }[] = [];

  const queue: { url: string; depth: number }[] = [{ url: normalise(options.entryUrl), depth: 0 }];

  let wallFound = false;
  let authenticated = false;
  let authAttempted = false;
  let authNoteExtra = '';
  const sessionEndingSkipped = new Set<string>();

  const fromEnv = testCredentials();
  /**
   * Object-level fallback, not per-field. A caller that passes a credentials
   * object owns the decision entirely — including the decision that there are
   * none. Per-field `??` quietly resurrected the server's own `.env` fixture
   * login for external targets whenever the mission supplied nothing.
   */
  const credentials = options.credentials ?? {
    identity: fromEnv.identity,
    secret: fromEnv.secret,
  };

  while (queue.length) {
    if (options.signal?.aborted) break;

    if (pages.length >= pageLimit) {
      for (const remaining of queue) {
        unvisited.push({ url: remaining.url, reason: `Page limit of ${pageLimit} reached.` });
      }
      break;
    }
    if (Date.now() - startedAt > timeBudgetMs) {
      for (const remaining of queue) {
        unvisited.push({
          url: remaining.url,
          reason: `Time budget of ${Math.round(timeBudgetMs / 1000)}s reached.`,
        });
      }
      break;
    }

    /**
     * Diversity-first, specificity-ranked dequeue — not plain FIFO.
     *
     * Two observed failure modes shape this. FIFO spent a whole budget on
     * siblings of one template (book after book), so only URLs whose *shape*
     * is unseen are candidates. But among unseen shapes, DOM order feeds
     * navigation chrome first — /login, /profile, /swagger all rank ahead of
     * the first book row — and a 5-page crawl of a book store mapped no book.
     * Content is *specific* (deeper paths, query parameters: /books?book=…)
     * while chrome is shallow, so the most specific unseen shape wins. The
     * result reads like a person: the listing, then INTO one representative
     * item, then the rest of the app; never two copies of the same template
     * while anything new remains.
     */
    let pick = 0;
    let bestScore = -1;
    for (const [index, entry] of queue.entries()) {
      if (visitedShapes.has(urlShape(entry.url))) continue;
      const score = urlSpecificity(entry.url);
      if (score > bestScore) {
        bestScore = score;
        pick = index;
      }
    }
    const next = queue.splice(pick, 1)[0]!;
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    visitedShapes.add(urlShape(next.url));

    let snapshot: PageSnapshot;
    try {
      await page.goto(next.url, { waitUntil: 'domcontentloaded' });
      /**
       * Bounded, and failure is not failure. `networkidle` never arrives on an
       * application that polls, and a crawl that treats that as an error maps a
       * dashboard as unreachable. Five seconds of quiet is enough for a snapshot;
       * the timeout is the normal case on a live app, not the exception.
       */
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      snapshot = await extractPage(page);
    } catch (error) {
      unvisited.push({
        url: next.url,
        reason: `Could not load: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    let forms = describeForms(snapshot.elements, entryOrigin);
    let pageHasAuth = forms.some((form) => form.isAuth);
    if (pageHasAuth) wallFound = true;

    /**
     * Log in and keep going.
     *
     * Without this the crawl maps one page and reports an application as almost
     * entirely untested, which is worse than useless: a coverage number computed
     * against the login screen would understate the real gap by an order of
     * magnitude. Attempted once — a second failure is a wrong password, not a
     * transient, and repeating it risks locking the account the organisers lent us.
     */
    if (pageHasAuth && !authenticated && !authAttempted && hasCredentials(credentials)) {
      authAttempted = true;
      const before = page.url();
      const ok = await attemptLogin(page, snapshot, credentials).catch(() => false);

      if (ok) {
        /**
         * Wait for the outcome, not for quiet.
         *
         * The old check waited for network idle (bounded at 5s) and then looked at
         * the page. On a slow public application that races the login itself:
         * OrangeHRM's demo took ~4.4 seconds from click to landing, so the check
         * ran while the sign-in request was still in flight, found the password
         * field still in the DOM, and reported working credentials as refused.
         *
         * The signal that actually distinguishes the outcomes is the password
         * field detaching. A successful login navigates or re-renders away from
         * the form; a refused one re-renders the form with an error, password
         * field intact. So wait for that, generously — a slow success and a
         * refusal look identical until the application answers, and 15 seconds
         * of patience on a wrong password is far cheaper than telling a caller
         * their working credentials failed.
         */
        await page
          .waitForFunction(() => !document.querySelector('input[type="password"]'), undefined, {
            timeout: 15_000,
          })
          .catch(() => {});
        // Then let the landing page settle so the re-extraction maps it, not a spinner.
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        const after = await extractPage(page).catch(() => null);
        const stillHasAuth =
          after ? describeForms(after.elements, entryOrigin).some((form) => form.isAuth) : true;
        /**
         * The field detaching is necessary evidence, not sufficient. A React
         * login form re-rendering its refusal can detach and recreate the
         * password input — demoqa does, live: "Invalid username or password!"
         * on screen, field momentarily gone, and this check called it a
         * verified sign-in. The map then promised authenticated pages, the
         * planner built a login journey on them, and the recording died
         * asserting a book store the login never opened.
         *
         * The corroborating signal is the address: a successful sign-in moves
         * off the login page (a path change, or at minimum a different
         * document), while a refusal re-renders AT the login address. A site
         * that signs in without moving is conservatively read as refused —
         * the note keeps both readings open and the mission continues; the
         * opposite error, claiming verification on a refusal, poisons every
         * decision downstream.
         */
        const movedOn = (() => {
          try {
            const from = new URL(before);
            const to = new URL(page.url());
            return from.origin !== to.origin || from.pathname !== to.pathname;
          } catch {
            return false;
          }
        })();

        if (after && !stillHasAuth && movedOn) {
          /**
           * Keep the sign-in page in the map before moving past it.
           *
           * Replacing the snapshot in place lost it, and with it the most valuable
           * negative test the application offers: a wrong password must fail with a
           * message and must not grant a session. A coverage report that never saw
           * the login form cannot notice that nobody tests it.
           */
          const authPage: PageState = {
            url: before,
            title: snapshot.title,
            elementCount: snapshot.elements.length,
            depth: next.depth,
            forms,
            links: [],
            affordances: affordancesIn(snapshot.elements),
            destructiveActions: destructiveActionsIn(snapshot.elements),
            blindSpots: countBlindSpots(snapshot),
            behindAuth: false,
          };
          pages.push(authPage);
          options.onPage?.(authPage);
          visited.add(normalise(before));

          // Through. Re-map this location as the authenticated page it now is, and
          // let the frontier pick up the links that were never visible before.
          authenticated = true;
          snapshot = after;
          forms = describeForms(after.elements, entryOrigin);
          pageHasAuth = false;
          // Deliberately not registered in `visited` here: the dedupe check below
          // records wherever this iteration landed, and pre-registering it made that
          // check reject the very page the login had just revealed.
          authNoteExtra = `Signed in from ${before} and continued from ${page.url()}.`;
        } else {
          authNoteExtra = movedOn
            ? 'A sign-in was submitted and the form was still present afterwards, so the credentials were refused or the application reported an error.'
            : 'A sign-in was submitted and the browser stayed at the sign-in address, so the credentials were refused or the application reported an error.';
          await page.goto(next.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      } else {
        authNoteExtra = 'A sign-in form was found but its fields could not be completed.';
      }
    }

    const { links, skippedSessionEnding } = sameOriginLinks(
      snapshot.elements,
      entryOrigin,
      page.url(),
    );
    for (const label of skippedSessionEnding) sessionEndingSkipped.add(label);

    /**
     * Dedupe on where we landed, not only on what we asked for. Several distinct
     * URLs redirect to one page — an expired session sends everything to the login
     * screen — and recording each arrival as its own page inflates the map with
     * copies of the same screen.
     */
    const landed = normalise(page.url());
    if (landed !== next.url && visited.has(landed)) {
      unvisited.push({ url: next.url, reason: `Redirected to ${page.url()}, already mapped.` });
      continue;
    }
    visited.add(landed);

    const state: PageState = {
      url: page.url(),
      title: snapshot.title,
      elementCount: snapshot.elements.length,
      depth: next.depth,
      forms,
      links,
      affordances: affordancesIn(snapshot.elements),
      destructiveActions: destructiveActionsIn(snapshot.elements),
      blindSpots: countBlindSpots(snapshot),
      /**
       * Whether reaching this page needed the session the crawl established.
       *
       * Keyed on having authenticated, not on depth. The page you land on after
       * signing in is recorded at the same depth as the login page it replaced, so a
       * depth test marked the whole authenticated application as publicly reachable —
       * and the planner, told a page needed no sign-in, planned a search on it
       * without signing in and resolved nothing.
       */
      behindAuth: authenticated && !pageHasAuth,
    };

    pages.push(state);
    options.onPage?.(state);

    if (next.depth < depthLimit) {
      for (const link of links) {
        if (!visited.has(link) && !queue.some((entry) => entry.url === link)) {
          queue.push({ url: link, depth: next.depth + 1 });
        }
      }
    } else {
      for (const link of links) {
        if (!visited.has(link)) {
          unvisited.push({ url: link, reason: `Beyond the depth limit of ${depthLimit}.` });
        }
      }
    }
  }

  return {
    entryUrl: options.entryUrl,
    pages,
    unvisited: dedupeUnvisited(unvisited),
    auth: {
      wallFound,
      authenticated,
      note: `${authNote(wallFound, authenticated, pages.length)}${
        authNoteExtra ? ` ${authNoteExtra}` : ''
      }${
        sessionEndingSkipped.size
          ? ` Left alone to keep the session: ${[...sessionEndingSkipped].join(', ')}.`
          : ''
      }`.trim(),
    },
    budget: {
      pagesVisited: pages.length,
      pageLimit,
      depthLimit,
      elapsedMs: Date.now() - startedAt,
      exhausted: pages.length >= pageLimit || Date.now() - startedAt > timeBudgetMs,
    },
  };
}

function authNote(wallFound: boolean, authenticated: boolean, pageCount: number): string {
  if (!wallFound) return 'No authentication form was found on the pages reached.';
  if (authenticated) {
    return 'An authentication form was found and the crawl signed in, so what follows covers the application rather than its front door.';
  }
  return `An authentication form was found and nothing beyond it was reached. ${pageCount} page(s) were mapped, which is likely a small part of the application — supply credentials to map the rest.`;
}

function describeForms(elements: ExtractedElement[], origin: string): FormSpec[] {
  const byForm = new Map<number, ExtractedElement[]>();
  for (const element of elements) {
    if (element.formIndex === null) continue;
    const bucket = byForm.get(element.formIndex) ?? [];
    bucket.push(element);
    byForm.set(element.formIndex, bucket);
  }

  const specs: FormSpec[] = [];
  for (const [index, members] of [...byForm.entries()].sort((a, b) => a[0] - b[0])) {
    const controls = members.filter((element) =>
      ['input', 'select', 'textarea'].includes(element.tagName),
    );
    if (!controls.length) continue;

    const fields: FormField[] = controls.map((control) => ({
      label: describe(control),
      inputType: control.inputType ?? (control.tagName === 'select' ? 'select' : 'text'),
      required: control.required,
      name: control.nameAttr,
    }));

    const submit = members.find(
      (element) =>
        element.tagName === 'button' ||
        element.inputType === 'submit' ||
        element.role === 'button',
    );

    // Structural, not lexical: a password field is a password field in any language.
    const isAuth = controls.some((control) => control.inputType === 'password');

    const action = members.find((element) => element.formIndex === index)?.href ?? null;
    const offOrigin = Boolean(action && !action.startsWith(origin));
    const untestableHere: { kind: string; why: string }[] = [];

    if (!submit) {
      untestableHere.push({
        kind: 'no_submit_control',
        why: 'The form has no button or submit input, so there is nothing to press and no submission to check a refusal against.',
      });
    }

    specs.push({
      index,
      fields,
      submitLabel: submit ? describe(submit) : null,
      isAuth,
      untestableHere,
      // Submission-dependent checks are withheld when nothing can submit the form.
      negativeOpportunities: submit ? negativesFor(fields, isAuth) : [],
    });
  }
  return specs;
}

/**
 * Negative tests this form actually affords.
 *
 * Every one is grounded in an observed property — the field exists, and it is
 * required, or it takes an email, or it is a password. Nothing here is a guess
 * about what the application ought to do; each is a test whose *question* the form
 * itself raises, which is what keeps a plan built on this honest.
 */
function negativesFor(fields: FormField[], isAuth: boolean): FormSpec['negativeOpportunities'] {
  const opportunities: FormSpec['negativeOpportunities'] = [];

  const required = fields.filter((field) => field.required);
  if (required.length) {
    opportunities.push({
      field: required.map((field) => field.label).join(', '),
      kind: 'empty_required',
      why: `${required.length} field(s) are marked required, so submitting the form empty should be refused with a message rather than accepted.`,
    });
  }

  for (const field of fields) {
    if (field.inputType === 'email') {
      opportunities.push({
        field: field.label,
        kind: 'malformed_email',
        why: 'The field takes an email address, so a value without an @ should be rejected before submission.',
      });
    }
    if (field.inputType === 'number') {
      opportunities.push({
        field: field.label,
        kind: 'out_of_range',
        why: 'The field takes a number, so a negative or absurd quantity should be refused.',
      });
    }
  }

  if (isAuth) {
    opportunities.push({
      field: 'credentials',
      kind: 'wrong_credential',
      why: 'The form authenticates, so a wrong password should fail with a message and must not grant a session.',
    });
  }

  return opportunities;
}

function describe(element: ExtractedElement): string {
  return (
    element.labelText ||
    element.accessibleName ||
    element.ariaLabel ||
    element.placeholder ||
    element.nameAttr ||
    `${element.tagName}${element.inputType ? `[${element.inputType}]` : ''}`
  );
}

function endsSession(element: ExtractedElement, url: URL): boolean {
  const haystack = `${url.pathname} ${describe(element)}`.toLowerCase();
  return SESSION_ENDING.some((hint) => haystack.includes(hint));
}

function sameOriginLinks(
  elements: ExtractedElement[],
  origin: string,
  currentUrl: string,
): { links: string[]; skippedSessionEnding: string[] } {
  const found = new Set<string>();
  const skipped = new Set<string>();
  for (const element of elements) {
    if (!element.href) continue;
    let url: URL;
    try {
      url = new URL(element.href);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const normalised = normalise(url.href);
    if (normalised === normalise(currentUrl)) continue;
    if (endsSession(element, url)) {
      skipped.add(describe(element));
      continue;
    }
    found.add(normalised);
  }
  return { links: [...found], skippedSessionEnding: [...skipped] };
}

/**
 * The template a URL instantiates, for judging whether a page would teach the
 * map anything new.
 *
 * Path segments that look like identifiers — pure numbers, hex/uuid-ish runs,
 * or anything after a segment like "book", "product", "item", "user" that
 * varies per row — collapse to a placeholder, so `/books/9781449325862` and
 * `/books/9781449331818` share one shape while `/books` and `/checkout` keep
 * their own. Query strings collapse to their sorted key set: `?book=A` and
 * `?book=B` are one shape, `?book=A&tab=reviews` is another. Heuristic on
 * purpose; a wrong merge costs one unexplored sibling, a wrong split costs
 * one page of budget — both bounded.
 */
function urlShape(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((segment) => {
        if (!segment) return segment;
        if (/^\d+$/.test(segment)) return ':id';
        if (/^[0-9a-f]{8,}$/i.test(segment)) return ':id';
        if (/^[A-Za-z0-9_-]*\d{4,}[A-Za-z0-9_-]*$/.test(segment)) return ':id';
        return segment.toLowerCase();
      })
      .join('/');
    const keys = [...u.searchParams.keys()].sort().join(',');
    return `${u.origin}${path}${keys ? `?${keys}` : ''}`;
  } catch {
    return url;
  }
}

/**
 * How specific a URL is: path depth plus query parameters. A detail page
 * (`/books?book=978…`, `/pim/viewPersonalDetails/empNumber/7`) outranks
 * navigation chrome (`/login`, `/profile`) — content over furniture when
 * both are unseen shapes and the budget forces a choice.
 */
function urlSpecificity(url: string): number {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean).length;
    return segments + [...u.searchParams.keys()].length * 2;
  } catch {
    return 0;
  }
}

function destructiveActionsIn(elements: ExtractedElement[]): string[] {
  const found = new Set<string>();
  for (const element of elements) {
    if (!element.interactive) continue;
    const label = describe(element).toLowerCase();
    if (DESTRUCTIVE_HINTS.some((hint) => label.includes(hint))) {
      found.add(describe(element));
    }
  }
  return [...found];
}

/**
 * The named clickable things on a page, for the planner's evidence base.
 *
 * Buttons and links by accessible name, destructive ones excluded (they are
 * listed separately with a do-not-operate instruction), deduplicated and capped:
 * the point is "what can be done here", not an inventory — the recorder gets
 * the full inventory later, against the live page.
 */
function affordancesIn(elements: ExtractedElement[], cap = 15): string[] {
  const found = new Set<string>();
  for (const element of elements) {
    if (!element.interactive) continue;
    if (element.role !== 'button' && element.role !== 'link') continue;
    const name = element.accessibleName.trim();
    if (name.length < 2 || name.length > 60) continue;
    if (DESTRUCTIVE_HINTS.some((hint) => name.toLowerCase().includes(hint))) continue;
    found.add(name);
    if (found.size >= cap) break;
  }
  return [...found];
}

function countBlindSpots(snapshot: PageSnapshot): number {
  const record = snapshot as unknown as Record<string, unknown>;
  const value = record['blindSpots'] ?? record['unreachable'] ?? record['hidden'];
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  return 0;
}

/**
 * A fragment is the same page, so `/catalog` and `/catalog#top` must not both be
 * crawled. A trailing slash is the same page too. The query string is kept: it is
 * usually what makes a listing page a different listing page.
 */
function normalise(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function dedupeUnvisited(
  entries: { url: string; reason: string }[],
): { url: string; reason: string }[] {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (!seen.has(entry.url)) seen.set(entry.url, entry.reason);
  }
  return [...seen.entries()].map(([url, reason]) => ({ url, reason }));
}


function hasCredentials(credentials: { identity?: string; secret?: string }): boolean {
  return Boolean(credentials.identity && credentials.secret);
}

/**
 * Fills and submits the sign-in form using the refs the extractor already stamped
 * onto the DOM, so the crawl locates exactly the elements it described rather than
 * guessing a selector.
 *
 * Returns whether it managed to submit — not whether the login succeeded. Whether
 * it worked is decided by looking at the page afterwards, because a form that
 * accepts a submission and re-renders with an error is indistinguishable from one
 * that succeeded until you look.
 */
async function attemptLogin(
  page: Page,
  snapshot: PageSnapshot,
  credentials: { identity?: string; secret?: string },
): Promise<boolean> {
  const authFormIndexes = new Set(
    snapshot.elements
      .filter((element) => element.inputType === 'password' && element.formIndex !== null)
      .map((element) => element.formIndex as number),
  );
  if (!authFormIndexes.size) return false;
  const formIndex = [...authFormIndexes][0]!;

  const members = snapshot.elements.filter((element) => element.formIndex === formIndex);
  const secretField = members.find((element) => element.inputType === 'password');
  const identityField =
    members.find((element) => element.inputType === 'email') ??
    members.find(
      (element) =>
        element.tagName === 'input' &&
        ['text', 'tel', null].includes(element.inputType) &&
        element !== secretField,
    );
  const submit = members.find(
    (element) =>
      element.tagName === 'button' || element.inputType === 'submit' || element.role === 'button',
  );

  if (!identityField || !secretField) return false;

  const byRef = (element: ExtractedElement) =>
    page.locator(`[${REF_ATTRIBUTE}="${element.ref}"]`);

  await byRef(identityField).fill(credentials.identity!, { timeout: 5_000 });
  await byRef(secretField).fill(credentials.secret!, { timeout: 5_000 });

  if (submit) {
    await byRef(submit).click({ timeout: 5_000 });
  } else {
    // A form with no identifiable submit control still submits on Enter.
    await byRef(secretField).press('Enter');
  }
  return true;
}

/**
 * The pure helpers, exposed for tests.
 *
 * Grouped rather than exported individually so the module's public surface stays
 * `crawl`: URL normalisation and negative derivation are decisions worth pinning
 * down in tests, not API for other modules to build on.
 */
export const __testables = { normalise, endsSession, describe, negativesFor };
