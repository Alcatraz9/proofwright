import assert from 'node:assert/strict';
import test from 'node:test';
import { formCount, type SiteMap } from './types.js';
import { __testables } from './crawl.js';

const { normalise, endsSession, describe: describeElement, negativesFor } = __testables;

function element(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'e1',
    tagName: 'a',
    role: 'link',
    accessibleName: '',
    text: '',
    ariaLabel: null,
    id: null,
    testId: null,
    nameAttr: null,
    inputType: null,
    placeholder: null,
    labelText: null,
    altText: null,
    context: null,
    nearbyText: [],
    labelAnchor: null,
    href: null,
    required: false,
    formIndex: null,
    interactive: true,
    textOnly: false,
    enabled: true,
    box: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  } as never;
}

test('a fragment and a trailing slash are the same page', () => {
  assert.equal(normalise('https://x.test/a/'), normalise('https://x.test/a'));
  assert.equal(normalise('https://x.test/a#top'), normalise('https://x.test/a'));
});

test('a query string is not the same page', () => {
  assert.notEqual(normalise('https://x.test/list?page=2'), normalise('https://x.test/list'));
});

test('a sign-out link is recognised by label as well as by path', () => {
  assert.equal(
    endsSession(element({ accessibleName: 'Sign out' }), new URL('https://x.test/session/end')),
    true,
  );
  assert.equal(endsSession(element({ accessibleName: 'Basket' }), new URL('https://x.test/logout')), true);
  assert.equal(endsSession(element({ accessibleName: 'Basket' }), new URL('https://x.test/basket')), false);
});

test('an element is described the way a person would refer to it', () => {
  assert.equal(describeElement(element({ labelText: 'Email address' })), 'Email address');
  assert.equal(describeElement(element({ accessibleName: 'Sign in' })), 'Sign in');
  assert.equal(describeElement(element({ placeholder: 'Search…' })), 'Search…');
});

test('required fields yield an empty-submission test, once, naming them all', () => {
  const negatives = negativesFor(
    [
      { label: 'Email', inputType: 'email', required: true, name: 'email' },
      { label: 'Password', inputType: 'password', required: true, name: 'password' },
    ],
    false,
  );
  const empties = negatives.filter((entry) => entry.kind === 'empty_required');
  assert.equal(empties.length, 1);
  assert.match(empties[0]!.field, /Email/);
  assert.match(empties[0]!.field, /Password/);
});

test('an auth form always yields a wrong-credential test', () => {
  const negatives = negativesFor(
    [{ label: 'Password', inputType: 'password', required: false, name: null }],
    true,
  );
  assert.equal(
    negatives.some((entry) => entry.kind === 'wrong_credential'),
    true,
  );
});

test('a form with nothing required and no special types affords no negatives', () => {
  const negatives = negativesFor(
    [{ label: 'Nickname', inputType: 'text', required: false, name: 'nick' }],
    false,
  );
  assert.deepEqual(negatives, []);
});

test('formCount totals across pages', () => {
  const map = {
    pages: [
      { forms: [{}, {}] },
      { forms: [] },
      { forms: [{}] },
    ],
  } as unknown as SiteMap;
  assert.equal(formCount(map), 3);
});
