import { createRequire } from 'node:module';
import fs from 'node:fs';
import type { Locator as PlaywrightLocator, Page } from 'playwright';

/**
 * Accessibility auditing, in two layers.
 *
 * The page-level layer is axe-core, which is the honest way to do this: WCAG has
 * a lot of rules and hand-rolling a subset produces a score that sounds
 * authoritative and means nothing.
 *
 * The per-element layer is the interesting one, and it is not a duplicate. It
 * checks the specific controls the test actually touches, and it exists because
 * accessibility and test durability turn out to be the same property measured
 * twice. Locator strategies rank `role` + accessible name second only to a test
 * id, so a button with no accessible name is both a WCAG failure and the reason a
 * test pointing at it is fragile — and the reason healing it is harder, because
 * the healer has less to reason about. An element that is easy to describe to a
 * screen reader is easy to describe to a locator.
 */

const require_ = createRequire(import.meta.url);

let axeSource: string | null = null;

function axeScript(): string {
  if (axeSource) return axeSource;
  axeSource = fs.readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';

export const IMPACT_ORDER: Impact[] = ['critical', 'serious', 'moderate', 'minor'];

export interface A11yViolation {
  id: string;
  impact: Impact;
  help: string;
  helpUrl: string;
  /** WCAG tags, e.g. wcag2aa, wcag143. */
  tags: string[];
  nodeCount: number;
  /** A couple of examples, enough to find it without dumping the DOM. */
  samples: { target: string; failureSummary: string }[];
}

export interface A11yPageAudit {
  pagePath: string;
  violations: A11yViolation[];
  passCount: number;
  incompleteCount: number;
  byImpact: Record<Impact, number>;
  /**
   * A single number so a change between runs is legible.
   *
   * Weighted by impact, because a count alone would let ten minor issues look
   * worse than one critical failure that stops a screen reader dead. Not a WCAG
   * conformance measure and not presented as one — it exists so "did this get
   * better or worse" has an answer.
   */
  score: number;
}

interface AxeResult {
  violations: {
    id: string;
    impact: string | null;
    help: string;
    helpUrl: string;
    tags: string[];
    nodes: { target: string[]; failureSummary?: string }[];
  }[];
  passes: unknown[];
  incomplete: unknown[];
}

const IMPACT_WEIGHT: Record<Impact, number> = {
  critical: 10,
  serious: 5,
  moderate: 2,
  minor: 1,
};

function normaliseImpact(value: string | null): Impact {
  return IMPACT_ORDER.includes(value as Impact) ? (value as Impact) : 'minor';
}

/**
 * Runs axe against the current page.
 *
 * Injected from the installed package rather than a CDN: a test runner that needs
 * the network to audit a page cannot audit a page on a machine without it, and a
 * hosted container may well not have general egress.
 */
export async function auditPage(page: Page, pagePath: string): Promise<A11yPageAudit> {
  await page.evaluate(axeScript());

  const result = (await page.evaluate(async () => {
    const axe = (window as unknown as { axe?: { run: (opts: unknown) => Promise<unknown> } }).axe;
    if (!axe) throw new Error('axe-core did not attach to the page.');
    return axe.run({
      // A and AA only. AAA is a policy choice most teams have not made, and
      // reporting it as a failure would bury the ones they have.
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations', 'incomplete'],
    });
  })) as AxeResult;

  const violations: A11yViolation[] = result.violations.map((violation) => ({
    id: violation.id,
    impact: normaliseImpact(violation.impact),
    help: violation.help,
    helpUrl: violation.helpUrl,
    tags: violation.tags.filter((tag) => tag.startsWith('wcag')),
    nodeCount: violation.nodes.length,
    samples: violation.nodes.slice(0, 2).map((node) => ({
      target: node.target.join(' '),
      failureSummary: (node.failureSummary ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    })),
  }));

  const byImpact: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let weighted = 0;
  for (const violation of violations) {
    byImpact[violation.impact] += violation.nodeCount;
    weighted += IMPACT_WEIGHT[violation.impact] * violation.nodeCount;
  }

  return {
    pagePath,
    violations,
    passCount: result.passes.length,
    incompleteCount: result.incomplete.length,
    byImpact,
    // Bounded at zero so a very poor page does not produce a negative that makes
    // a chart unreadable.
    score: Math.max(0, 100 - weighted),
  };
}

// ---------------------------------------------------------------------------
// Per-element checks on the controls the test actually drives
// ---------------------------------------------------------------------------

export interface ElementA11yFinding {
  stepId: string;
  check: 'accessibleName' | 'placeholderOnlyName' | 'focusable' | 'contrast' | 'role';
  severity: 'warn' | 'info';
  message: string;
  /** Why this also matters to the test, not only to a user. */
  testabilityNote: string | null;
}

/** Relative luminance per WCAG, used for the contrast ratio. */
function luminance(rgb: [number, number, number]): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function parseRgb(value: string): [number, number, number] | null {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseRgb(foreground);
  const bg = parseRgb(background);
  if (!fg || !bg) return null;
  const lighter = Math.max(luminance(fg), luminance(bg));
  const darker = Math.min(luminance(fg), luminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Checks the element a step drives.
 *
 * The `testabilityNote` is the point of this layer. It says why a finding is not
 * only an accessibility problem: the same missing accessible name that stops a
 * screen reader announcing a button is what forces the locator down to matching
 * on raw text, and raw text breaks on the next copy edit.
 */
/** The minimum an element must expose to be checked. Satisfied by `ExtractedElement`. */
export interface CheckableElement {
  role: string;
  accessibleName: string;
  ariaLabel: string | null;
  labelText: string | null;
  placeholder: string | null;
  text: string;
  interactive: boolean;
  enabled: boolean;
  color: string;
  backgroundColor: string;
}

export function checkElement(stepId: string, element: CheckableElement): ElementA11yFinding[] {
  const findings: ElementA11yFinding[] = [];
  const interactive = element.interactive;

  // A placeholder counts towards the accessible name — the spec says so and
  // Playwright computes it that way, so excluding it made this layer contradict the
  // locator printed on the same line: a control found by `role=searchbox[name="…"]`
  // was simultaneously reported as having no name. But it is a weak name, so the two
  // cases are separated rather than merged.
  const namedOnlyByPlaceholder =
    interactive &&
    !element.ariaLabel &&
    !element.labelText &&
    !element.text &&
    Boolean(element.placeholder);

  if (namedOnlyByPlaceholder) {
    findings.push({
      stepId,
      check: 'placeholderOnlyName',
      severity: 'warn',
      message: `A ${element.role} is named only by its placeholder, which disappears once the field has content.`,
      testabilityNote:
        'A placeholder is the weakest name a locator can match on: it is copy, so it changes ' +
        'when the wording changes, and adding a real label — the accessibility fix — changes ' +
        'the name and breaks the locator. That is not a reason to skip the fix; it is a reason ' +
        'the test needs to be able to repair itself.',
    });
  }

  if (interactive && !element.accessibleName && !element.ariaLabel && !element.labelText) {
    findings.push({
      stepId,
      check: 'accessibleName',
      severity: 'warn',
      message: `A ${element.role} the test interacts with has no accessible name.`,
      testabilityNote:
        'Locators rank role plus accessible name second only to a test id. With no name, ' +
        'this control can only be found by its raw text or its position — both of which ' +
        'break on the next copy edit or reorder, and both of which give a healer less to ' +
        'work from.',
    });
  }

  if (interactive && element.role === 'generic') {
    findings.push({
      stepId,
      check: 'role',
      severity: 'warn',
      message: 'An interactive element has no role a screen reader can announce.',
      testabilityNote:
        'A control with no role cannot be located by role either, so the test falls back to ' +
        'CSS or text — the two least durable strategies available.',
    });
  }

  if (interactive && !element.enabled) {
    findings.push({
      stepId,
      check: 'focusable',
      severity: 'info',
      message: 'The element is disabled at the point the test reaches it.',
      testabilityNote: null,
    });
  }

  const ratio = contrastRatio(element.color, element.backgroundColor);
  if (ratio !== null && ratio < 4.5 && element.text) {
    findings.push({
      stepId,
      check: 'contrast',
      severity: 'warn',
      message: `Text contrast is ${ratio.toFixed(2)}:1, below the 4.5:1 WCAG AA minimum.`,
      testabilityNote: null,
    });
  }

  return findings;
}

/**
 * Checks the single element a step drove, read straight from the live page.
 *
 * Takes a Playwright locator rather than an extraction ref. Refs are assigned per
 * extraction pass, so a ref-based signature forced a full page extraction for every
 * step — a hundred-odd elements measured to ask four questions about one of them.
 * Reading the one element directly is a single evaluate.
 *
 * The background colour walks up the ancestors until something other than
 * `transparent` is found, because a button's own background is frequently
 * unset and comparing text against `rgba(0,0,0,0)` would report every element
 * as a contrast failure.
 */
export async function checkStepElement(params: {
  page: Page;
  stepId: string;
  locator: PlaywrightLocator;
}): Promise<ElementA11yFinding[]> {
  const shape = await params.locator
    .evaluate((el: Element): CheckableElement => {
      const style = window.getComputedStyle(el);
      const tag = el.tagName.toLowerCase();

      const effectiveBackground = (node: Element | null): string => {
        while (node) {
          const value = window.getComputedStyle(node).backgroundColor;
          if (value && value !== 'transparent' && !value.startsWith('rgba(0, 0, 0, 0)')) {
            return value;
          }
          node = node.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };

      const explicitRole = el.getAttribute('role');
      const implicitRole = ((): string => {
        if (explicitRole) return explicitRole;
        if (tag === 'button' || tag === 'summary') return 'button';
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          const type = (el.getAttribute('type') ?? 'text').toLowerCase();
          if (['button', 'submit', 'reset'].includes(type)) return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        if (/^h[1-6]$/.test(tag)) return 'heading';
        return 'generic';
      })();

      const labelledBy = el.getAttribute('aria-labelledby');
      const labelledByText = labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim()
        : '';

      const id = el.getAttribute('id');
      const explicitLabel = id
        ? (document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '')
        : '';
      const wrappingLabel = el.closest('label')?.textContent ?? '';
      const labelText = (explicitLabel || wrappingLabel).replace(/\s+/g, ' ').trim() || null;

      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const ariaLabel = el.getAttribute('aria-label');
      const placeholder = el.getAttribute('placeholder');

      // Accessible-name precedence, simplified: aria-labelledby, aria-label, a real
      // label, then the element's own text, then alt or title.
      // Precedence per the accessible-name computation, simplified: aria-labelledby,
      // aria-label, a real label, own text, alt, title, then placeholder last.
      const accessibleName =
        labelledByText ||
        (ariaLabel ?? '') ||
        (labelText ?? '') ||
        text ||
        el.getAttribute('alt') ||
        el.getAttribute('title') ||
        (placeholder ?? '') ||
        '';

      const interactive =
        ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'searchbox'].includes(
          implicitRole,
        ) || el.hasAttribute('onclick');

      return {
        role: implicitRole,
        accessibleName: accessibleName.replace(/\s+/g, ' ').trim(),
        ariaLabel,
        labelText,
        placeholder,
        text,
        interactive,
        enabled: !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
        color: style.color,
        backgroundColor: effectiveBackground(el),
      };
    })
    .catch(() => null);

  return shape ? checkElement(params.stepId, shape) : [];
}
