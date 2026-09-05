import assert from 'node:assert/strict';
import test from 'node:test';
import type { PageSnapshot } from '../browser/extract.js';
import { filterByAction } from './resolve.js';

function snapshot(): PageSnapshot {
  const el = (over: Record<string, unknown>) =>
    ({
      ref: 'e1', tagName: 'div', role: 'generic', accessibleName: '', text: '',
      ariaLabel: null, id: null, testId: null, nameAttr: null, inputType: null,
      placeholder: null, labelText: null, altText: null, context: null,
      nearbyText: [], labelAnchor: null, href: null, required: false,
      formIndex: null, interactive: false, textOnly: false, enabled: true,
      box: { x: 0, y: 0, width: 1, height: 1 },
      ...over,
    }) as never;
  return {
    url: 'https://x.test/', title: 'T', truncated: false,
    unreachable: { iframes: 0, shadowRoots: 0 },
    elements: [
      el({ ref: 'e1', role: 'textbox', tagName: 'input', interactive: true }),
      el({ ref: 'e2', role: 'button', tagName: 'button', interactive: true }),
      el({ ref: 'e3', role: 'button', tagName: 'button', interactive: true, enabled: false }),
      el({ ref: 'e4', role: 'heading', tagName: 'h1' }),
      el({ ref: 'e5', role: 'link', tagName: 'a', interactive: true }),
    ],
  } as never;
}

test('a fill step sees only input controls', () => {
  const refs = filterByAction(snapshot(), 'fill').elements.map((e) => e.ref);
  assert.deepEqual(refs, ['e1']);
});

test('a click step sees interactive elements, disabled ones included for diagnosis', () => {
  const refs = filterByAction(snapshot(), 'click').elements.map((e) => e.ref);
  assert.deepEqual(refs, ['e1', 'e2', 'e3', 'e5']);
});

test('an assert step sees everything, because its target can be anything', () => {
  assert.equal(filterByAction(snapshot(), 'assert').elements.length, 5);
});

test('a filter that would empty the list falls back to the full inventory', () => {
  const only = { ...snapshot(), elements: [snapshot().elements[3]!] } as PageSnapshot;
  // Filling on a page with only a heading: misjudged page, keep everything.
  assert.equal(filterByAction(only, 'fill').elements.length, 1);
});
