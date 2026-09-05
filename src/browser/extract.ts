import type { Page } from 'playwright';

/** One candidate element as the LLM sees it. */
export interface ExtractedElement {
  /** Session-local handle, mirrored onto the DOM as `data-qa-ref`. */
  ref: string;
  tagName: string;
  role: string;
  accessibleName: string;
  text: string;
  ariaLabel: string | null;
  id: string | null;
  testId: string | null;
  nameAttr: string | null;
  inputType: string | null;
  placeholder: string | null;
  labelText: string | null;
  altText: string | null;
  context: string | null;
  nearbyText: string[];
  /**
   * Exact text of the element that labels this one, when this element is the
   * value half of a label/value pair. Gives a value element an identity that
   * does not depend on its own content.
   */
  labelAnchor: string | null;
  /**
   * Absolute resolved destination for a link, so a crawl frontier has somewhere
   * to go. Resolved rather than raw, because `href="../catalog"` is not a place.
   */
  href: string | null;
  /**
   * Whether the field is required. Read from the attribute or ARIA, because the
   * cheapest negative test any form offers is submitting it empty, and that test
   * cannot be derived without knowing which fields it should complain about.
   */
  required: boolean;
  /**
   * Which form on the page this control belongs to, indexed in document order,
   * or null when it belongs to none. A form is the unit a negative path is
   * derived for, so its controls have to be groupable.
   */
  formIndex: number | null;
  interactive: boolean;
  /** Collected only for its text — a plausible assertion target, never clickable. */
  textOnly: boolean;
  enabled: boolean;
  /**
   * Where the element is and what it looks like.
   *
   * Recorded so that a change in appearance can be told apart from a change in
   * layout. A screenshot diff cannot make that distinction — it counts differing
   * pixels, and a button that changed colour and a button that moved fifty pixels
   * produce the same number. Comparing boxes and computed styles separately does
   * distinguish them, which is the difference between a restyle that should heal
   * itself and a reflow that a person should look at.
   *
   * Almost free: the extractor already called `getBoundingClientRect` and
   * `getComputedStyle` on every element for its visibility test and threw both
   * away.
   */
  box: BoxMetrics;
  styles: StyleMetrics;
}

/** Position and size in CSS pixels, relative to the document rather than the viewport. */
export interface BoxMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The subset of computed style worth comparing.
 *
 * Split deliberately into two groups. Everything in `cosmetic` can change without
 * moving anything: colour, weight, corner radius, shadow. Everything in
 * `structural` changes layout when it changes. That split is what lets a diff be
 * classified by construction rather than by a guess about which properties
 * "probably" matter.
 */
export interface StyleMetrics {
  cosmetic: {
    color: string;
    backgroundColor: string;
    borderColor: string;
    borderRadius: string;
    boxShadow: string;
    fontFamily: string;
    fontWeight: string;
    fontStyle: string;
    textDecorationLine: string;
    opacity: string;
    textTransform: string;
  };
  structural: {
    display: string;
    visibility: string;
    position: string;
    fontSize: string;
    lineHeight: string;
    padding: string;
    margin: string;
    borderWidth: string;
    flexDirection: string;
    textAlign: string;
  };
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ExtractedElement[];
  /** True when extraction hit the cap and dropped low-priority elements. */
  truncated: boolean;
  /**
   * Parts of the page this walker cannot see. `document.querySelectorAll` does
   * not cross iframe or shadow boundaries, so anything inside them is invisible
   * to both resolution and healing — payment fields, embedded widgets and most
   * web-component design systems live there. Counted so a baseline recorded
   * against such a page can say so rather than quietly look complete.
   */
  unreachable: { iframes: number; shadowRoots: number };
}

export const REF_ATTRIBUTE = 'data-qa-ref';

/**
 * Refs are namespaced per extraction pass. Without this, an element left over
 * from an earlier pass could still carry `data-qa-ref="e5"` while a different
 * element becomes `e5` in the current pass — and locator verification would
 * confirm the wrong element.
 */
let extractionPass = 0;

/**
 * Walks the DOM and returns everything a step might plausibly target.
 *
 * Deliberately not limited to interactive elements: `assert` steps target static
 * content ("the product is visible"), so headings, images and test-id-bearing
 * containers are collected too and flagged with `interactive: false`.
 *
 * Each element is stamped with `data-qa-ref` so the resolver can act on exactly
 * the element the model chose. That attribute is scaffolding for this run only —
 * the durable locator is always derived from the page's own attributes.
 *
 * Two failure modes on slow real-world applications are absorbed here rather
 * than surfaced, because both are races and not answers:
 *
 * - "Execution context was destroyed": the extraction fired while a navigation
 *   was in flight (a click whose response takes longer than `settle`'s ceiling —
 *   OrangeHRM's demo takes ~4.4s from Login to dashboard). The right response is
 *   to wait for the new document and extract *that*, not to abort the recording.
 * - An empty inventory on a page that is still hydrating: an SPA can reach
 *   `domcontentloaded` with a bare root div, so zero elements usually means
 *   "too early", not "nothing there". Retried briefly; a genuinely empty page
 *   still comes back empty after the retries and is reported as such.
 */
export async function extractPage(page: Page, maxElements = 120): Promise<PageSnapshot> {
  const attempts = 4;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let snapshot: PageSnapshot;
    try {
      snapshot = await extractPageOnce(page, maxElements);
    } catch (err) {
      if (!isContextDestroyed(err)) throw err;
      lastError = err;
      // A navigation is (or was) in flight. Wait for the destination document
      // to exist, give the SPA a beat to render, and extract the new page.
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    if (snapshot.elements.length > 0 || attempt === attempts - 1) return snapshot;
    // Empty inventory: likely pre-hydration. Wait and look again.
    await page.waitForTimeout(1_500);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Page extraction failed: the page kept navigating away.');
}

function isContextDestroyed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id')
  );
}

async function extractPageOnce(page: Page, maxElements: number): Promise<PageSnapshot> {
  const pass = extractionPass++;
  return page.evaluate(
    ({ refAttribute, cap, pass }) => {
      const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

      // Document order, so a form's index is stable between two extractions of
      // the same page and can be referenced from a plan.
      const formList = Array.from(document.querySelectorAll('form'));

      const INTERACTIVE_SELECTOR = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[contenteditable="true"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',');

      const CONTENT_SELECTOR = [
        'h1',
        'h2',
        'h3',
        'h4',
        'img[alt]',
        '[role="heading"]',
        '[role="alert"]',
        '[role="status"]',
        ...TEST_ID_ATTRS.map((a) => `[${a}]`),
      ].join(',');

      // Text-bearing leaves. Assertions in real test cases are overwhelmingly
      // about text — a total, a confirmation message, an error string — and none
      // of that is interactive or a heading. Without this, an `assert` step
      // targeting "the order total" has nothing to match and the whole test is
      // unrecordable.
      const TEXT_SELECTOR = [
        'p',
        'span',
        'div',
        'li',
        'td',
        'th',
        'dd',
        'dt',
        'strong',
        'em',
        'b',
        'small',
        'label',
        'code',
        'time',
        'output',
        'figcaption',
        'legend',
        'h5',
        'h6',
      ].join(',');

      const clean = (value: string | null | undefined, max = 200): string =>
        (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        // Zero-size is fine for inputs that are visually replaced (custom checkboxes).
        return rect.width > 0 || rect.height > 0 || el.tagName === 'INPUT';
      };

      const implicitRole = (el: Element): string => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;

        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
          const type = (el.getAttribute('type') ?? 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'number') return 'spinbutton';
          if (type === 'range') return 'slider';
          if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
        if (tag === 'button' || tag === 'summary') return 'button';
        if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'img') return 'img';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'li') return 'listitem';
        if (tag === 'form') return 'form';
        if (tag === 'nav') return 'navigation';
        if (tag === 'table') return 'table';
        return 'generic';
      };

      const labelFor = (el: Element): string | null => {
        const id = el.getAttribute('id');
        if (id) {
          const escaped = window.CSS?.escape ? window.CSS.escape(id) : id;
          const label = document.querySelector(`label[for="${escaped}"]`);
          if (label) return clean(label.textContent, 120);
        }
        const wrapping = el.closest('label');
        if (wrapping) return clean(wrapping.textContent, 120);
        return null;
      };

      /** Simplified accessible-name computation, in spec precedence order. */
      const accessibleName = (el: Element): string => {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .filter(Boolean);
          if (parts.length > 0) return clean(parts.join(' '), 120);
        }

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return clean(ariaLabel, 120);

        const label = labelFor(el);
        if (label) return label;

        const alt = el.getAttribute('alt');
        if (alt) return clean(alt, 120);

        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
          const type = (el.getAttribute('type') ?? 'text').toLowerCase();
          // Only value-as-name for button-like inputs; a text input's value is data.
          if (['button', 'submit', 'reset'].includes(type)) {
            return clean((el as HTMLInputElement).value, 120);
          }
          return clean(el.getAttribute('placeholder'), 120);
        }

        const title = el.getAttribute('title');
        const own = clean(el.textContent, 120);
        return own || clean(title, 120);
      };

      /** Nearest meaningful container, used to disambiguate repeated elements. */
      const contextOf = (el: Element): string | null => {
        let node: Element | null = el.parentElement;
        while (node && node !== document.body) {
          const labelled = node.getAttribute('aria-label') ?? node.getAttribute('data-testid');
          if (labelled) return clean(labelled, 80);

          const tag = node.tagName.toLowerCase();
          if (['form', 'nav', 'header', 'footer', 'main', 'aside', 'dialog'].includes(tag)) {
            const heading = node.querySelector('h1,h2,h3,h4,legend');
            return clean(heading?.textContent, 80) || tag;
          }
          if (['section', 'article'].includes(tag)) {
            const heading = node.querySelector('h1,h2,h3,h4');
            const name = clean(heading?.textContent, 80);
            if (name) return name;
          }
          node = node.parentElement;
        }
        return null;
      };

      /**
       * The label for a value element, if it has one.
       *
       * Requires the preceding sibling to be a leaf with short text — a label is
       * a short piece of text, not a container. Deliberately one relationship
       * rather than a rule per tag: `<dt>`/`<dd>`, `<label>` and its field,
       * `<th>`/`<td>` in a row and two sibling spans are all "the previous
       * element sibling labels me".
       *
       * Returns the text verbatim, colon included, because the locator matches
       * the label exactly and must agree with what is really in the DOM.
       */
      const labelAnchorOf = (el: Element): string | null => {
        const previous = el.previousElementSibling;
        if (!previous || previous.children.length > 0) return null;

        // A label is inert text. A control that happens to precede this element
        // labels nothing — two stacked buttons are not a label/value pair — and a
        // heading names a whole section rather than the field beside it.
        if (interactive.has(previous)) return null;
        const previousTag = previous.tagName.toLowerCase();
        if (/^h[1-6]$/.test(previousTag) || previous.getAttribute('role') === 'heading') {
          return null;
        }

        const text = clean(previous.textContent, 80);
        if (text.length === 0 || text.length > 60) return null;
        // A quote would have to be escaped into the XPath; not worth the risk.
        if (/["']/.test(text)) return null;
        return text;
      };

      /** Sibling text that helps a human tell two identical buttons apart. */
      const nearbyTextOf = (el: Element): string[] => {
        const parent = el.parentElement;
        if (!parent) return [];
        const own = clean(el.textContent, 200);
        const out: string[] = [];
        for (const child of Array.from(parent.children)) {
          if (child === el || out.length >= 5) continue;
          const text = clean(child.textContent, 60);
          if (text && text !== own && !out.includes(text)) out.push(text);
        }
        return out;
      };

      const interactive = new Set(Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)));
      const content = Array.from(document.querySelectorAll(CONTENT_SELECTOR)).filter(
        (el) => !interactive.has(el),
      );
      const contentSet = new Set(content);

      // Leaves only: a wrapper's text is just its children's text concatenated,
      // so collecting ancestors would bury the actual content under duplicates.
      const textLeaves = Array.from(document.querySelectorAll(TEXT_SELECTOR)).filter((el) => {
        if (interactive.has(el) || contentSet.has(el)) return false;
        if (el.children.length > 0) return false;
        const text = clean(el.textContent, 100);
        return text.length > 0 && text.length <= 80;
      });

      const textLeafSet = new Set(textLeaves);
      const all = [...interactive, ...content, ...textLeaves];

      const collected: Array<
        Record<string, unknown> & { interactive: boolean; textOnly: boolean }
      > = [];
      let index = 0;

      for (const el of all) {
        if (!isVisible(el)) continue;

        const ref = `s${pass}e${index++}`;
        el.setAttribute(refAttribute, ref);

        let testId: string | null = null;
        for (const attr of TEST_ID_ATTRS) {
          const found = el.getAttribute(attr);
          if (found) {
            testId = found;
            break;
          }
        }

        const inputType = el.getAttribute('type');
        // Read once per element and reused, since both of these force layout and
        // the visibility check above has already paid for them.
        const rect = el.getBoundingClientRect();
        const computed = window.getComputedStyle(el);
        collected.push({
          ref,
          tagName: el.tagName.toLowerCase(),
          role: implicitRole(el),
          accessibleName: accessibleName(el),
          text: clean(el.textContent, 150),
          ariaLabel: el.getAttribute('aria-label'),
          id: el.getAttribute('id'),
          testId,
          nameAttr: el.getAttribute('name'),
          inputType: inputType ? inputType.toLowerCase() : null,
          placeholder: el.getAttribute('placeholder'),
          labelText: labelFor(el),
          altText: el.getAttribute('alt'),
          context: contextOf(el),
          nearbyText: nearbyTextOf(el),
          labelAnchor: labelAnchorOf(el),
          href:
            el instanceof HTMLAnchorElement && el.href
              ? el.href
              : el.getAttribute('href')
                ? new URL(el.getAttribute('href')!, document.baseURI).href
                : null,
          required:
            el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
          formIndex: (() => {
            const owner = el.closest('form');
            if (!owner) return null;
            const index = formList.indexOf(owner);
            return index === -1 ? null : index;
          })(),
          interactive: interactive.has(el),
          textOnly: textLeafSet.has(el),
          enabled: !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
          // Document-relative, so scroll position between two runs does not read
          // as the element having moved.
          box: {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          styles: {
            cosmetic: {
              color: computed.color,
              backgroundColor: computed.backgroundColor,
              borderColor: computed.borderColor,
              borderRadius: computed.borderRadius,
              boxShadow: computed.boxShadow,
              fontFamily: computed.fontFamily,
              fontWeight: computed.fontWeight,
              fontStyle: computed.fontStyle,
              textDecorationLine: computed.textDecorationLine,
              opacity: computed.opacity,
              textTransform: computed.textTransform,
            },
            structural: {
              display: computed.display,
              visibility: computed.visibility,
              position: computed.position,
              fontSize: computed.fontSize,
              lineHeight: computed.lineHeight,
              padding: computed.padding,
              margin: computed.margin,
              borderWidth: computed.borderWidth,
              flexDirection: computed.flexDirection,
              textAlign: computed.textAlign,
            },
          },
        });
      }

      // Three tiers, most likely target first, so the cap drops the least useful.
      const ranked = [
        ...collected.filter((e) => e.interactive),
        ...collected.filter((e) => !e.interactive && !e.textOnly),
        ...collected.filter((e) => e.textOnly),
      ];

      // Open shadow roots only — a closed one is unreachable even to count.
      const shadowRoots = Array.from(document.querySelectorAll('*')).filter(
        (el) => (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot,
      ).length;

      return {
        url: window.location.href,
        title: document.title,
        elements: ranked.slice(0, cap),
        truncated: ranked.length > cap,
        unreachable: {
          iframes: document.querySelectorAll('iframe,frame').length,
          shadowRoots,
        },
      };
    },
    { refAttribute: REF_ATTRIBUTE, cap: maxElements, pass },
  ) as unknown as Promise<PageSnapshot>;
}

/** Compact rendering for the prompt — JSON of this would be mostly null padding. */
export function renderElementsForPrompt(snapshot: PageSnapshot): string {
  const lines = snapshot.elements.map((el) => {
    const parts = [`[${el.ref}]`, el.role];
    if (el.accessibleName) parts.push(`name="${el.accessibleName}"`);
    if (el.testId) parts.push(`testid="${el.testId}"`);
    if (el.inputType) parts.push(`type=${el.inputType}`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.labelText && el.labelText !== el.accessibleName) parts.push(`label="${el.labelText}"`);
    if (el.id) parts.push(`id="${el.id}"`);
    if (el.context) parts.push(`in="${el.context}"`);
    if (el.labelAnchor) parts.push(`labelledBy="${el.labelAnchor}"`);
    if (!el.enabled) parts.push('DISABLED');
    if (!el.interactive) parts.push('static');
    if (el.nearbyText.length > 0) parts.push(`near=[${el.nearbyText.join(' | ')}]`);
    return parts.join(' ');
  });

  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    '',
    ...lines,
    snapshot.truncated ? '\n(element list was truncated)' : '',
    snapshot.unreachable.iframes > 0 || snapshot.unreachable.shadowRoots > 0
      ? `\n(not traversed: ${snapshot.unreachable.iframes} iframe(s), ${snapshot.unreachable.shadowRoots} shadow root(s))`
      : '',
  ]
    .join('\n')
    .trim();
}
