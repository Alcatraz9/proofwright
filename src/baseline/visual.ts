import { z } from 'zod';
import type { Page } from 'playwright';
import {
  extractPage,
  REF_ATTRIBUTE,
  type BoxMetrics,
  type ExtractedElement,
  type StyleMetrics,
} from '../browser/extract.js';

/**
 * What a page looked like, recorded so a later run can say what changed about it
 * and — crucially — what *kind* of change it was.
 *
 * Deliberately not a screenshot. A pixel diff produces one number, and a button
 * that changed colour and a button that moved fifty pixels produce the same
 * number, so the only available verdicts are "identical" and "different by N
 * percent". Neither is actionable, and the second is why visual testing has a
 * reputation for noise: the tool cannot tell a restyle from a regression, so a
 * human has to look at every diff.
 *
 * Comparing geometry and computed style separately can tell them apart, because
 * the properties are split by whether they are capable of moving anything. A
 * screenshot is still captured alongside this, as evidence for a person — but it
 * is never what decides the verdict.
 *
 * Signatures are per page rather than per step. Several steps happen on the same
 * page, and appearance is a property of the page, so recording one per step would
 * store the same thing repeatedly and invite disagreement between copies.
 */

/**
 * Style values as stored, keyed loosely.
 *
 * The extractor pins the exact properties it collects, which is right at capture
 * time. A stored signature must not, because the set worth watching will grow and
 * a baseline recorded before a property existed still has to load — and the
 * comparison is generic over property names regardless, so nothing is lost by
 * keeping the record open.
 */
export interface SignatureStyles {
  cosmetic: Record<string, string>;
  structural: Record<string, string>;
}

export interface ElementSignature {
  /** Identity that survives a restyle. See `stableKey`. */
  key: string;
  role: string;
  name: string;
  text: string;
  box: BoxMetrics;
  styles: SignatureStyles;
}

export interface Viewport {
  label: string;
  width: number;
  height: number;
}

/**
 * Desktop and mobile. Worth both because responsive layout is where reflow
 * actually breaks: a change that is cosmetic at 1280px can be a broken layout at
 * 390px, and a suite that only ever looks at one width cannot see it.
 */
export const VIEWPORTS: Viewport[] = [
  { label: 'desktop', width: 1280, height: 800 },
  { label: 'mobile', width: 390, height: 844 },
];

export interface PageSignature {
  /** Path only, so the same page recorded on another host still matches. */
  pagePath: string;
  viewport: string;
  documentHeight: number;
  elementCount: number;
  elements: ElementSignature[];
}

/**
 * Stored inside the baseline, so schemas are needed for the round trip.
 *
 * Style keys are validated loosely as string maps rather than pinned property by
 * property. The set of properties worth watching will change, and a baseline
 * recorded before a property was added must still load — pinning them would make
 * every existing baseline unreadable the moment the list grew, which is exactly
 * the failure this project already hit once with a plan field.
 */
export const styleMetricsSchema = z.object({
  cosmetic: z.record(z.string(), z.string()),
  structural: z.record(z.string(), z.string()),
});

export const boxMetricsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const elementSignatureSchema = z.object({
  key: z.string(),
  role: z.string(),
  name: z.string(),
  text: z.string(),
  box: boxMetricsSchema,
  styles: styleMetricsSchema,
});

export const pageSignatureSchema = z.object({
  pagePath: z.string(),
  viewport: z.string(),
  documentHeight: z.number(),
  elementCount: z.number(),
  elements: z.array(elementSignatureSchema),
});

/**
 * An identity for an element that does not depend on how it looks.
 *
 * The extractor's own `ref` is assigned per extraction pass, so it cannot match
 * an element across two runs. Matching on position would defeat the point
 * entirely — a moved element would read as one element vanishing and another
 * appearing, which is the single most important case to get right.
 *
 * So identity comes from what the element *is*, in the same durability order the
 * locator strategies use: a test id first, then role and accessible name, then
 * the label it sits beside, and only as a last resort its own text. Anything
 * ambiguous gets an occurrence index appended, because two identical keys would
 * otherwise be compared against each other arbitrarily.
 */
export function stableKey(element: ExtractedElement): string {
  if (element.testId) return `testid:${element.testId}`;
  if (element.accessibleName) return `role:${element.role}|name:${element.accessibleName}`;
  if (element.labelAnchor) return `role:${element.role}|labelledBy:${element.labelAnchor}`;
  if (element.id) return `id:${element.id}`;
  const text = element.text.slice(0, 40);
  if (text) return `tag:${element.tagName}|text:${text}`;
  return `tag:${element.tagName}|box`;
}

/**
 * The same identity, derived from a stored fingerprint instead of a live element.
 *
 * Needed so an accepted heal can be matched against the element that disappeared
 * from the visual signature. Keying that reconciliation on role and accessible
 * name alone missed the most important case: a control with no accessible name
 * keys on its id instead, and a control with no accessible name is exactly what an
 * accessibility remediation replaces. The visual pass then reported the very
 * element the healer had just accounted for as missing content, and failed the run.
 */
export function stableKeyFromFingerprint(fingerprint: {
  testId: string | null;
  role: string;
  accessibleName: string;
  id: string | null;
  tagName: string;
  text: string;
}): string {
  if (fingerprint.testId) return `testid:${fingerprint.testId}`;
  if (fingerprint.accessibleName) return `role:${fingerprint.role}|name:${fingerprint.accessibleName}`;
  if (fingerprint.id) return `id:${fingerprint.id}`;
  const text = fingerprint.text.slice(0, 40);
  if (text) return `tag:${fingerprint.tagName}|text:${text}`;
  return `tag:${fingerprint.tagName}|box`;
}

function withOccurrenceIndex(elements: ExtractedElement[]): ElementSignature[] {
  const seen = new Map<string, number>();
  return elements.map((element) => {
    const base = stableKey(element);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      key: count === 0 ? base : `${base}#${count}`,
      role: element.role,
      name: element.accessibleName,
      text: element.text.slice(0, 80),
      box: element.box,
      styles: element.styles,
    };
  });
}

/** Path plus a normalised id segment, matching how the replay compares pages. */
export function pagePathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/$/, '') || '/';
  } catch {
    return url;
  }
}

/**
 * Marks a region as scaffolding or known-volatile, excluded from the visual
 * signature.
 *
 * Needed as soon as the comparison works, because a page almost always contains
 * something that changes for reasons nobody is testing: a timestamp, a session
 * id, an ad slot, a build label. Here it is the fixture's own version banner,
 * which names the version being served — longer text in one version, so at a
 * narrow viewport it wraps to a second line and pushes the entire page down. That
 * reported six layout shifts on a login form that had not been touched.
 *
 * Excluding it is not hiding a real change. The banner is not part of the
 * application under test; it exists so a human can see which version they are
 * looking at.
 *
 * A real limit worth knowing: this removes an element from the comparison, not
 * from the layout. An ignored region that changes height still pushes everything
 * below it, and those elements genuinely did move — so they are still reported,
 * correctly. Excluding a volatile region is therefore only half a fix; the region
 * also has to be prevented from resizing, which for scaffolding means giving it a
 * fixed height.
 */
export const VISUAL_IGNORE_ATTRIBUTE = 'data-qa-visual-ignore';

async function ignoredRefs(page: Page): Promise<Set<string>> {
  const selector = `[${VISUAL_IGNORE_ATTRIBUTE}], [${VISUAL_IGNORE_ATTRIBUTE}] *`;
  const refs = await page
    .$$eval(selector, (elements, attribute) => {
      return elements
        .map((el) => el.getAttribute(attribute))
        .filter((value): value is string => Boolean(value));
    }, REF_ATTRIBUTE)
    .catch(() => [] as string[]);
  return new Set(refs);
}

/**
 * Records one page at one viewport.
 *
 * The viewport is set and the page is given a moment before measuring: a resize
 * triggers reflow, and measuring mid-reflow would record boxes that were never
 * what a user saw and would then differ on every run.
 */
export async function capturePageSignature(page: Page, viewport: Viewport): Promise<PageSignature> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(120);

  const snapshot = await extractPage(page);
  const ignored = await ignoredRefs(page);
  const considered = snapshot.elements.filter((element) => !ignored.has(element.ref));

  const documentHeight = await page
    .evaluate(() => document.documentElement.scrollHeight)
    .catch(() => 0);

  return {
    pagePath: pagePathOf(snapshot.url),
    viewport: viewport.label,
    documentHeight,
    elementCount: considered.length,
    elements: withOccurrenceIndex(considered),
  };
}

/** Records every configured viewport, restoring the original size afterwards. */
export async function capturePageSignatures(
  page: Page,
  viewports: Viewport[] = VIEWPORTS,
): Promise<PageSignature[]> {
  const original = page.viewportSize();
  const signatures: PageSignature[] = [];
  try {
    for (const viewport of viewports) {
      signatures.push(await capturePageSignature(page, viewport));
    }
  } finally {
    // Restored so the visual pass cannot change what the functional steps see.
    if (original) await page.setViewportSize(original).catch(() => {});
  }
  return signatures;
}

/**
 * Captures each distinct page once as a run walks through it.
 *
 * Once per page rather than once per step: a flow of seven steps typically visits
 * four or five pages, and capturing per step would record the login page three
 * times over. Deduplicating by path also means the record does not depend on how
 * the test happened to be decomposed into steps.
 */
export class VisualRecorder {
  private readonly seen = new Set<string>();
  private readonly collected: PageSignature[] = [];

  constructor(private readonly viewports: Viewport[] = VIEWPORTS) {}

  /** Returns the signatures captured, or null when this page is already recorded. */
  async captureIfNew(page: Page): Promise<PageSignature[] | null> {
    const key = pagePathOf(page.url());
    if (this.seen.has(key)) return null;
    this.seen.add(key);

    const signatures = await capturePageSignatures(page, this.viewports);
    this.collected.push(...signatures);
    return signatures;
  }

  get signatures(): PageSignature[] {
    return this.collected;
  }
}

/** Finds the recorded signature for a page at a viewport, if there is one. */
export function findSignature(
  signatures: PageSignature[],
  pagePath: string,
  viewport: string,
): PageSignature | undefined {
  return signatures.find((s) => s.pagePath === pagePath && s.viewport === viewport);
}
