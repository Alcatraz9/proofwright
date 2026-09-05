import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAppHealth } from './classify.js';
import type { AppHealth } from './types.js';

function health(over: Partial<AppHealth> = {}): AppHealth {
  return {
    crashed: false,
    documentStatus: 200,
    serverErrors: [],
    failedRequests: [],
    pageErrors: [],
    inFlightRequests: 0,
    ...over,
  };
}

/**
 * The priority these pin: a held assertion is direct evidence the application
 * worked; a console error is circumstantial. blazedemo.com, live: the flight
 * search completed and its assertions held while the page logged "jQuery is
 * not defined" from a blocked third-party script — and the run was failed
 * for it.
 */

test('console errors are excusable when the caller says assertions held', () => {
  const h = health({ pageErrors: ['jQuery is not defined', 'a is not a function'] });
  assert.equal(classifyAppHealth(h, { ignorePageErrors: true }), null);
});

test('console errors still fail a step with no assertions', () => {
  const h = health({ pageErrors: ['jQuery is not defined'] });
  const result = classifyAppHealth(h);
  assert.equal(result?.kind, 'PAGE_ERROR');
});

test('stronger signals keep their veto even when page errors are excused', () => {
  assert.equal(
    classifyAppHealth(health({ documentStatus: 500 }), { ignorePageErrors: true })?.kind,
    'HTTP_ERROR',
  );
  assert.equal(
    classifyAppHealth(health({ failedRequests: ['GET /api — failed'] }), { ignorePageErrors: true })
      ?.kind,
    'NETWORK_ERROR',
  );
  assert.equal(
    classifyAppHealth(health({ crashed: true }), { ignorePageErrors: true })?.kind,
    'PAGE_CRASH',
  );
});

test('a healthy page classifies as nothing', () => {
  assert.equal(classifyAppHealth(health()), null);
});
