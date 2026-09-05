import assert from 'node:assert/strict';
import test from 'node:test';
import type { SiteMap } from '../explore/types.js';
import type { IntentPlan } from '../intent/types.js';
import { evaluateCoverage, fillableGaps } from './evaluate.js';

function map(): SiteMap {
  return {
    entryUrl: 'https://shop.test/',
    pages: [
      {
        url: 'https://shop.test/login',
        title: 'Sign in',
        elementCount: 10,
        depth: 0,
        links: [],
        destructiveActions: [],
        blindSpots: 0,
        behindAuth: false,
        forms: [
          {
            index: 0,
            isAuth: true,
            submitLabel: 'Sign in',
            untestableHere: [],
            fields: [
              { label: 'Email', inputType: 'email', required: true, name: 'email' },
              { label: 'Password', inputType: 'password', required: true, name: 'password' },
            ],
            negativeOpportunities: [
              { field: 'Email, Password', kind: 'empty_required', why: 'both required' },
              { field: 'Email', kind: 'malformed_email', why: 'takes an email' },
              { field: 'credentials', kind: 'wrong_credential', why: 'it authenticates' },
            ],
          },
        ],
      },
      {
        url: 'https://shop.test/catalog',
        title: 'Catalogue',
        elementCount: 20,
        depth: 1,
        links: [],
        destructiveActions: [],
        blindSpots: 0,
        behindAuth: true,
        forms: [],
      },
    ],
    unvisited: [{ url: 'https://shop.test/orders', reason: 'Beyond the depth limit of 1.' }],
    auth: { wallFound: true, authenticated: true, note: 'signed in' },
    budget: { pagesVisited: 2, pageLimit: 8, depthLimit: 1, elapsedMs: 1000, exhausted: false },
  };
}

function plan(steps: { intent: string; target?: string }[]): IntentPlan {
  return {
    name: 'Happy path',
    description: 'Signs in and views the catalogue.',
    steps: steps.map((step, index) => ({
      id: `step-${index + 1}`,
      intent: step.intent,
      sourcePhrase: step.intent,
      action: 'fill',
      target: step.target ? { description: step.target, context: null } : null,
      value: null,
      valueRef: null,
      expectedValue: null,
      expectedOutcome: null,
    })),
  } as unknown as IntentPlan;
}

test('a happy-path plan covers the form but none of its refusals', () => {
  const report = evaluateCoverage(map(), [
    plan([
      { intent: 'Fill the Email field', target: 'Email' },
      { intent: 'Fill the Password field', target: 'Password' },
      { intent: 'Open the catalog page', target: 'catalog' },
    ]),
  ]);

  assert.equal(report.covered.forms.length, 1);
  assert.equal(report.covered.negativePaths.length, 0);
  assert.equal(report.totals.negativePaths, 3);

  // The gap kinds the requirement asks for, by name.
  const kinds = new Set(report.gaps.map((gap) => gap.kind));
  assert.equal(kinds.has('missing_error_state'), true);
  assert.equal(kinds.has('unexplored'), true);
});

test('a plan that tests a wrong password is credited for it', () => {
  const report = evaluateCoverage(map(), [
    plan([
      { intent: 'Fill the Email field', target: 'Email' },
      { intent: 'Fill Password with a wrong password', target: 'Password' },
    ]),
  ]);
  assert.equal(
    report.covered.negativePaths.some((entry) => entry.includes('wrong_credential')),
    true,
  );
});

test('the score is weighted toward refusal paths, so a happy path alone scores low', () => {
  const happyOnly = evaluateCoverage(map(), [
    plan([
      { intent: 'Fill the Email field', target: 'Email' },
      { intent: 'Fill the Password field', target: 'Password' },
      { intent: 'Open the catalog page', target: 'catalog' },
    ]),
  ]);
  // Pages and the form are covered; every refusal path is not. A score that read
  // healthy here would be the exact failure this measurement exists to prevent.
  assert.ok(happyOnly.score < 0.6, `expected < 0.6, got ${happyOnly.score}`);
});

test('an empty plan set covers nothing and scores zero', () => {
  const report = evaluateCoverage(map(), []);
  assert.equal(report.score, 0);
  assert.equal(report.covered.pages.length, 0);
});

test('risk ranks the sign-in form above a browse page, and explains itself', () => {
  const report = evaluateCoverage(map(), []);
  const top = report.untestedFlowRisk[0]!;

  assert.match(top.flow, /login/);
  assert.equal(top.band, 'high');
  assert.match(top.rationale, /controls access/);
  // The arithmetic is readable, which is the point of carrying it at all.
  assert.match(top.rationale, /click\(s\) from the entry point/);
});

test('unexplored pages are reported as gaps but never given a risk score', () => {
  const report = evaluateCoverage(map(), []);
  assert.equal(
    report.gaps.some((gap) => gap.kind === 'unexplored'),
    true,
  );
  assert.equal(
    report.untestedFlowRisk.some((risk) => risk.flow.includes('/orders')),
    false,
  );
});

test('fillableGaps returns the highest-risk gaps and excludes the unexplorable', () => {
  const report = evaluateCoverage(map(), []);
  const gaps = fillableGaps(report, 2);

  assert.equal(gaps.length, 2);
  assert.equal(
    gaps.every((gap) => gap.kind !== 'unexplored'),
    true,
  );
});

test('the report discloses how it matched, because the match is a heuristic', () => {
  const report = evaluateCoverage(map(), []);
  assert.match(report.method, /normalised label text/);
});
