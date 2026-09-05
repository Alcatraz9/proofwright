/**
 * The server sends locators as the string `describeLocator` produces, not as a
 * structure. That is the right wire format — it is what a person reads — but the
 * interface has to name the *strategy* rather than print a selector, because the
 * strategy is the claim being made about durability.
 *
 * So the string is parsed back into its strategy here. The grammar is small and
 * entirely ours:
 *
 *   role=button[name="Search products"]
 *   after label "Total"                 (labelledBy)
 *   testId="add-to-cart"
 *   css="#search-go"
 *   ...any of the above with ` >> nth=2`
 */

export const STRATEGIES = [
  'testId',
  'role',
  'label',
  'labelledBy',
  'placeholder',
  'altText',
  'text',
  'css',
] as const;

export type Strategy = (typeof STRATEGIES)[number];

/**
 * Most durable first — the same ordering the recorder derives candidates in.
 *
 * A test id survives a redesign. An accessible name usually survives a restyle.
 * Visible text is the first thing a copy change breaks, and a CSS selector is
 * only ever reached when an element offered nothing better, which is why it is
 * both last here and the usual cause of a broken locator.
 */
const RANK: Record<Strategy, number> = {
  testId: 0,
  role: 1,
  label: 2,
  labelledBy: 3,
  placeholder: 4,
  altText: 5,
  text: 6,
  css: 7,
};

export const STRATEGY_NOTE: Record<Strategy, string> = {
  testId: 'A dedicated test id. Survives a redesign, because it exists for this purpose.',
  role: 'Role and accessible name. Survives a restyle, and only exists if the control is labelled.',
  label: 'The visible label text of a field.',
  labelledBy: 'The element sitting after a labelling element — how a displayed value gets an identity.',
  placeholder: 'Placeholder text. Cosmetic copy, and often the first thing rewritten.',
  altText: 'An image alt attribute.',
  text: 'The element’s own visible text. A copy change breaks it.',
  css: 'A raw CSS selector. The least durable option, and only reached when the element offered nothing better.',
};

export interface ParsedLocator {
  raw: string;
  strategy: Strategy | null;
  nth: number | null;
}

export function parseLocator(raw: string | null | undefined): ParsedLocator | null {
  if (!raw) return null;

  const nthMatch = / >> nth=(\d+)$/.exec(raw);
  const nth = nthMatch?.[1] ? Number(nthMatch[1]) : null;
  const head = nthMatch ? raw.slice(0, nthMatch.index) : raw;

  let strategy: Strategy | null = null;
  if (head.startsWith('role=')) strategy = 'role';
  else if (head.startsWith('after label ')) strategy = 'labelledBy';
  else {
    const prefix = /^([A-Za-z]+)="/.exec(head)?.[1];
    if (prefix && (STRATEGIES as readonly string[]).includes(prefix)) strategy = prefix as Strategy;
  }

  return { raw, strategy, nth };
}

/** Negative when `next` is the more durable of the two. */
export function durabilityDelta(previous: Strategy | null, next: Strategy | null): number | null {
  if (!previous || !next) return null;
  return RANK[next] - RANK[previous];
}

/**
 * The sentence the v2 release exists to make. An accessibility fix gave the
 * control an accessible name, so `role` became available where only `css` had
 * been — the repair is more durable than what it replaced, and the reason it is
 * available at all is the accessibility work.
 */
export function durabilityVerdict(previous: Strategy | null, next: Strategy | null): {
  tone: 'better' | 'same' | 'worse' | 'unknown';
  label: string;
} {
  const delta = durabilityDelta(previous, next);
  if (delta === null) return { tone: 'unknown', label: 'Durability not comparable' };
  if (delta < 0) return { tone: 'better', label: 'More durable than the locator it replaced' };
  if (delta === 0) return { tone: 'same', label: 'Same strategy, different value' };
  return { tone: 'worse', label: 'Less durable than the locator it replaced' };
}
