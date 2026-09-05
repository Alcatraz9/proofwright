import type { BoxMetrics } from '../browser/extract.js';
import type { ElementSignature, PageSignature } from '../baseline/visual.js';

/**
 * Decides what kind of visual change happened, which is the whole point.
 *
 * A percentage of differing pixels cannot support a decision. This produces one
 * of four verdicts instead, and each carries a different consequence:
 *
 *   COSMETIC         appearance changed, nothing moved      -> pass, update the record
 *   LAYOUT_SHIFT     something moved or resized             -> warn, a person should look
 *   CONTENT_MISSING  it was there before and is not now      -> fail, never absorbed
 *   CONTENT_ADDED    it is new                               -> report only
 *
 * The split is structural rather than a judgement about which properties
 * "probably" matter: the style metrics are already divided into properties that
 * cannot move anything and properties that can, so a diff confined to the first
 * group is cosmetic by construction.
 */

export type VisualChangeKind =
  | 'COSMETIC'
  | 'LAYOUT_SHIFT'
  | 'CONTENT_MISSING'
  /**
   * Gone from the page, but the locator healer already worked out what replaced
   * it and verified the replacement against the step's original outcome.
   *
   * Without this the two halves of the system contradict each other over one
   * change: the healer reports that a renamed control was found and the flow
   * still works, while the visual pass — which identifies elements by role and
   * name — reports the old name as missing and fails the run. Both are looking at
   * the same rename. Reconciling them is not leniency; it is refusing to report a
   * change twice with two different verdicts.
   */
  | 'CONTENT_REPLACED'
  | 'CONTENT_ADDED'
  | 'TEXT_CHANGED';

export type VisualSeverity = 'info' | 'warn' | 'fail';

export interface PropertyChange {
  property: string;
  from: string;
  to: string;
}

export interface VisualFinding {
  kind: VisualChangeKind;
  severity: VisualSeverity;
  key: string;
  role: string;
  name: string;
  /** Human-readable, because a finding nobody can read gets ignored. */
  summary: string;
  changes: PropertyChange[];
  movedBy: { dx: number; dy: number } | null;
  resizedBy: { dw: number; dh: number } | null;
}

export interface VisualComparison {
  pagePath: string;
  viewport: string;
  findings: VisualFinding[];
  /** Cosmetic-only changes, which the stored signature is updated to absorb. */
  cosmeticCount: number;
  layoutShiftCount: number;
  missingCount: number;
  addedCount: number;
  /** Gone, but reconciled with an accepted locator heal. */
  replacedCount: number;
  /** True when nothing needs a person's attention. */
  clean: boolean;
}

export interface VisualTolerance {
  /** How far an element may move before it counts as having moved, in CSS pixels. */
  positionPx: number;
  /**
   * How much an element may change size, as a fraction and as a floor in pixels.
   *
   * Generous on purpose. Changing a font family is a cosmetic change by any
   * reasonable reading, but it genuinely re-measures every piece of text — a
   * button that keeps its exact position still gets a few pixels wider. A
   * tolerance that could not absorb that would classify every restyle as a
   * reflow, which is precisely the false positive that makes visual testing
   * something teams switch off.
   */
  sizeFraction: number;
  sizeFloorPx: number;
}

export const DEFAULT_TOLERANCE: VisualTolerance = {
  positionPx: 4,
  sizeFraction: 0.08,
  sizeFloorPx: 10,
};

function movedBeyondTolerance(a: BoxMetrics, b: BoxMetrics, tolerance: VisualTolerance): boolean {
  return (
    Math.abs(a.x - b.x) > tolerance.positionPx || Math.abs(a.y - b.y) > tolerance.positionPx
  );
}

function resizedBeyondTolerance(a: BoxMetrics, b: BoxMetrics, tolerance: VisualTolerance): boolean {
  const allowed = (value: number): number =>
    Math.max(tolerance.sizeFloorPx, value * tolerance.sizeFraction);
  return (
    Math.abs(a.width - b.width) > allowed(a.width) ||
    Math.abs(a.height - b.height) > allowed(a.height)
  );
}

function diffStyleGroup(
  before: Record<string, string>,
  after: Record<string, string>,
): PropertyChange[] {
  const changes: PropertyChange[] = [];
  for (const [property, from] of Object.entries(before)) {
    const to = after[property];
    if (to !== undefined && to !== from) changes.push({ property, from, to });
  }
  return changes;
}

function describe(element: ElementSignature): string {
  const name = element.name || element.text || element.key;
  return `${element.role}${name ? ` "${name.slice(0, 40)}"` : ''}`;
}

function summarise(changes: PropertyChange[], limit = 3): string {
  return changes
    .slice(0, limit)
    .map((c) => `${c.property} ${c.from} -> ${c.to}`)
    .join(', ');
}

/**
 * Identities the locator healer has already accounted for during this run, in the
 * same `role:<role>|name:<name>` form `stableKey` produces.
 */
export type ReconciledIdentities = ReadonlySet<string>;

export function comparePageSignature(
  before: PageSignature,
  after: PageSignature,
  tolerance: VisualTolerance = DEFAULT_TOLERANCE,
  reconciled: ReconciledIdentities = new Set(),
): VisualComparison {
  const findings: VisualFinding[] = [];
  const afterByKey = new Map(after.elements.map((e) => [e.key, e]));
  const seen = new Set<string>();

  for (const element of before.elements) {
    const current = afterByKey.get(element.key);
    seen.add(element.key);

    // Present before, absent now. Never softened: an element that has gone is
    // the one visual change that can mean the page is broken, and absorbing it
    // would let a suite go green on a page missing its primary action.
    if (!current) {
      const wasHealed = reconciled.has(element.key);
      findings.push({
        kind: wasHealed ? 'CONTENT_REPLACED' : 'CONTENT_MISSING',
        severity: wasHealed ? 'warn' : 'fail',
        key: element.key,
        role: element.role,
        name: element.name,
        summary: wasHealed
          ? `${describe(element)} is gone, but the healer found what replaced it and the step's original outcome still held.`
          : `${describe(element)} was on this page and is not any more.`,
        changes: [],
        movedBy: null,
        resizedBy: null,
      });
      continue;
    }

    const cosmetic = diffStyleGroup(element.styles.cosmetic, current.styles.cosmetic);
    const structural = diffStyleGroup(element.styles.structural, current.styles.structural);
    const moved = movedBeyondTolerance(element.box, current.box, tolerance);
    const resized = resizedBeyondTolerance(element.box, current.box, tolerance);

    const dx = current.box.x - element.box.x;
    const dy = current.box.y - element.box.y;
    const dw = current.box.width - element.box.width;
    const dh = current.box.height - element.box.height;

    // Anything that moved, resized, or changed a layout-affecting property is a
    // reflow. Reported rather than failed by default, because a deliberate
    // redesign moves things and a suite that fails on that is a suite that gets
    // ignored — but never silently absorbed either.
    if (moved || resized || structural.length > 0) {
      const parts: string[] = [];
      if (moved) parts.push(`moved by ${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy}px`);
      if (resized) parts.push(`resized by ${dw >= 0 ? '+' : ''}${dw} x ${dh >= 0 ? '+' : ''}${dh}px`);
      if (structural.length > 0) parts.push(summarise(structural));

      findings.push({
        kind: 'LAYOUT_SHIFT',
        severity: 'warn',
        key: element.key,
        role: element.role,
        name: element.name,
        summary: `${describe(element)} ${parts.join('; ')}.`,
        changes: [...structural, ...cosmetic],
        movedBy: moved ? { dx, dy } : null,
        resizedBy: resized ? { dw, dh } : null,
      });
      continue;
    }

    // Same box, appearance only. This is the case that should heal itself: a
    // recoloured button is still the same button in the same place, and failing a
    // test over it is exactly the noise that makes people stop running the suite.
    if (cosmetic.length > 0) {
      findings.push({
        kind: 'COSMETIC',
        severity: 'info',
        key: element.key,
        role: element.role,
        name: element.name,
        summary: `${describe(element)} restyled: ${summarise(cosmetic)}. Position and size unchanged.`,
        changes: cosmetic,
        movedBy: null,
        resizedBy: null,
      });
      continue;
    }

    // Text is reported but never decided here. Whether changed text is a failure
    // depends on whether the tester asserted the value, and that question is
    // already answered by the step's own assertions — deciding it twice, in two
    // places, is how the two answers start disagreeing.
    if (element.text !== current.text) {
      findings.push({
        kind: 'TEXT_CHANGED',
        severity: 'info',
        key: element.key,
        role: element.role,
        name: element.name,
        summary: `${describe(element)} text changed: "${element.text.slice(0, 40)}" -> "${current.text.slice(0, 40)}".`,
        changes: [{ property: 'text', from: element.text, to: current.text }],
        movedBy: null,
        resizedBy: null,
      });
    }
  }

  for (const element of after.elements) {
    if (seen.has(element.key)) continue;
    findings.push({
      kind: 'CONTENT_ADDED',
      severity: 'info',
      key: element.key,
      role: element.role,
      name: element.name,
      summary: `${describe(element)} is new on this page.`,
      changes: [],
      movedBy: null,
      resizedBy: null,
    });
  }

  const count = (kind: VisualChangeKind): number => findings.filter((f) => f.kind === kind).length;
  const layoutShiftCount = count('LAYOUT_SHIFT');
  const missingCount = count('CONTENT_MISSING');
  const replacedCount = count('CONTENT_REPLACED');

  return {
    pagePath: before.pagePath,
    viewport: before.viewport,
    findings,
    cosmeticCount: count('COSMETIC'),
    layoutShiftCount,
    missingCount,
    addedCount: count('CONTENT_ADDED'),
    replacedCount,
    clean: layoutShiftCount === 0 && missingCount === 0 && replacedCount === 0,
  };
}

/**
 * Whether a comparison should fail the run.
 *
 * By default it never does. The functional layer decides verdicts; this layer
 * reports. Two things forced that division, and both were found by running it:
 *
 * First, it double-reported. When an element a step depends on disappears, the
 * step already fails with ELEMENT_NOT_FOUND and the run already stops. Failing
 * again here adds nothing and lets the visual pass override a functional verdict
 * it knows less about — including turning a healed, verified, passing run red.
 *
 * Second, it punished the remediation it was meant to encourage. Giving a control
 * a real label changes its accessible name, and an element's visual identity is
 * partly its accessible name, so a correct accessibility fix reads as elements
 * vanishing and others appearing. An accessibility release failed on twenty
 * "missing" elements that were all still there under better names.
 *
 * Strict mode exists for teams who want a hard visual gate and have a baseline
 * stable enough to hold one. It is opt-in because a deliberate redesign produces
 * dozens of findings at once, and a gate that red-lights every intentional change
 * is a gate people learn to route around.
 */
export function shouldFail(comparison: VisualComparison, strict: boolean): boolean {
  if (!strict) return false;
  return comparison.missingCount > 0 || comparison.layoutShiftCount > 0;
}

/**
 * A comparison is absorbed into the stored signature only when every finding is
 * cosmetic or additive. Nothing that a person still needs to look at is quietly
 * recorded as the new normal.
 */
export function isAbsorbable(comparison: VisualComparison): boolean {
  // A replacement is deliberately NOT absorbed. The healer proved the flow still
  // works, which is why it does not fail the run — but a control being replaced
  // is a change a person should still see, and quietly recording it as the new
  // normal would erase the only remaining trace of it.
  return comparison.findings.every(
    (f) => f.kind === 'COSMETIC' || f.kind === 'CONTENT_ADDED' || f.kind === 'TEXT_CHANGED',
  );
}
