import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntentPlan } from '../intent/types.js';
import { applyProvidedValues, classifyRef, preflightValues, valueRefsIn } from './values.js';

function planWith(refs: (string | null)[]): IntentPlan {
  return {
    name: 'Test plan',
    description: 'Fixture for the value preflight.',
    steps: refs.map((ref, index) => ({
      id: `step-${index + 1}`,
      intent: 'Fill a field',
      sourcePhrase: 'fill the field',
      action: 'fill' as const,
      target: { description: 'a field', context: null },
      value: null,
      valueRef: ref,
      expectedValue: null,
      expectedOutcome: null,
    })),
  } as unknown as IntentPlan;
}

test('a credential is never authored', () => {
  assert.equal(classifyRef('TEST_PASSWORD'), 'secret');
  assert.equal(classifyRef('API_TOKEN'), 'secret');
  assert.equal(classifyRef('CARD_CVV'), 'secret');
  assert.equal(classifyRef('SESSION_AUTH'), 'secret');
});

test('a value meant to be rejected is test data, not a secret', () => {
  // The refusal tests the orchestrator plans for itself need these, and escalating
  // for a password whose defining property is that it is wrong asks a human for
  // something nobody has.
  assert.equal(classifyRef('TEST_WRONG_PASSWORD'), 'data');
  assert.equal(classifyRef('INVALID_EMAIL'), 'data');
  assert.equal(classifyRef('BAD_CREDENTIAL'), 'data');
  assert.equal(classifyRef('MALFORMED_EMAIL'), 'data');
});

test('an authored invalid value is unmistakably wrong, so a pass is a finding', () => {
  delete process.env.TEST_WRONG_PASSWORD;
  const result = preflightValues(planWith(['TEST_WRONG_PASSWORD']));

  assert.equal(result.missing.length, 0);
  assert.equal(result.authored[0]!.value, 'definitely-not-the-password');
  delete process.env.TEST_WRONG_PASSWORD;
});

test('an identity is not guessable either', () => {
  assert.equal(classifyRef('TEST_EMAIL'), 'identity');
  assert.equal(classifyRef('USERNAME'), 'identity');
  assert.equal(classifyRef('ACCOUNT_PHONE'), 'identity');
});

test('ordinary test data is data', () => {
  assert.equal(classifyRef('SEARCH_TERM'), 'data');
  assert.equal(classifyRef('QUANTITY'), 'data');
  assert.equal(classifyRef('DELIVERY_CITY'), 'data');
});

test('valueRefsIn collects each ref once and ignores steps without one', () => {
  const refs = valueRefsIn(planWith(['SEARCH_TERM', null, 'SEARCH_TERM', 'QUANTITY']));
  assert.deepEqual(refs.sort(), ['QUANTITY', 'SEARCH_TERM']);
});

test('test data is authored and exported so both recorder and replayer resolve it', () => {
  delete process.env.SEARCH_TERM;
  const result = preflightValues(planWith(['SEARCH_TERM']));

  assert.equal(result.missing.length, 0);
  assert.equal(result.authored.length, 1);
  assert.equal(result.authored[0]!.ref, 'SEARCH_TERM');
  // Exported, because resolveValueRef reads process.env and a baseline recorded
  // against a value the later run cannot resolve is worse than no baseline.
  assert.equal(process.env.SEARCH_TERM, result.authored[0]!.value);
  delete process.env.SEARCH_TERM;
});

test('a missing credential is reported rather than invented', () => {
  delete process.env.TEST_PASSWORD;
  const result = preflightValues(planWith(['TEST_PASSWORD']));

  assert.equal(result.authored.length, 0);
  assert.deepEqual(result.missing, [{ ref: 'TEST_PASSWORD', kind: 'secret' }]);
});

test('an already-set ref is left alone', () => {
  process.env.SEARCH_TERM = 'deliberate';
  const result = preflightValues(planWith(['SEARCH_TERM']));

  assert.deepEqual(result.alreadySet, ['SEARCH_TERM']);
  assert.equal(result.authored.length, 0);
  assert.equal(process.env.SEARCH_TERM, 'deliberate');
  delete process.env.SEARCH_TERM;
});

test('provided credentials return names only, never values', () => {
  const names = applyProvidedValues({ TEST_PASSWORD: 'hunter2', 'not-an-env-name': 'x' });

  assert.deepEqual(names, ['TEST_PASSWORD']);
  assert.equal(process.env.TEST_PASSWORD, 'hunter2');
  // A key that is not env-var shaped is dropped rather than exported.
  assert.equal(names.includes('not-an-env-name'), false);
  delete process.env.TEST_PASSWORD;
});
