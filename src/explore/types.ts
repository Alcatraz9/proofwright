import { z } from 'zod';

/**
 * What the crawler saw, in a form the planner and the coverage evaluator can both
 * reason over.
 *
 * This is the evidence base that lets the planner stop guessing. The existing
 * planner's governing rule is that every step must trace to something the tester
 * actually wrote, which is what makes its plans trustworthy and also what stops it
 * proposing anything the tester did not think of. A site map widens the admissible
 * evidence without weakening the rule: a step may now trace to the tester's words
 * *or* to a form this crawl actually found. Neither is invention.
 */

export const formFieldSchema = z.object({
  /** How a person would refer to it — label, accessible name, or placeholder. */
  label: z.string(),
  /** `email`, `password`, `text`, `select`… drives what a plausible value looks like. */
  inputType: z.string().nullable(),
  required: z.boolean(),
  /** Names the field, when it has one. Used to describe it, never to locate it. */
  name: z.string().nullable(),
});

export type FormField = z.infer<typeof formFieldSchema>;

export const formSpecSchema = z.object({
  /** Stable within a page: document order. */
  index: z.number(),
  fields: z.array(formFieldSchema),
  /** Accessible name of the control that submits it, when one is identifiable. */
  submitLabel: z.string().nullable(),
  /**
   * Whether this looks like an authentication form. Decided structurally — a
   * password field present — rather than by matching words, so it survives
   * translation and rewording.
   */
  isAuth: z.boolean(),
  /**
   * Fields a negative path can exercise without inventing anything: required
   * fields can be left empty, an email field can be given a malformed address.
   * Derived here so the planner receives affordances rather than raw DOM.
   */
  /**
   * Checks this form invites but cannot be tested here, and why.
   *
   * Kept rather than dropped. A form with no submit control cannot be submitted
   * empty, and a form posting to another origin cannot be exercised without leaving
   * the application — both are facts worth reporting, and both were previously
   * emitted as ordinary gaps that the planner was then asked to fill twice per
   * mission, failing each time.
   */
  untestableHere: z.array(z.object({ kind: z.string(), why: z.string() })),
  negativeOpportunities: z.array(
    z.object({
      field: z.string(),
      kind: z.enum(['empty_required', 'malformed_email', 'wrong_credential', 'out_of_range']),
      why: z.string(),
    }),
  ),
});

export type FormSpec = z.infer<typeof formSpecSchema>;

export const pageStateSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** How many links, buttons and fields were found. Density, at a glance. */
  elementCount: z.number(),
  /** Clicks from the entry URL. Feeds the reachability half of risk scoring. */
  depth: z.number(),
  forms: z.array(formSpecSchema),
  /** Same-origin destinations found here, already resolved and de-duplicated. */
  links: z.array(z.string()),
  /**
   * Named clickable things on this page — buttons and links, by accessible name.
   *
   * The planner's whole discipline is that every step traces to observed
   * evidence, and forms alone are not the evidence: a page whose interactions
   * are links and buttons (a listing, a catalogue, a dashboard) summarised as
   * "no forms" reads as a dead end, and the planner fills the vacuum by
   * inventing plausible affordances — a click on "Add Book" that demoqa's book
   * store never offered, failing the mission at step-1 (live). Capped and
   * defaulted so site maps cached before this field existed still parse.
   */
  affordances: z.array(z.string()).default([]),
  /**
   * Actions that look destructive, by their accessible name. Recorded rather than
   * performed: a crawl that clicks "Delete account" to see what happens has
   * damaged the application it was sent to inspect.
   */
  destructiveActions: z.array(z.string()),
  /** Regions this walker cannot see into. An iframe hides a payment field. */
  blindSpots: z.number(),
  /** True when this page needed an authenticated session to reach. */
  behindAuth: z.boolean(),
});

export type PageState = z.infer<typeof pageStateSchema>;

export const siteMapSchema = z.object({
  entryUrl: z.string(),
  /** Reached and extracted, in the order visited. */
  pages: z.array(pageStateSchema),
  /** Seen but not visited, and why the crawl stopped short of them. */
  unvisited: z.array(z.object({ url: z.string(), reason: z.string() })),
  /**
   * Whether an authentication wall was found, and whether the crawl got past it.
   * A crawl that stopped at a login form saw one page of a ten-page application,
   * and a coverage report built on it would understate the gap enormously — so
   * this is stated rather than inferred from the page count.
   */
  auth: z.object({
    wallFound: z.boolean(),
    authenticated: z.boolean(),
    note: z.string(),
  }),
  budget: z.object({
    pagesVisited: z.number(),
    pageLimit: z.number(),
    depthLimit: z.number(),
    elapsedMs: z.number(),
    exhausted: z.boolean(),
  }),
});

export type SiteMap = z.infer<typeof siteMapSchema>;

/** Total forms across the map — the denominator most coverage questions want. */
export function formCount(map: SiteMap): number {
  return map.pages.reduce((total, page) => total + page.forms.length, 0);
}

/**
 * The map, written for the planner to read.
 *
 * Prose rather than JSON on purpose. This becomes part of an instruction the
 * planner treats as observed evidence, and the existing prompt's governing rule is
 * that every step traces to something real — so what it needs is a description of
 * what is actually there, phrased the way a tester would describe it, not a DOM
 * dump it has to interpret.
 *
 * Bounded, because a fifty-page map would crowd out the rules that make the plan
 * trustworthy.
 */
export function summariseForPlanner(map: SiteMap, maxPages = 4): string {
  const lines: string[] = [];

  lines.push(`The application was explored and these pages were found:`);
  for (const page of map.pages.slice(0, maxPages)) {
    const parts = [`- ${page.url}`];
    if (page.title) parts.push(`titled "${page.title}"`);
    /**
     * Whether a sign-in is needed to be here, stated per page.
     *
     * Not a detail. A page carrying a sign-in form is by definition a page you see
     * *before* signing in, and on most applications signing in navigates away from
     * it — so a plan that signs in and then reaches for something on that page is
     * reaching for something that no longer exists. That is precisely how a
     * newsletter form on the login page defeated three planning attempts.
     */
    if (map.auth.wallFound) {
      parts.push(
        page.behindAuth
          ? '(reachable only after signing in)'
          : page.forms.some((form) => form.isAuth)
            ? '(this is the sign-in page: it is visible only BEFORE signing in, and signing in navigates away from it)'
            : '(reachable without signing in)',
      );
    }
    lines.push(parts.join(' '));

    for (const form of page.forms) {
      const fields = form.fields
        .map((field) => `"${field.label}"${field.required ? ' (required)' : ''}`)
        .join(', ');
      lines.push(
        `    ${form.isAuth ? 'A sign-in form' : 'A form'} with ${fields}${
          form.submitLabel ? `, submitted by "${form.submitLabel}"` : ''
        }.`,
      );
    }
    /**
     * What can actually be clicked here, by name. Without this, a page whose
     * interactions are links and buttons rather than forms reads as a dead end,
     * and the planner fills the vacuum with plausible inventions — a click on
     * "Add Book" that the application never offered fails the mission at
     * step-1 before anything is learned.
     */
    if (page.affordances.length) {
      lines.push(`    Clickable here: ${page.affordances.map((a) => `"${a}"`).join(', ')}.`);
    }
    if (page.destructiveActions.length) {
      lines.push(
        `    Do not operate these, they destroy data: ${page.destructiveActions.join(', ')}.`,
      );
    }
  }

  lines.push(
    'Plan clicks only on things named above. If a journey would need a control this list does not show, the page does not offer it — plan the journey the listed controls support instead.',
  );

  if (map.auth.wallFound) {
    lines.push(
      map.auth.authenticated
        ? 'Sign in only when the page you need is marked as requiring it. Signing in to reach a page that does not need it will navigate away from that page.'
        : 'Signing in is required and could not be completed, so pages beyond it were not seen.',
    );
  }

  return lines.join('\n');
}
