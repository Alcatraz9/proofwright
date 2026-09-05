import { PRODUCTS, priceOf, type Product, type VersionSpec } from './versions.js';

/**
 * Renders the fixture pages.
 *
 * Plain server-rendered HTML with real navigation and real form posts. A
 * single-page app swapping sections with JavaScript would never change its URL,
 * which would make three verdicts undemonstrable: a step's recorded page could
 * never diverge, a route could never 404, and a session could never expire into a
 * redirect.
 *
 * Test ids exist on the login fields and nowhere else, on purpose. The login
 * fields therefore survive every rename untouched, and everything else has to be
 * found by role, label or text — so one run exercises both the durable path and
 * the fragile one instead of only whichever the author happened to choose.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function styles(spec: VersionSpec): string {
  const t = spec.theme;
  return `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font-family: ${t.fontFamily};
      background: ${t.pageBackground};
      color: ${t.bodyText};
      font-size: 16px; line-height: 1.5;
    }
    /* Fixed height and no wrapping. This bar names the version being served, so
       its text length differs between releases — and excluding it from the visual
       signature stops it being compared but cannot stop it occupying space. Left
       free to wrap it reflowed the whole page at a narrow viewport and reported
       six layout shifts on a form nobody had touched. */
    .banner {
      background: ${t.accent}; color: ${t.accentText};
      padding: 0 20px; font-size: 13px; height: 40px;
      display: flex; justify-content: space-between; align-items: center;
      white-space: nowrap; overflow: hidden;
    }
    .banner a { color: ${t.accentText}; }
    .scaffold-note { height: 22px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    main { max-width: 940px; margin: 0 auto; padding: 28px 20px 56px; }
    h1 { font-size: 26px; margin: 0 0 6px; }
    h2 { font-size: 19px; margin: 0 0 10px; }
    .card {
      background: ${t.cardBackground};
      border: 1px solid ${t.borderColor};
      border-radius: ${t.radius};
      box-shadow: ${t.shadow};
      padding: 20px; margin-bottom: 18px;
    }
    label { display: block; font-size: 13px; margin-bottom: 4px; font-weight: 600; }
    input[type=email], input[type=password], input[type=search], input[type=text] {
      width: 100%; padding: 9px 11px;
      border: 1px solid ${t.borderColor};
      border-radius: ${t.radius};
      font-family: inherit; font-size: 15px; background: #fff; color: ${t.bodyText};
    }
    .field { margin-bottom: 14px; }
    button, .button {
      display: inline-block; cursor: pointer;
      background: ${t.accent}; color: ${t.accentText};
      border: 1px solid ${t.accent};
      border-radius: ${t.radius};
      padding: 10px 18px; font-family: inherit; font-size: 15px;
      text-decoration: none;
    }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .price { font-size: 20px; font-weight: 700; }
    .layout { display: grid; grid-template-columns: 1fr 300px; gap: 18px; align-items: start; }
    .layout.stacked { grid-template-columns: 1fr; }
    dl { margin: 0; }
    dl div { display: flex; justify-content: space-between; padding: 5px 0; }
    dt { font-weight: 600; }
    dd { margin: 0; }
    .alert { padding: 10px 12px; border-radius: ${t.radius}; margin-top: 14px; font-size: 14px; }
    .alert-error { background: #fdecec; color: #8d1b1b; border: 1px solid #f3bcbc; }
    .alert-ok { background: #eaf6ec; color: #1d6b2c; border: 1px solid #b7dfc0; }
    /* Secondary text. In v1 this is far too light against the card — a real
       contrast failure that axe reports and the v2 remediation fixes. */
    .muted { color: ${t.mutedText}; font-size: 13px; }
    .searchbar { display: flex; gap: 8px; align-items: flex-end; }
    .searchbar > div { flex: 1; }
    .icon-button {
      width: 40px; height: 40px; line-height: 1; text-align: center;
      padding: 0; font-size: 16px;
    }
  `;
}

interface LayoutParams {
  spec: VersionSpec;
  base: string;
  title: string;
  body: string;
  signedIn: boolean;
}

/**
 * The page shell.
 *
 * A poor release wraps content in a bare div, so there is no landmark for a screen
 * reader to skip to. A remediated one uses `<main>` and `<nav>`. Both are real
 * markup differences that axe scores, and neither changes the layout.
 */
function page({ spec, base, title, body, signedIn }: LayoutParams): string {
  const good = spec.accessibility === 'good';
  const nav = signedIn
    ? good
      ? `<nav aria-label="Account"><a href="${base}/logout">Sign out</a></nav>`
      : `<span><a href="${base}/logout">Sign out</a></span>`
    : '';

  // A credential left in a shipped bundle. Weak releases carry it; hardened ones
  // do not. This is the single most common real leak there is.
  const leakedKey =
    spec.security === 'weak'
      ? `<script>window.ANALYTICS_CONFIG = { apiKey: "AIzaSyD3mo0nlyN0tAr3alK3yF0rT3st1ngXYZ" };</script>`
      : `<script>window.ANALYTICS_CONFIG = { endpoint: "/api/telemetry" };</script>`;

  const content = good
    ? `<main>\n${body}\n</main>`
    : `<div>\n${body}\n</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Northwind Supply</title>
<style>${styles(spec)}</style>
</head>
<body>
<div class="banner" data-qa-visual-ignore="scaffolding">
  <span><strong>Northwind Supply</strong> — app under test</span>
  <span>${escapeHtml(spec.displayName)}${nav ? ` · ${nav}` : ''}</span>
</div>
${content}
${leakedKey}
</body>
</html>`;
}

/**
 * The login form.
 *
 * A poor release labels its inputs with a placeholder only, which vanishes as soon
 * as the field has content and is not a label at all. A remediated one uses a real
 * `<label for>`. The test ids are on the inputs in both, so this pair changes the
 * accessibility score without touching the recorded locators — which is what makes
 * v2's single healed step attributable to one specific control rather than to a
 * general reshuffle.
 */
export function renderLogin(
  spec: VersionSpec,
  base: string,
  error: string | null,
  success: string | null,
): string {
  const { ids, labels } = spec;
  const good = spec.accessibility === 'good';

  const alert = error
    ? `<div class="alert alert-error" id="${ids.statusMessage}" role="alert">${escapeHtml(error)}</div>`
    : success
      ? `<div class="alert alert-ok" id="${ids.statusMessage}" role="status">${escapeHtml(success)}</div>`
      : '';

  // A password field offering to be remembered on a shared machine.
  const autocomplete = spec.security === 'hardened' ? 'current-password' : 'on';

  const emailField = good
    ? `<div class="field">
      <label for="${ids.emailInput}">Email</label>
      <input type="email" id="${ids.emailInput}" name="email" data-testid="${ids.emailInput}"
             autocomplete="username" required>
    </div>`
    : `<div class="field">
      <input type="email" id="${ids.emailInput}" name="email" data-testid="${ids.emailInput}"
             placeholder="Email" required>
    </div>`;

  const passwordField = good
    ? `<div class="field">
      <label for="${ids.passwordInput}">Password</label>
      <input type="password" id="${ids.passwordInput}" name="password" data-testid="${ids.passwordInput}"
             autocomplete="${autocomplete}" required>
    </div>`
    : `<div class="field">
      <input type="password" id="${ids.passwordInput}" name="password" data-testid="${ids.passwordInput}"
             placeholder="Password" autocomplete="${autocomplete}" required>
    </div>`;

  // Two independent concerns on one form, and they must be gated independently.
  //
  // Whether the field has a label is an accessibility property. Whether the form
  // posts over http, and whether the link is safe to open, are security
  // properties. They were briefly gated on the same flag, which meant the
  // accessibility release still reported a missing label — a fix attributed to the
  // wrong remediation, and a score that could not reach 100 for a reason that had
  // nothing to do with accessibility.
  const newsletterAction =
    spec.security === 'weak'
      ? 'http://newsletter.example.com/subscribe'
      : 'https://newsletter.example.com/subscribe';
  const termsHref =
    spec.security === 'weak'
      ? 'http://newsletter.example.com/terms'
      : 'https://newsletter.example.com/terms';
  const termsRel = spec.security === 'weak' ? '' : ' rel="noopener noreferrer"';
  const subscriberField = good
    ? `<label for="subscriber">Email for updates</label>
    <input type="email" id="subscriber" name="subscriber">`
    : `<input type="email" id="subscriber" name="subscriber">`;

  const newsletter = `<form class="card" action="${newsletterAction}" method="post">
    <p class="muted scaffold-note">Get product updates</p>
    ${subscriberField}
    <a href="${termsHref}" target="_blank"${termsRel}>Terms</a>
  </form>`;

  return page({
    spec,
    base,
    signedIn: false,
    title: labels.loginHeading,
    body: `
<h1>${escapeHtml(labels.loginHeading)}</h1>
<p class="muted scaffold-note" data-qa-visual-ignore="scaffolding">${escapeHtml(spec.story)}</p>
<div class="card" style="max-width:420px">
  <form id="${ids.loginForm}" method="post" action="${base}/login">
    ${emailField}
    ${passwordField}
    <button type="submit" id="${ids.submitButton}" data-testid="${ids.submitButton}">${escapeHtml(labels.signIn)}</button>
  </form>
  ${alert}
</div>
${newsletter}`,
  });
}

/**
 * The catalogue.
 *
 * The search control is the accessibility remediation that breaks a test. In a
 * poor release it is an icon-only element with no accessible name and no role — a
 * `div` with a click handler, which is how these are usually written. There is
 * nothing durable to locate it by, so a recorded locator falls back to CSS.
 *
 * In a remediated release it becomes a real `<button>` with an accessible name.
 * The CSS locator breaks, and the healer has to work out that the new labelled
 * button serves the same purpose. That is the whole argument for this tool made in
 * one control: the accessibility fix is correct, it broke the test, and the test
 * repaired itself instead of punishing the fix.
 */
export function renderCatalog(spec: VersionSpec, base: string, query = ''): string {
  const { ids, labels } = spec;
  const good = spec.accessibility === 'good';

  // Search genuinely filters and genuinely navigates. That matters beyond realism:
  // a step whose click changes nothing observable has no post-condition, and a
  // heal for such a step can only be accepted on the model's word. Giving the
  // control a real effect is what makes its repair verifiable by the application.
  const term = query.trim().toLowerCase();
  const matching = term
    ? PRODUCTS.filter(
        (p) => p.name.toLowerCase().includes(term) || p.blurb.toLowerCase().includes(term),
      )
    : PRODUCTS;

  const products = spec.duplicateCatalogue ? [...matching, ...matching] : matching;

  const cards = products
    .map((product, index) => {
      const image = good
        ? `<img src="data:image/svg+xml;utf8,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ccd"/></svg>`,
          )}" alt="${escapeHtml(product.name)}" width="40" height="40">`
        : `<img src="data:image/svg+xml;utf8,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ccd"/></svg>`,
          )}" width="40" height="40">`;

      return `
    <div class="card" data-product="${product.id}">
      ${image}
      <h2>${escapeHtml(product.name)}</h2>
      <p class="muted">${escapeHtml(product.blurb)}</p>
      <p class="price">${escapeHtml(priceOf(product, spec))}</p>
      <a class="button" href="${base}/product/${product.id}">View</a>
    </div>`;
    })
    .join('');

  // An inline magnifier, drawn rather than typed, so the control has no text
  // content in either release. That matters: it means the ONLY thing separating a
  // durable locator from a fragile one here is whether the button has an
  // accessible name.
  const magnifier =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" stroke-width="2"/></svg>';

  const searchControl = good
    ? // Remediated: a real label, and a button with an accessible name. The id is
      // gone, because the remediation replaced a JS-hooked div with semantic
      // markup that no longer needs one — which is exactly why the recorded CSS
      // locator stops working.
      `<form class="searchbar" method="get" action="${base}/catalog">
      <div>
        <label for="${ids.searchInput}">Search the catalogue</label>
        <input type="search" id="${ids.searchInput}" name="q" value="${escapeHtml(query)}">
      </div>
      <button type="submit" class="icon-button" aria-label="Search products">${magnifier}</button>
    </form>`
    : // Legacy: a placeholder standing in for a label, and an icon button with no
      // accessible name at all. axe reports button-name as critical, and the only
      // locator available is its id — the least durable strategy there is.
      `<form class="searchbar" method="get" action="${base}/catalog">
      <div>
        <input type="search" id="${ids.searchInput}" name="q" placeholder="Search products"
               value="${escapeHtml(query)}">
      </div>
      <button type="submit" id="${ids.searchButton}" class="icon-button">${magnifier}</button>
    </form>`;

  return page({
    spec,
    base,
    signedIn: true,
    title: labels.catalogHeading,
    body: `
<div id="${ids.catalogRoot}">
  <h1>${escapeHtml(labels.catalogHeading)}</h1>
  <div class="card">${searchControl}</div>
  ${
    term
      ? `<p role="status">Showing ${matching.length} result${matching.length === 1 ? '' : 's'} for &ldquo;${escapeHtml(query)}&rdquo;</p>`
      : ''
  }
  <div class="grid" id="${ids.productGrid}">${cards}</div>
</div>`,
  });
}

export function renderProduct(spec: VersionSpec, base: string, product: Product): string {
  const { ids, labels } = spec;
  return page({
    spec,
    base,
    signedIn: true,
    title: product.name,
    body: `
<div id="${ids.productRoot}">
  <p class="muted"><a href="${base}/catalog">&larr; ${escapeHtml(labels.catalogHeading)}</a></p>
  <div class="card">
    <h1 id="${ids.productTitle}">${escapeHtml(product.name)}</h1>
    <p class="muted">${escapeHtml(product.blurb)}</p>
    <p class="price" id="${ids.productPrice}">${escapeHtml(priceOf(product, spec))}</p>
    <form method="post" action="${base}/cart">
      <input type="hidden" name="productId" value="${product.id}">
      <button type="submit" id="${ids.addToCartButton}">${escapeHtml(labels.addToCart)}</button>
    </form>
  </div>
</div>`,
  });
}

/**
 * The basket, and the control this demo turns on.
 *
 * 'inline' places checkout immediately after the price, which gives it a
 * label-anchored fallback that survives a rename — so a rename there passes via
 * the fallback and is reported as drift rather than healed.
 *
 * 'actionBar' moves it into its own bar as a button with no price beside it, so
 * the role locator, the text fallback and the label anchor break together. That is
 * a genuinely stale locator.
 *
 * 'removed' deletes it. The healer is asked, and the correct answer is that
 * nothing on this page serves the original intent.
 */
export function renderCart(spec: VersionSpec, base: string, product: Product): string {
  const { labels } = spec;
  const price = priceOf(product, spec);

  const item = `
<div class="card">
  <h2>${escapeHtml(product.name)}</h2>
  <p class="price">${escapeHtml(price)}</p>
  ${
    spec.checkoutControl === 'inline'
      ? `<a class="button" href="${base}/checkout">${escapeHtml(labels.checkout)}</a>`
      : ''
  }
</div>`;

  const actionBar =
    spec.checkoutControl === 'actionBar'
      ? `
<div class="card" style="display:flex;justify-content:flex-end;align-items:center;gap:12px">
  <span class="muted">Ready when you are</span>
  <form method="get" action="${base}/checkout">
    <button type="submit">${escapeHtml(labels.checkout)}</button>
  </form>
</div>`
      : '';

  const removedNotice =
    spec.checkoutControl === 'removed'
      ? `<div class="card"><p class="muted">Checkout is temporarily unavailable.</p></div>`
      : '';

  return page({
    spec,
    base,
    signedIn: true,
    title: 'Basket',
    body: `<h1>Basket</h1>${item}${actionBar}${removedNotice}`,
  });
}

/**
 * Checkout, and the total.
 *
 * The total is a definition list so the amount's identity comes from the inert
 * "Total" label beside it rather than from its own digits. A price change then
 * fails a test that named the price and passes one that only said a total is
 * shown — instead of arriving as a missing element and being repaired into the new
 * number, which would make a pricing regression indistinguishable from a rename.
 */
export function renderCheckout(spec: VersionSpec, base: string, product: Product): string {
  const { ids, labels } = spec;
  const price = priceOf(product, spec);

  const summary = `
  <div class="card" id="${ids.summaryPanel}">
    <h2>Order summary</h2>
    <dl>
      <div><dt>Item</dt><dd>${escapeHtml(product.name)}</dd></div>
      <div><dt>Delivery</dt><dd>£0.00</dd></div>
      <div><dt>${escapeHtml(labels.totalLabel)}</dt><dd id="${ids.totalValue}">${escapeHtml(price)}</dd></div>
    </dl>
  </div>`;

  const form = `
  <div class="card">
    <h2>Delivery address</h2>
    <form method="post" action="${base}/order">
      <div class="field">
        <label for="addr-line1">Address line 1</label>
        <input type="text" id="addr-line1" name="line1" value="12 Bridge Street">
      </div>
      <button type="submit" id="${ids.placeOrderButton}">${escapeHtml(labels.placeOrder)}</button>
    </form>
  </div>`;

  // Stacking the summary above the form moves a real box, so it is a layout shift
  // and must not be absorbed the way a colour change is.
  const layout =
    spec.summaryPosition === 'above'
      ? `<div class="layout stacked">${summary}${form}</div>`
      : `<div class="layout">${form}${summary}</div>`;

  return page({
    spec,
    base,
    signedIn: true,
    title: labels.checkoutHeading,
    body: `<div id="${ids.checkoutRoot}"><h1>${escapeHtml(labels.checkoutHeading)}</h1>${layout}</div>`,
  });
}

export function renderConfirmation(spec: VersionSpec, base: string, orderNumber: string): string {
  const { ids, labels } = spec;
  return page({
    spec,
    base,
    signedIn: true,
    title: labels.confirmedHeading,
    body: `
<div id="${ids.confirmationRoot}">
  <h1>${escapeHtml(labels.confirmedHeading)}</h1>
  <div class="card">
    <div class="alert alert-ok" role="status">Thank you. Your order is on its way.</div>
    <dl>
      <div><dt>Order number</dt><dd id="${ids.orderNumber}">${escapeHtml(orderNumber)}</dd></div>
    </dl>
  </div>
</div>`,
  });
}

export function renderError(
  spec: VersionSpec,
  base: string,
  status: number,
  message: string,
): string {
  return page({
    spec,
    base,
    signedIn: false,
    title: `${status}`,
    body: `
<h1>${status}</h1>
<div class="card"><div class="alert alert-error" role="alert">${escapeHtml(message)}</div></div>`,
  });
}
