import type { Page } from 'playwright';
import { auditPage, type A11yPageAudit } from '../browser/a11y.js';
import { auditSecurity, type SecurityAudit } from '../run/security.js';
import type { HealthMonitor } from '../run/health.js';
import type { Baseline } from '../baseline/types.js';
import {
  capturePageSignatures,
  findSignature,
  pagePathOf,
  stableKeyFromFingerprint,
  type PageSignature,
} from '../baseline/visual.js';
import type { Fingerprint } from '../baseline/types.js';
import {
  comparePageSignature,
  DEFAULT_TOLERANCE,
  isAbsorbable,
  shouldFail,
  type VisualComparison,
} from '../run/visual-compare.js';

/**
 * Runs the visual pass during a replay and decides what to do with the result.
 *
 * The consequential part is the absorb rule. A cosmetic-only change updates the
 * stored signature, so the next run compares against the new appearance and does
 * not report the same restyle forever. That is the visual equivalent of healing a
 * locator, and it obeys the same constraint the rest of this system does: the
 * TEST record is updated, never the application.
 *
 * A comparison containing anything a person still needs to see is not absorbed.
 * The point is not to make the run green, it is to stop appearance changes
 * drowning out the ones that matter.
 */

export interface InspectionTotals {
  /** Lowest score seen, since one bad page is the page that matters. */
  a11yScore: number | null;
  securityScore: number | null;
  a11yViolations: number;
  securityFindings: number;
}

export interface VisualOutcome {
  a11y: A11yPageAudit[];
  security: SecurityAudit[];
  totals: InspectionTotals;
  comparisons: VisualComparison[];
  /** Signatures to write back, replacing the absorbed ones. */
  absorbed: PageSignature[];
  /** Pages recorded for the first time — a page the baseline had never seen. */
  added: PageSignature[];
  failures: VisualComparison[];
}

export interface VisualPassOptions {
  baseline: Baseline;
  strict?: boolean;
  /** Fired live, as each page is measured. */
  onCaptured?: (signature: PageSignature) => void;
  /** Fired once at the end, when every heal in the run is known. */
  onComparison?: (comparison: VisualComparison, absorbed: boolean) => void;
  onFirstSight?: (signature: PageSignature) => void;
  onA11y?: (audit: A11yPageAudit) => void;
  onSecurity?: (audit: SecurityAudit) => void;
  /** Supplies the response a page was served with, for the header checks. */
  monitor?: HealthMonitor;
}

export class VisualPass {
  private readonly seen = new Set<string>();
  /**
   * Filled by the run as heals are accepted, so a control the healer already
   * accounted for is not also reported as missing.
   */
  private readonly reconciled = new Set<string>();
  /**
   * Captured pairs, held until the run finishes.
   *
   * Classification is deliberately deferred rather than done as each page is
   * reached. A page is inspected when a step on it passes, but the heal that
   * explains a vanished control happens on a *later* step — so classifying
   * immediately meant deciding without information that had not arrived yet, and
   * the basket page reported its checkout link as missing content a moment before
   * the healer identified what had replaced it.
   *
   * Capturing is still done live, because it has to be: the page only looks like
   * that while the run is standing on it.
   */
  private readonly captured: { recorded: PageSignature; current: PageSignature }[] = [];
  private readonly added: PageSignature[] = [];
  private readonly a11y: A11yPageAudit[] = [];
  private readonly security: SecurityAudit[] = [];

  constructor(private readonly options: VisualPassOptions) {}

  /**
   * Records that a locator heal accounted for an element.
   *
   * Derived through the same precedence the visual signature uses, so a control
   * with no accessible name — the case an accessibility fix exists to correct —
   * reconciles on its id rather than being missed entirely.
   */
  reconcileHealedElement(fingerprint: Fingerprint): void {
    this.reconciled.add(stableKeyFromFingerprint(fingerprint));
  }

  /**
   * Captures the current page if it has not been captured in this run.
   *
   * Once per page for the same reason recording is: several steps share a page,
   * and re-measuring it per step would cost two viewport changes each time and
   * report one restyle repeatedly.
   */
  async inspect(page: Page, monitor?: HealthMonitor): Promise<void> {
    const pagePath = pagePathOf(page.url());
    if (this.seen.has(pagePath)) return;
    this.seen.add(pagePath);

    // All three analyses share the one page visit. Accessibility and security are
    // measured before the viewport is resized for the visual capture, so they see
    // the page as the run actually used it.
    try {
      const audit = await auditPage(page, pagePath);
      this.a11y.push(audit);
      this.options.onA11y?.(audit);
    } catch {
      /* an analyser that cannot run is not the application's fault */
    }

    try {
      const audit = await auditSecurity({
        page,
        pagePath,
        documentResponse: monitor?.documentResponse() ?? this.options.monitor?.documentResponse() ?? null,
      });
      this.security.push(audit);
      this.options.onSecurity?.(audit);
    } catch {
      /* likewise */
    }

    const current = await capturePageSignatures(page);

    for (const signature of current) {
      const recorded = findSignature(
        this.options.baseline.visualBaselines,
        pagePath,
        signature.viewport,
      );

      // A page the baseline never captured. Recorded rather than reported as a
      // difference: there is nothing to compare it against, and calling that a
      // finding would flag every page on the first run after visual capture was
      // added to an existing baseline.
      if (!recorded) {
        this.added.push(signature);
        this.options.onFirstSight?.(signature);
        continue;
      }

      this.captured.push({ recorded, current: signature });
      this.options.onCaptured?.(signature);
    }
  }

  /** Compares everything captured, now that the run's heals are all known. */
  result(): VisualOutcome {
    const strict = this.options.strict ?? false;
    const comparisons: VisualComparison[] = [];
    const absorbed: PageSignature[] = [];

    for (const { recorded, current } of this.captured) {
      const comparison = comparePageSignature(
        recorded,
        current,
        DEFAULT_TOLERANCE,
        this.reconciled,
      );
      comparisons.push(comparison);

      const absorb = isAbsorbable(comparison) && comparison.findings.length > 0;
      if (absorb) absorbed.push(current);

      this.options.onComparison?.(comparison, absorb);
    }

    // Worst score across the pages visited, not an average. Averaging would let a
    // single unusable page hide behind four good ones, and the unusable page is the
    // one that decides whether the journey works.
    const worst = (values: number[]): number | null =>
      values.length === 0 ? null : Math.min(...values);

    return {
      a11y: this.a11y,
      security: this.security,
      totals: {
        a11yScore: worst(this.a11y.map((a) => a.score)),
        securityScore: worst(this.security.map((a) => a.score)),
        a11yViolations: this.a11y.reduce((total, a) => total + a.violations.length, 0),
        securityFindings: this.security.reduce((total, a) => total + a.findings.length, 0),
      },
      comparisons,
      absorbed,
      added: this.added,
      failures: comparisons.filter((c) => shouldFail(c, strict)),
    };
  }
}

/**
 * Merges absorbed and newly-seen signatures into a baseline's stored set.
 *
 * Replaces by page and viewport rather than appending, or a baseline would grow a
 * new copy of the same page on every run and the comparison would then pick
 * whichever it found first.
 */
export function mergeVisualBaselines(
  existing: PageSignature[],
  updates: PageSignature[],
): PageSignature[] {
  if (updates.length === 0) return existing;

  const key = (signature: PageSignature): string => `${signature.pagePath}|${signature.viewport}`;
  const merged = new Map(existing.map((signature) => [key(signature), signature]));
  for (const update of updates) merged.set(key(update), update);
  return [...merged.values()];
}
