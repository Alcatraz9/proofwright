import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsRebase, rebaseBaseline, rebaseForThisHost } from './rebase.js';
import type { Baseline } from './types.js';

/**
 * Rebasing is worth pinning because its failure mode is silent and total: get it
 * wrong and every step of every seeded baseline reports a page divergence, which
 * looks like the application redirecting rather than like a bad rewrite.
 */

function baselineFixture(origin: string): Baseline {
  return {
    baselineId: 'b1',
    planId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    model: 'test',
    startUrl: `${origin}/app/`,
    visualBaselines: [],
    steps: [
      {
        stepId: 'one',
        intent: 'go to checkout',
        action: 'click',
        value: null,
        valueRef: null,
        pageUrl: `${origin}/app/cart?ref=abc#top`,
        locator: { strategy: 'role', value: null, role: 'link', name: 'Checkout', nth: null },
        fallbackLocators: [],
        fingerprint: null,
        expectedOutcome: {
          assertions: [{ type: 'urlContains', value: '/app/checkout', locator: null }],
          intended: 'checkout is shown',
        },
        resolution: { confidence: 1, reason: 'test' },
        healHistory: [],
      },
      {
        stepId: 'two',
        intent: 'go somewhere absolute',
        action: 'navigate',
        value: `${origin}/app/confirmation`,
        valueRef: null,
        pageUrl: `${origin}/app/checkout`,
        locator: null,
        fallbackLocators: [],
        fingerprint: null,
        expectedOutcome: { assertions: [], intended: null },
        resolution: { confidence: 1, reason: 'test' },
        healHistory: [],
      },
    ],
  };
}

test('moves every recorded origin onto the target', () => {
  const rebased = rebaseBaseline(baselineFixture('http://127.0.0.1:7880'), 'http://127.0.0.1:7860');
  assert.equal(rebased.startUrl, 'http://127.0.0.1:7860/app/');
  assert.equal(rebased.steps[0]?.pageUrl, 'http://127.0.0.1:7860/app/cart?ref=abc#top');
  assert.equal(rebased.steps[1]?.pageUrl, 'http://127.0.0.1:7860/app/checkout');
});

test('crosses scheme and drops a port, as a hosted deploy does', () => {
  const rebased = rebaseBaseline(
    baselineFixture('http://127.0.0.1:7860'),
    'https://someone-qa.hf.space',
  );
  assert.equal(rebased.startUrl, 'https://someone-qa.hf.space/app/');
  assert.equal(rebased.steps[0]?.pageUrl, 'https://someone-qa.hf.space/app/cart?ref=abc#top');
});

test('preserves paths, queries and hashes exactly', () => {
  const original = baselineFixture('http://a.test');
  const rebased = rebaseBaseline(original, 'http://b.test');
  for (const [index, step] of rebased.steps.entries()) {
    const before = new URL(original.steps[index]!.pageUrl);
    const after = new URL(step.pageUrl);
    assert.equal(after.pathname, before.pathname);
    assert.equal(after.search, before.search);
    assert.equal(after.hash, before.hash);
  }
});

test("moves a navigate step's target URL, since that is where it would send the run", () => {
  const rebased = rebaseBaseline(baselineFixture('http://a.test'), 'http://b.test');
  assert.equal(rebased.steps[1]?.value, 'http://b.test/app/confirmation');
});

test('leaves a urlContains path fragment alone — it is already origin-independent', () => {
  const rebased = rebaseBaseline(baselineFixture('http://a.test'), 'http://b.test');
  assert.equal(rebased.steps[0]?.expectedOutcome.assertions[0]?.value, '/app/checkout');
});

test('does not touch locators, fingerprints or heal history', () => {
  const original = baselineFixture('http://a.test');
  const rebased = rebaseBaseline(original, 'http://b.test');
  assert.deepEqual(rebased.steps[0]?.locator, original.steps[0]?.locator);
  assert.deepEqual(rebased.steps[0]?.healHistory, []);
});

test('an unusable target is left alone rather than corrupting every URL', () => {
  const original = baselineFixture('http://a.test');
  const rebased = rebaseBaseline(original, 'not a url');
  assert.equal(rebased.startUrl, original.startUrl);
});

test('needsRebase only fires when an origin actually differs', () => {
  const baseline = baselineFixture('http://127.0.0.1:7860');
  assert.equal(needsRebase(baseline, 'http://127.0.0.1:7860'), false);
  // A trailing path on the target must not read as a different origin.
  assert.equal(needsRebase(baseline, 'http://127.0.0.1:7860/app/'), false);
  assert.equal(needsRebase(baseline, 'http://127.0.0.1:7880'), true);
  assert.equal(needsRebase(baseline, 'https://127.0.0.1:7860'), true);
});

test('rebaseForThisHost leaves an external target untouched', () => {
  // A baseline recorded against a real external site must never be dragged onto
  // the fixture: the origin is part of what the test is. This was observed live —
  // blazedemo's recording passed, then the run replayed against 127.0.0.1 and
  // failed every step as ELEMENT_NOT_FOUND.
  const external = baselineFixture('https://blazedemo.com');
  const result = rebaseForThisHost(external, 'http://127.0.0.1:7860');
  assert.equal(result, external);
  assert.equal(result.startUrl, 'https://blazedemo.com/app/');
});

test('rebaseForThisHost moves a fixture baseline to the current origin', () => {
  const fixture = baselineFixture('http://127.0.0.1:7860');
  const result = rebaseForThisHost(fixture, 'https://my-space.hf.space');
  assert.equal(result.startUrl, 'https://my-space.hf.space/app/');
});

test('rebaseForThisHost treats localhost as fixture too', () => {
  const fixture = baselineFixture('http://localhost:7871');
  const result = rebaseForThisHost(fixture, 'http://127.0.0.1:7860');
  assert.equal(result.startUrl, 'http://127.0.0.1:7860/app/');
});

test('rebaseForThisHost is a no-op when the fixture origin already matches', () => {
  const fixture = baselineFixture('http://127.0.0.1:7860');
  const result = rebaseForThisHost(fixture, 'http://127.0.0.1:7860');
  assert.equal(result, fixture);
});
