import type { Locator as PlaywrightLocator, Page } from 'playwright';
import type { Action } from '../intent/types.js';

export const DEFAULT_TIMEOUT = 8000;

/**
 * Lets an SPA finish reacting before we look at the page again. `networkidle`
 * alone is unreliable on apps that poll, so it is raced against a short ceiling
 * rather than awaited outright.
 */
export async function settle(page: Page, quietMs = 400): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(quietMs);
}

export interface ExecuteParams {
  page: Page;
  action: Action;
  locator: PlaywrightLocator | null;
  /** Already resolved from valueRef — never a secret name, always the real value. */
  value: string | null;
}

export interface AdaptedSelect {
  /** The option value that will actually be selected. */
  value: string;
  /** Present when the intended value was not an option and a substitute was chosen. */
  note: string | null;
}

/**
 * Reconciles an intended value with a `<select>`'s real options, or reports
 * that the element is not a select at all (`null`).
 *
 * Two realities no planner can know in advance meet here. A plan says "fill
 * the departure city" because nothing in prose distinguishes a dropdown from a
 * text field — but Playwright's `fill()` throws on a select, so the action has
 * to become a selection. And an authored value ("Seattle") is a guess made
 * before anyone saw the page; a select only accepts what it offers (Paris,
 * Boston…, live-verified on blazedemo.com). The recorder is standing in front
 * of the real options, so it matches the intent against them — exact value or
 * label first, then containment — and otherwise takes the first real option
 * and says so. A substituted value is a disclosure, not a silent fix.
 */
export async function adaptSelectValue(
  locator: PlaywrightLocator,
  value: string | null,
): Promise<AdaptedSelect | null> {
  const options = await locator
    .evaluate((el) => {
      if (el.tagName.toLowerCase() !== 'select') return null;
      return Array.from((el as HTMLSelectElement).options)
        .filter((option) => !option.disabled)
        .map((option) => ({
          value: option.value,
          label: option.label.replace(/\s+/g, ' ').trim(),
        }));
    })
    .catch(() => null);
  if (!options || options.length === 0) return null;

  const wanted = (value ?? '').trim().toLowerCase();
  const match = wanted
    ? (options.find((o) => o.value.toLowerCase() === wanted || o.label.toLowerCase() === wanted) ??
      options.find(
        (o) =>
          (o.label && o.label.toLowerCase().includes(wanted)) ||
          (o.label && wanted.includes(o.label.toLowerCase())),
      ))
    : undefined;

  const chosen = match ?? options.find((o) => o.value !== '' && o.label !== '') ?? options[0]!;
  const note = match
    ? null
    : `"${value ?? ''}" is not among this select's options; selected "${chosen.label || chosen.value}" (the first real option) instead. The options are: ${options
        .map((o) => o.label || o.value)
        .filter(Boolean)
        .slice(0, 12)
        .join(', ')}.`;
  return { value: chosen.value, note };
}

/**
 * Performs one action. `assert` and `waitFor` only observe: they must never
 * mutate application state, or a verification step would become a side effect.
 */
export async function executeAction({
  page,
  action,
  locator,
  value,
}: ExecuteParams): Promise<void> {
  const options = { timeout: DEFAULT_TIMEOUT };

  switch (action) {
    case 'navigate':
      await page.goto(value ?? '', { timeout: DEFAULT_TIMEOUT });
      return;

    case 'assert':
    case 'waitFor':
      await requireLocator(locator, action).waitFor({ state: 'visible', ...options });
      return;

    case 'click':
      await requireLocator(locator, action).click(options);
      return;

    case 'fill':
      await requireLocator(locator, action).fill(value ?? '', options);
      return;

    case 'select':
      await requireLocator(locator, action).selectOption(value ?? '', options);
      return;

    case 'check':
      await requireLocator(locator, action).check(options);
      return;

    case 'uncheck':
      await requireLocator(locator, action).uncheck(options);
      return;

    case 'hover':
      await requireLocator(locator, action).hover(options);
      return;

    case 'press':
      if (locator) await locator.press(value ?? '', options);
      else await page.keyboard.press(value ?? '');
      return;
  }
}

/** True for actions that only observe — used to decide whether state advanced. */
export function isReadOnly(action: Action): boolean {
  return action === 'assert' || action === 'waitFor' || action === 'hover';
}

function requireLocator(locator: PlaywrightLocator | null, action: Action): PlaywrightLocator {
  if (!locator) throw new Error(`Action "${action}" requires a resolved element.`);
  return locator;
}
