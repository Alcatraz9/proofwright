/**
 * The application under test: seven releases of one shopping flow.
 *
 * Read as a story rather than a matrix. A team ships a working but careless app,
 * then remediates accessibility, then hardens security, then redesigns, and then
 * ships three regressions. Every release is a realistic thing to do, and each one
 * exercises a different verdict — several at once, because that is also what real
 * releases do.
 *
 * The important property is that the *remediation* releases break tests. Adding a
 * label to an unlabelled control gives it an accessible name it did not have, and
 * a locator matching on position or raw text stops matching. That is not a
 * contrived demo: it is the single most common reason a suite goes red after an
 * accessibility fix, and a tool that punishes teams for improving accessibility is
 * a tool that discourages it. Watching the accessibility score climb while the
 * test heals itself is the whole argument.
 *
 *   v1  legacy        works, but careless: no labels, poor contrast, no headers,
 *                     a key in the page source. What the baseline is recorded on.
 *   v2  accessible    WCAG remediation. Controls gain accessible names, contrast
 *                     is fixed. -> a11y score climbs, locator heals, restyle is
 *                     absorbed as cosmetic.
 *   v3  hardened      security headers, cookie flags, secret removed.
 *                     -> security score climbs, nothing functional changes.
 *   v4  redesign      restyle, summary panel moved, checkout moved into an action
 *                     bar and renamed. -> cosmetic + layout shift + a heal.
 *   v5  broken login  v4 exactly, with authentication inverted.
 *                     -> outcome failure, never healed.
 *   v6  feature gone  checkout removed outright, and the catalogue duplicated so a
 *                     unique locator becomes ambiguous. -> heal declines.
 *   v7  price change  v4 with different prices. -> whether this passes depends on
 *                     what the test asked for, and both answers are correct.
 *
 * All seven are served at /app/v1 … /app/v7 so they can be opened side by side.
 * Tests target /app, which serves whichever is active.
 */

export type VersionId = 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' | 'v7';

export interface IdMap {
  loginForm: string;
  emailInput: string;
  passwordInput: string;
  submitButton: string;
  statusMessage: string;
  catalogRoot: string;
  searchInput: string;
  searchButton: string;
  productGrid: string;
  productRoot: string;
  productTitle: string;
  productPrice: string;
  addToCartButton: string;
  checkoutRoot: string;
  summaryPanel: string;
  totalValue: string;
  placeOrderButton: string;
  confirmationRoot: string;
  orderNumber: string;
}

export interface LabelMap {
  signIn: string;
  checkout: string;
  addToCart: string;
  placeOrder: string;
  totalLabel: string;
  loginHeading: string;
  catalogHeading: string;
  checkoutHeading: string;
  confirmedHeading: string;
}

/**
 * Presentation only. Nothing here can move an element's box, which is what lets a
 * diff confined to these properties be classified as cosmetic by construction
 * rather than by a guess about which properties probably matter.
 */
export interface Theme {
  fontFamily: string;
  pageBackground: string;
  cardBackground: string;
  accent: string;
  accentText: string;
  bodyText: string;
  /** Secondary text. Deliberately too light in v1: a real contrast failure. */
  mutedText: string;
  borderColor: string;
  radius: string;
  shadow: string;
}

export interface VersionSpec {
  id: VersionId;
  displayName: string;
  /** One line, shown in the dashboard: what this release changed and why. */
  story: string;
  /** What a run against this version should demonstrate. */
  demonstrates: string[];
  ids: IdMap;
  labels: LabelMap;
  theme: Theme;

  /**
   * Whether controls are properly labelled and announced.
   *
   * 'poor' renders the search control as an icon-only element with no accessible
   * name, inputs with a placeholder instead of a label, a clickable div in place
   * of a button, and no landmarks. 'good' fixes all of it — and in doing so gives
   * the search control the accessible name that breaks the recorded locator.
   */
  accessibility: 'poor' | 'good';

  /**
   * Whether the response carries security headers and the cookie carries flags,
   * and whether a credential is left in the page source.
   */
  security: 'weak' | 'hardened';

  summaryPosition: 'aside' | 'above';

  /**
   * Where the basket's checkout control is, and whether it exists.
   *
   * 'inline' sits after the price, which gives it a label-anchored fallback that
   * survives a rename — so a rename there is drift, not a stale locator.
   * 'actionBar' moves it away from the price and turns it into a button, breaking
   * primary and fallbacks together. 'removed' deletes it, which is the case the
   * healer must decline rather than substitute something plausible.
   */
  checkoutControl: 'inline' | 'actionBar' | 'removed';

  /** Duplicates the catalogue so a previously unique locator matches twice. */
  duplicateCatalogue: boolean;

  /** Shifts every price, without changing any structure. */
  priceShift: boolean;

  loginInverted: boolean;
}

const LEGACY_IDS: IdMap = {
  loginForm: 'login-form',
  emailInput: 'email-input',
  passwordInput: 'password-input',
  submitButton: 'login-submit',
  statusMessage: 'status-msg',
  catalogRoot: 'catalog',
  searchInput: 'product-search',
  searchButton: 'search-go',
  productGrid: 'product-grid',
  productRoot: 'product-detail',
  productTitle: 'product-title',
  productPrice: 'product-price',
  addToCartButton: 'add-to-cart',
  checkoutRoot: 'checkout',
  summaryPanel: 'order-summary',
  totalValue: 'order-total',
  placeOrderButton: 'place-order',
  confirmationRoot: 'confirmation',
  orderNumber: 'order-number',
};

const REDESIGN_IDS: IdMap = {
  loginForm: 'auth-form',
  emailInput: 'user-email-field',
  passwordInput: 'user-pass-field',
  submitButton: 'btn-do-signin',
  statusMessage: 'auth-status',
  catalogRoot: 'workspace',
  searchInput: 'records-query',
  searchButton: 'records-go',
  productGrid: 'records-grid',
  productRoot: 'record-detail',
  productTitle: 'record-title',
  productPrice: 'record-price',
  addToCartButton: 'btn-add-item',
  checkoutRoot: 'payment',
  summaryPanel: 'basket-summary',
  totalValue: 'basket-total',
  placeOrderButton: 'btn-submit-order',
  confirmationRoot: 'receipt',
  orderNumber: 'receipt-number',
};

const BASE_LABELS: LabelMap = {
  signIn: 'Sign in',
  checkout: 'Checkout',
  addToCart: 'Add to cart',
  placeOrder: 'Place order',
  totalLabel: 'Total',
  loginHeading: 'Sign in to Northwind Supply',
  catalogHeading: 'Catalogue',
  checkoutHeading: 'Checkout',
  confirmedHeading: 'Order confirmed',
};

/** v1's palette. `mutedText` against `cardBackground` is a genuine AA failure. */
const LEGACY_THEME: Theme = {
  fontFamily: 'Arial, Helvetica, sans-serif',
  pageBackground: '#eef2f7',
  cardBackground: '#ffffff',
  accent: '#5b9dd9',
  accentText: '#ffffff',
  bodyText: '#1f2933',
  // 2.3:1 against white. Fails WCAG AA, and does so for a believable reason:
  // somebody wanted secondary text to look lighter.
  mutedText: '#b3bcc7',
  borderColor: '#d5dee7',
  radius: '8px',
  shadow: '0 1px 3px rgba(16, 42, 67, 0.12)',
};

/** Contrast repaired. Same layout, so the change is purely cosmetic. */
const ACCESSIBLE_THEME: Theme = {
  ...LEGACY_THEME,
  accent: '#1769aa',
  mutedText: '#5b6673',
};

const REDESIGN_THEME: Theme = {
  fontFamily: 'Georgia, "Times New Roman", serif',
  pageBackground: '#f4f1ea',
  cardBackground: '#fffdf8',
  accent: '#9a3412',
  accentText: '#ffffff',
  bodyText: '#2d2926',
  mutedText: '#6b6259',
  borderColor: '#e3d9c6',
  radius: '2px',
  shadow: 'none',
};

export const VERSIONS: Record<VersionId, VersionSpec> = {
  v1: {
    id: 'v1',
    displayName: 'v1 — legacy',
    story: 'The starting point. It works, but nothing is labelled and nothing is hardened.',
    demonstrates: [
      'The baseline is recorded here',
      'Low accessibility score: unlabelled controls, poor contrast, no landmarks',
      'Low security score: no headers, unflagged cookie, a key in the page source',
    ],
    ids: LEGACY_IDS,
    labels: BASE_LABELS,
    theme: LEGACY_THEME,
    accessibility: 'poor',
    security: 'weak',
    summaryPosition: 'aside',
    checkoutControl: 'inline',
    duplicateCatalogue: false,
    priceShift: false,
    loginInverted: false,
  },

  v2: {
    id: 'v2',
    displayName: 'v2 — accessible',
    story:
      'Accessibility remediation. Labels, roles and contrast fixed — which gives controls ' +
      'accessible names they never had, and breaks a locator that had nothing better to match on.',
    demonstrates: [
      'Accessibility score climbs sharply',
      'A locator breaks because a control gained an accessible name, and heals',
      'The contrast fix is absorbed as a cosmetic change, not a failure',
    ],
    ids: LEGACY_IDS,
    labels: BASE_LABELS,
    theme: ACCESSIBLE_THEME,
    accessibility: 'good',
    security: 'weak',
    summaryPosition: 'aside',
    checkoutControl: 'inline',
    duplicateCatalogue: false,
    priceShift: false,
    loginInverted: false,
  },

  v3: {
    id: 'v3',
    displayName: 'v3 — hardened',
    story:
      'Security hardening. Headers added, cookie flagged, the embedded credential removed. ' +
      'Nothing a user can see changes.',
    demonstrates: [
      'Security score climbs sharply',
      'No functional or visual change at all: the run stays green and silent',
      'Proof the two analyses are independent of each other',
    ],
    ids: LEGACY_IDS,
    labels: BASE_LABELS,
    theme: ACCESSIBLE_THEME,
    accessibility: 'good',
    security: 'hardened',
    summaryPosition: 'aside',
    checkoutControl: 'inline',
    duplicateCatalogue: false,
    priceShift: false,
    loginInverted: false,
  },

  v4: {
    id: 'v4',
    displayName: 'v4 — redesign',
    story:
      'A visual redesign. Every id renamed, restyled, the summary panel moved, and checkout ' +
      'moved into an action bar and renamed "Continue to Payment".',
    demonstrates: [
      'A renamed control with no surviving fallback: a stale locator, healed and verified',
      'Restyling absorbed as cosmetic; the moved panel reported as a layout shift',
      'A vanished control reconciled with the heal rather than failed twice',
    ],
    ids: REDESIGN_IDS,
    labels: { ...BASE_LABELS, checkout: 'Continue to Payment' },
    theme: REDESIGN_THEME,
    accessibility: 'good',
    security: 'hardened',
    summaryPosition: 'above',
    checkoutControl: 'actionBar',
    duplicateCatalogue: false,
    priceShift: false,
    loginInverted: false,
  },

  v5: {
    id: 'v5',
    displayName: 'v5 — broken login',
    story:
      'Identical to v4 in every respect, except that authentication no longer works. ' +
      'The bug a self-healing tool must never paper over.',
    demonstrates: [
      'The control is found and clicked; only the outcome fails',
      'Classified OUTCOME_NOT_MET, and the healer is never even consulted',
      'Healing enabled makes no difference — which is the point',
    ],
    ids: REDESIGN_IDS,
    labels: { ...BASE_LABELS, checkout: 'Continue to Payment' },
    theme: REDESIGN_THEME,
    accessibility: 'good',
    security: 'hardened',
    summaryPosition: 'above',
    checkoutControl: 'actionBar',
    duplicateCatalogue: false,
    priceShift: false,
    loginInverted: true,
  },

  v6: {
    id: 'v6',
    displayName: 'v6 — feature removed',
    story:
      'Checkout has been removed from the basket entirely. Nothing on the page serves the ' +
      'purpose the test was written for.',
    demonstrates: [
      'A removed feature: the healer is asked, finds nothing serving the intent, and declines',
      'Returning no candidate is the correct answer, not a failure of the healer',
      'Contrast with v4: a renamed control heals, a deleted one must not',
    ],
    ids: REDESIGN_IDS,
    labels: { ...BASE_LABELS, checkout: 'Continue to Payment' },
    theme: REDESIGN_THEME,
    accessibility: 'good',
    security: 'hardened',
    summaryPosition: 'above',
    checkoutControl: 'removed',
    // Deliberately false. Duplicating the catalogue also makes an earlier step's
    // locator ambiguous, and because a run halts at its first failure that
    // ambiguity would mask the removed-feature case this release exists to show.
    // LOCATOR_AMBIGUOUS is covered by the fault-drill harness, which mutates a
    // baseline in memory and can therefore isolate one verdict at a time.
    duplicateCatalogue: false,
    priceShift: false,
    loginInverted: false,
  },

  v7: {
    id: 'v7',
    displayName: 'v7 — price change',
    story:
      'v4 with every price changed. No structural change whatsoever — only the numbers.',
    demonstrates: [
      'The total is found by the label beside it, so its identity survives the data change',
      '"Confirm a total is shown" passes; "confirm the total is £49.00" fails',
      'Same change, two opposite verdicts, both correct — decided by what was asked for',
    ],
    ids: REDESIGN_IDS,
    labels: { ...BASE_LABELS, checkout: 'Continue to Payment' },
    theme: REDESIGN_THEME,
    accessibility: 'good',
    security: 'hardened',
    summaryPosition: 'above',
    checkoutControl: 'actionBar',
    duplicateCatalogue: false,
    priceShift: true,
    loginInverted: false,
  },
};

export const VERSION_IDS = Object.keys(VERSIONS) as VersionId[];

export function isVersionId(value: string): value is VersionId {
  return (VERSION_IDS as string[]).includes(value);
}

/**
 * Credentials the fixture accepts, read from the same environment variables a
 * plan's `valueRef` resolves against — so the test and the app agree on what a
 * valid login is without the password appearing in either.
 */
export const FIXTURE_CREDENTIALS = {
  email: process.env.TEST_EMAIL || 'demo@example.com',
  password: process.env.TEST_PASSWORD || 'demo-password',
} as const;

export interface Product {
  id: string;
  name: string;
  price: string;
  shiftedPrice: string;
  blurb: string;
}

/** Fixed prices: a total that drifted between runs would prove nothing. */
export const PRODUCTS: Product[] = [
  {
    id: 'ns-1001',
    name: 'Braided Cable Reel',
    price: '£49.00',
    shiftedPrice: '£59.00',
    blurb: '30m industrial reel.',
  },
  {
    id: 'ns-1002',
    name: 'Insulated Junction Box',
    price: '£18.50',
    shiftedPrice: '£21.00',
    blurb: 'IP65 rated, 8-way.',
  },
  {
    id: 'ns-1003',
    name: 'Torque Screwdriver Set',
    price: '£72.25',
    shiftedPrice: '£79.99',
    blurb: 'Six calibrated bits.',
  },
];

export function priceOf(product: Product, spec: VersionSpec): string {
  return spec.priceShift ? product.shiftedPrice : product.price;
}

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
