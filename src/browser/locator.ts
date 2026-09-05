import type { Locator as PlaywrightLocator, Page } from 'playwright';
import type { Locator } from '../baseline/types.js';
import { REF_ATTRIBUTE, type ExtractedElement } from './extract.js';

const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Turns a stored locator record into a live Playwright locator. */
export function buildLocator(page: Page, locator: Locator): PlaywrightLocator {
  const resolved = resolveStrategy(page, locator);
  return locator.nth === null ? resolved : resolved.nth(locator.nth);
}

function resolveStrategy(page: Page, locator: Locator): PlaywrightLocator {
  const value = locator.value ?? '';

  switch (locator.strategy) {
    case 'testId':
      // Matched against every known test-id attribute, since apps disagree on which.
      return page.locator(TEST_ID_ATTRS.map((a) => `[${a}="${cssEscape(value)}"]`).join(','));
    case 'role':
      return page.getByRole(locator.role as Parameters<Page['getByRole']>[0], {
        ...(locator.name ? { name: locator.name, exact: true } : {}),
      });
    case 'label':
      return page.getByLabel(value, { exact: true });
    case 'labelledBy':
      // XPath because no built-in locator expresses "the sibling after the
      // element whose text is X". `text()` rather than `.` restricts the match
      // to the label's own text, so a wrapper that merely contains the label
      // does not match. Quotes are excluded when the anchor is recorded.
      return page.locator(
        `xpath=//*[normalize-space(text())="${value}"]/following-sibling::*[1]`,
      );
    case 'placeholder':
      return page.getByPlaceholder(value, { exact: true });
    case 'altText':
      return page.getByAltText(value, { exact: true });
    case 'text':
      return page.getByText(value, { exact: true });
    case 'css':
      return page.locator(value);
  }
}

export function describeLocator(locator: Locator): string {
  const base =
    locator.strategy === 'role'
      ? locator.name === null
        ? `role=${locator.role}`
        : `role=${locator.role}[name="${locator.name}"]`
      : locator.strategy === 'labelledBy'
        ? `after label "${locator.value ?? ''}"`
        : `${locator.strategy}="${locator.value ?? ''}"`;
  return locator.nth === null ? base : `${base} >> nth=${locator.nth}`;
}

/**
 * Candidate locators for an element, most durable first.
 *
 * The ordering is the whole point: a test id survives a redesign, an accessible
 * name usually survives a restyle, and visible text is the first thing a copy
 * change breaks. Anything derived from DOM position is deliberately absent —
 * a locator we cannot explain is a locator we cannot heal.
 */
export function deriveLocatorCandidates(element: ExtractedElement): Locator[] {
  const candidates: Locator[] = [];
  const add = (locator: Omit<Locator, 'nth'>) => candidates.push({ ...locator, nth: null });

  if (element.testId) {
    add({ strategy: 'testId', value: element.testId, role: null, name: null });
  }
  if (element.accessibleName) {
    add({ strategy: 'role', value: null, role: element.role, name: element.accessibleName });
  }
  if (element.labelText) {
    add({ strategy: 'label', value: element.labelText, role: null, name: null });
  }
  // Ranked above every content-derived strategy. For a value element this is the
  // only candidate whose identity survives the value changing, so it must beat
  // the element's own text even though text would also match today.
  if (element.labelAnchor) {
    add({ strategy: 'labelledBy', value: element.labelAnchor, role: null, name: null });
  }
  if (element.placeholder) {
    add({ strategy: 'placeholder', value: element.placeholder, role: null, name: null });
  }
  if (element.altText) {
    add({ strategy: 'altText', value: element.altText, role: null, name: null });
  }
  if (element.id) {
    add({ strategy: 'css', value: `#${CSS_ID_SAFE.test(element.id) ? element.id : cssEscape(element.id)}`, role: null, name: null });
  }
  if (element.nameAttr) {
    add({
      strategy: 'css',
      value: `${element.tagName}[name="${cssEscape(element.nameAttr)}"]`,
      role: null,
      name: null,
    });
  }
  // Kept even when the text equals the accessible name. The two look redundant but
  // fail under different conditions: a rename breaks both (correctly a healing case),
  // while a <button> refactored into an <a> breaks only the role locator. That
  // refactor is common enough that the text locator earns its place.
  if (element.text && element.text.length <= 60) {
    add({ strategy: 'text', value: element.text, role: null, name: null });
  }

  /**
   * An interactive element whose label lives inside a descendant.
   *
   * `<button><i class="fa fa-sign-in"> Login</i></button>` is a normal
   * icon-and-label button and it defeats both earlier strategies: our own accessible
   * name comes back empty, and a text locator resolves to the innermost node — the
   * `<i>` — so uniqueness verification correctly rejects it for selecting something
   * other than the element the model chose. The result was a real login button that
   * could not be located at all.
   *
   * Playwright's own accessible-name computation *does* include descendant text, so
   * asking for the role by that text finds the button rather than its icon. Added
   * last, because it is a recovery for markup the earlier strategies cannot describe
   * rather than a better way to describe markup they can.
   */
  if (
    !element.accessibleName &&
    element.interactive &&
    element.role &&
    element.text &&
    element.text.length <= 60
  ) {
    add({ strategy: 'role', value: null, role: element.role, name: element.text });
  }

  /**
   * A live region or dialog, located by bare role.
   *
   * ARIA never derives these roles' names from their contents, so the named
   * role candidate above is dead on arrival for them: our extractor names an
   * `<div role="alert">Invalid credentials</div>` from its text, but Playwright
   * computes no name for it and `getByRole('alert', { name: ... })` matches
   * nothing. A text candidate resolves to the inner `<p>` — a different element
   * — so verification correctly rejects that too. The result was a real,
   * persistent error message that could not be located at all (OrangeHRM's
   * invalid-credentials alert, live-verified).
   *
   * A bare `getByRole('alert')` is the honest durable locator here: these roles
   * are announcements and containers that normally occur once. When more than
   * one exists, uniqueness verification demotes this to positional or rejects
   * it, same as every other candidate.
   */
  if (element.role && BARE_ROLE_LOCATABLE.has(element.role)) {
    add({ strategy: 'role', value: null, role: element.role, name: null });
  }

  return candidates;
}

/** Roles whose accessible name never comes from contents (ARIA "name from author"). */
const BARE_ROLE_LOCATABLE = new Set([
  'alert',
  'alertdialog',
  'dialog',
  'status',
  'log',
  'marquee',
  'timer',
]);

const CSS_ID_SAFE = /^[A-Za-z][\w-]*$/;

export interface ResolvedLocators {
  primary: Locator;
  fallbacks: Locator[];
}

/**
 * Verifies each candidate against the live page and keeps only those that
 * actually resolve back to the element the model chose.
 *
 * This is the "Playwright verifies" half applied at baseline time: a locator is
 * never written to a baseline on the strength of looking plausible, only after
 * it has been proven to select this exact element and nothing else.
 */
export async function resolveLocators(
  page: Page,
  element: ExtractedElement,
): Promise<ResolvedLocators | null> {
  const candidates = deriveLocatorCandidates(element);
  const unique: Locator[] = [];
  const positional: Locator[] = [];

  for (const candidate of candidates) {
    const locator = buildLocator(page, candidate);
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;

    if (count === 1) {
      if (await matchesRef(locator, element.ref)) unique.push(candidate);
      continue;
    }

    // Ambiguous on its own. Usable only if our element sits at a known index.
    const index = await indexOfRef(locator, count, element.ref);
    if (index !== null) positional.push({ ...candidate, nth: index });
  }

  // Every unique locator outranks every positional one, even a unique locator
  // from a weaker strategy. `nth` encodes "the third thing that looks like this",
  // which says nothing about the element and silently retargets when the page
  // reorders — a wrong element that still passes is worse than a clean break.
  const verified = [...unique, ...positional];
  const [primary, ...fallbacks] = verified;
  return primary ? { primary, fallbacks } : null;
}

async function matchesRef(locator: PlaywrightLocator, ref: string): Promise<boolean> {
  const found = await locator
    .getAttribute(REF_ATTRIBUTE, { timeout: 2000 })
    .catch(() => null);
  return found === ref;
}

async function indexOfRef(
  locator: PlaywrightLocator,
  count: number,
  ref: string,
  maxScan = 20,
): Promise<number | null> {
  for (let i = 0; i < Math.min(count, maxScan); i++) {
    if (await matchesRef(locator.nth(i), ref)) return i;
  }
  return null;
}
