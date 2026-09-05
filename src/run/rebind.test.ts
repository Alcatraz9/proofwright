import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebindOutcomeToUsedLocator } from './replay.js';
import type { BaselineStep, Locator } from '../baseline/types.js';

/**
 * Regression cover for a misattribution that was both silent and inverted.
 *
 * A step rescued by a fallback locator failed its own post-condition, because the
 * assertion was still checked against the recorded primary locator — which by
 * definition no longer matched. The reported message was "the field was empty"
 * about a field that had just been filled successfully, and the verdict was
 * OUTCOME_NOT_MET, which is not healable. A stale locator therefore presented as
 * an application failure and stopped the run.
 */

const PRIMARY: Locator = {
  strategy: 'role',
  value: null,
  role: 'searchbox',
  name: 'Search products',
  nth: null,
};

const FALLBACK: Locator = {
  strategy: 'css',
  value: '#product-search',
  role: null,
  name: null,
  nth: null,
};

const OTHER: Locator = {
  strategy: 'role',
  value: null,
  role: 'heading',
  name: 'Catalogue',
  nth: null,
};

function step(assertions: BaselineStep['expectedOutcome']['assertions']): BaselineStep {
  return {
    stepId: 'fill-search',
    intent: 'type into the search field',
    action: 'fill',
    value: 'cable',
    valueRef: null,
    pageUrl: 'http://localhost/app/catalog',
    locator: PRIMARY,
    fallbackLocators: [FALLBACK],
    fingerprint: null,
    expectedOutcome: { assertions, intended: 'the field holds a value' },
    resolution: { confidence: 1, reason: 'test' },
    healHistory: [],
  };
}

test("rebinds an assertion about the step's own element to the locator that worked", () => {
  const outcome = rebindOutcomeToUsedLocator(
    step([{ type: 'inputFilled', value: null, locator: PRIMARY }]),
    FALLBACK,
  );
  assert.deepEqual(outcome.assertions[0]?.locator, FALLBACK);
});

test('leaves an assertion about a different element exactly as recorded', () => {
  const outcome = rebindOutcomeToUsedLocator(
    step([{ type: 'elementVisible', value: null, locator: OTHER }]),
    FALLBACK,
  );
  assert.deepEqual(outcome.assertions[0]?.locator, OTHER);
});

test('rebinds only the matching assertions in a mixed outcome', () => {
  const outcome = rebindOutcomeToUsedLocator(
    step([
      { type: 'inputFilled', value: null, locator: PRIMARY },
      { type: 'elementVisible', value: null, locator: OTHER },
      { type: 'urlContains', value: '/catalog', locator: null },
    ]),
    FALLBACK,
  );
  assert.deepEqual(outcome.assertions[0]?.locator, FALLBACK);
  assert.deepEqual(outcome.assertions[1]?.locator, OTHER);
  assert.equal(outcome.assertions[2]?.locator, null);
});

test('is a no-op when the primary locator was the one that worked', () => {
  const original = step([{ type: 'inputFilled', value: null, locator: PRIMARY }]);
  assert.equal(rebindOutcomeToUsedLocator(original, PRIMARY), original.expectedOutcome);
});

test('is a no-op for a step that acts on the page rather than an element', () => {
  const pageLevel = { ...step([]), locator: null };
  assert.equal(rebindOutcomeToUsedLocator(pageLevel, null), pageLevel.expectedOutcome);
});

test('never mutates the stored step', () => {
  const original = step([{ type: 'inputFilled', value: null, locator: PRIMARY }]);
  rebindOutcomeToUsedLocator(original, FALLBACK);
  assert.deepEqual(original.expectedOutcome.assertions[0]?.locator, PRIMARY);
});
