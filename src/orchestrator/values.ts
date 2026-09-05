import type { IntentPlan } from '../intent/types.js';

/**
 * Making a plan's values resolvable before anything tries to type them.
 *
 * A plan stores the *name* of a value, never the value — `valueRef: "TEST_EMAIL"`
 * is read from the environment at execution time, which is the right design for a
 * secret and a dead end for an unattended pipeline. The planner decides which names
 * it needs, so a model that invents `SEARCH_TERM` produces a plan that cannot run
 * until a human happens to export that variable. The first autonomous mission died
 * exactly there, four steps in, having resolved every locator perfectly.
 *
 * The decision worth making, rather than papering over: not every unset reference
 * is the same kind of problem.
 *
 *   A secret cannot be authored. Inventing a password produces a login that fails
 *   and a report blaming the application for it. The mission escalates and names
 *   the variable it needs — which is also the honest answer when an organiser hands
 *   over a URL and credentials arrive separately.
 *
 *   Test data can be authored. A search term, a quantity, a postcode: these are
 *   demonstration material, and authoring one invents nothing about the product. The
 *   value is recorded in the decision log so a reader knows the pipeline supplied it
 *   rather than a person.
 */

/**
 * Markers that a reference is a value the test wants to be *rejected*.
 *
 * These are checked before the secret hints, and the order is the whole point. A
 * refusal test needs a password that does not work, and `TEST_WRONG_PASSWORD`
 * contains "PASSWORD" — so a classifier reading only for secrets escalates asking
 * a human to supply a credential whose defining property is that it is wrong.
 * The first mission to plan its own refusal tests died exactly there.
 */
const DELIBERATELY_INVALID = ['WRONG', 'INVALID', 'BAD_', 'INCORRECT', 'MALFORMED', 'EXPIRED', 'MISMATCH'];

const SECRET_HINTS = [
  'PASSWORD',
  'PASSWD',
  'SECRET',
  'TOKEN',
  'APIKEY',
  'API_KEY',
  'KEY',
  'CREDENTIAL',
  'AUTH',
  'OTP',
  'PIN',
  'CVV',
  'CARD',
];

/** An identity is not guessable either: a login has to exist to be logged into. */
const IDENTITY_HINTS = ['EMAIL', 'USERNAME', 'USER_NAME', 'LOGIN', 'ACCOUNT', 'PHONE'];

export type RefKind = 'secret' | 'identity' | 'data';

export function classifyRef(ref: string): RefKind {
  const upper = ref.toUpperCase();
  // Before the secret check, deliberately: a value meant to fail is authorable.
  if (DELIBERATELY_INVALID.some((hint) => upper.includes(hint))) return 'data';
  if (SECRET_HINTS.some((hint) => upper.includes(hint))) return 'secret';
  if (IDENTITY_HINTS.some((hint) => upper.includes(hint))) return 'identity';
  return 'data';
}

/**
 * Plausible test data by the shape of the name.
 *
 * Deliberately ordinary. A search term of "laptop" exercises a catalogue; a search
 * term of "'; DROP TABLE" is a different test that a plan should ask for explicitly
 * rather than receive by accident from a defaulting function.
 */
function authorValue(ref: string): string {
  const upper = ref.toUpperCase();

  /**
   * A value that must fail. Written to be unmistakably wrong rather than randomly
   * wrong, so a run that unexpectedly passes reads as a real finding — an
   * application that accepts "definitely-not-the-password" has a defect worth the
   * report saying so plainly.
   */
  if (DELIBERATELY_INVALID.some((hint) => upper.includes(hint))) {
    if (upper.includes('EMAIL')) return 'not-an-email-address';
    if (upper.includes('PASSWORD') || upper.includes('SECRET')) return 'definitely-not-the-password';
    return 'definitely-invalid';
  }
  if (upper.includes('SEARCH') || upper.includes('QUERY') || upper.includes('TERM')) {
    return 'laptop';
  }
  if (upper.includes('QTY') || upper.includes('QUANTITY') || upper.includes('COUNT')) return '1';
  if (upper.includes('POSTCODE') || upper.includes('ZIP')) return '10001';
  if (upper.includes('CITY')) return 'Seattle';
  if (upper.includes('COUNTRY')) return 'United States';
  if (upper.includes('ADDRESS') || upper.includes('STREET')) return '410 Terry Ave N';
  if (upper.includes('NAME')) return 'Test Person';
  if (upper.includes('DATE')) return new Date().toISOString().slice(0, 10);
  if (upper.includes('COMMENT') || upper.includes('MESSAGE') || upper.includes('NOTE')) {
    return 'Placed by an automated test run.';
  }
  if (upper.includes('NUMBER') || upper.includes('AMOUNT') || upper.includes('PRICE')) return '2';
  return 'test';
}

export interface ValuePreflight {
  /** Refs that were already available; nothing to do and nothing to disclose. */
  alreadySet: string[];
  /** Test data this pipeline authored, with the value, because a reader should see it. */
  authored: { ref: string; value: string }[];
  /** Secrets and identities that cannot be invented. Non-empty means escalate. */
  missing: { ref: string; kind: RefKind }[];
}

export function valueRefsIn(plan: IntentPlan): string[] {
  const refs = new Set<string>();
  for (const step of plan.steps) {
    if (step.valueRef) refs.add(step.valueRef);
  }
  return [...refs];
}

/**
 * Inspects the plan and fills what can honestly be filled.
 *
 * Writes authored values into the process environment because that is where
 * `resolveValueRef` looks, and both the recorder and the replayer go through it —
 * satisfying one and not the other would produce a baseline that records fine and
 * fails on every later run.
 */
export function preflightValues(plan: IntentPlan): ValuePreflight {
  const result: ValuePreflight = { alreadySet: [], authored: [], missing: [] };

  for (const ref of valueRefsIn(plan)) {
    if (process.env[ref] !== undefined) {
      result.alreadySet.push(ref);
      continue;
    }
    const kind = classifyRef(ref);
    if (kind === 'data') {
      const value = authorValue(ref);
      process.env[ref] = value;
      result.authored.push({ ref, value });
    } else {
      result.missing.push({ ref, kind });
    }
  }
  return result;
}

/** Refs the previous mission supplied, so they can be withdrawn, not inherited. */
const appliedRefs = new Set<string>();

/**
 * Caller-supplied values, for the case the challenge actually describes: a target
 * URL arrives with credentials rather than with a pre-configured environment.
 *
 * Returns the names only. The values are secrets and belong in no log, no decision
 * record, and no report.
 *
 * Credentials are MISSION input, not server state — but `process.env` is server
 * state, and in a long-lived process one mission's login quietly became every
 * later mission's login. Observed live: OrangeHRM's Admin/admin123, supplied at
 * dawn, leaked into an afternoon demoqa mission that supplied nothing; the
 * planner was told credentials existed, planned a sign-in journey the user never
 * asked for, and the mission died trying to log in to the wrong site with the
 * wrong account. Withdrawing the previous mission's refs first makes "no
 * credentials this time" actually mean that. Values from the server's own
 * environment (.env fixture credentials) are never touched — only what this
 * function itself wrote.
 */
export function applyProvidedValues(values: Record<string, string>): string[] {
  for (const ref of appliedRefs) delete process.env[ref];
  appliedRefs.clear();

  const names: string[] = [];
  for (const [ref, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) continue; // env-var shaped names only
    process.env[ref] = value;
    appliedRefs.add(ref);
    names.push(ref);
  }
  return names;
}

/**
 * Credential references that are actually resolvable right now.
 *
 * The planner chooses its own reference names, and on a site whose field is
 * labelled "Username" it reasonably asks for `TEST_USERNAME` — which then does not
 * exist, because the caller supplied `TEST_EMAIL`. The mission then escalates for a
 * missing credential while holding a perfectly good one, which is correct behaviour
 * answering the wrong question.
 *
 * So the planner is told the exact names available instead of guessing. Names only:
 * the values are secrets and never reach a prompt.
 */
export function availableCredentialRefs(): string[] {
  const looksLikeCredential = (key: string): boolean =>
    /^TEST_/.test(key) ||
    /(EMAIL|USERNAME|USER_NAME|LOGIN|PASSWORD|PASSWD)$/.test(key);

  return Object.keys(process.env)
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key))
    .filter(looksLikeCredential)
    .filter((key) => (process.env[key] ?? '').length > 0)
    .sort();
}
