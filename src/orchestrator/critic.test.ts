import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntentPlan } from '../intent/types.js';
import { buildRevisionInstruction, digestSiteMap, renderPlanForCritique } from './critic.js';

function plan(): IntentPlan {
  return {
    name: 'Sign-in refusal',
    description: 'Tests refusal paths.',
    steps: [
      {
        id: 'step-1',
        intent: 'Fill the email field',
        sourcePhrase: 'fill email',
        action: 'fill',
        target: { description: 'email input field', context: null },
        value: null,
        valueRef: 'TEST_EMAIL',
        expectedValue: null,
        expectedOutcome: null,
      },
      {
        id: 'step-2',
        intent: 'Click sign in',
        sourcePhrase: 'sign in',
        action: 'click',
        target: { description: 'sign in button', context: null },
        value: null,
        valueRef: null,
        expectedValue: null,
        expectedOutcome: { description: 'the catalogue is shown' },
      },
    ],
  } as unknown as IntentPlan;
}

test('a plan renders one line per step, citable by id', () => {
  const rendered = renderPlanForCritique(plan());
  const lines = rendered.split('\n');

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^step-1: fill/);
  assert.match(lines[0]!, /valueRef=TEST_EMAIL/);
  assert.match(lines[0]!, /expect=\(none\)/);
  assert.match(lines[1]!, /expect="the catalogue is shown"/);
});

test('the rendering is a fraction of the JSON size, which is the point of it', () => {
  const rendered = renderPlanForCritique(plan());
  const asJson = JSON.stringify(plan().steps);
  assert.ok(
    rendered.length < asJson.length / 2,
    `rendered ${rendered.length} vs json ${asJson.length}`,
  );
});

test('the site-map digest is one line per page with auth marked', () => {
  const digest = digestSiteMap({
    entryUrl: 'https://x.test/',
    pages: [
      {
        url: 'https://x.test/login',
        title: 'Sign in',
        elementCount: 9,
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
            negativeOpportunities: [],
          },
        ],
      },
      {
        url: 'https://x.test/catalog',
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
    unvisited: [],
    auth: { wallFound: true, authenticated: true, note: '' },
    budget: { pagesVisited: 2, pageLimit: 8, depthLimit: 2, elapsedMs: 100, exhausted: false },
  });

  assert.equal(digest.split('\n').length, 2);
  assert.match(digest, /\/login forms: Email\+Password/);
  assert.match(digest, /\/catalog \(needs sign-in\)/);
});

test('a revision instruction carries every finding and the original scope', () => {
  const instruction = buildRevisionInstruction('Test the sign-in flow.', {
    verdict: 'revise',
    findings: [
      {
        stepId: 'step-2',
        problem: 'The outcome restates the click.',
        fix: 'Assert on the error message that appears.',
      },
      {
        stepId: 'step-3',
        problem: 'No step asserts the refusal.',
        fix: 'Add an assert on the visible error text.',
      },
    ],
  });

  assert.match(instruction, /^Test the sign-in flow\./);
  assert.match(instruction, /step-2: The outcome restates the click/);
  assert.match(instruction, /step-3: No step asserts the refusal/);
  assert.match(instruction, /keep everything else unchanged/);
});
