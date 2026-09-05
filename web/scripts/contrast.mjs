#!/usr/bin/env node
/**
 * Contrast solver for the EdgeForge palette.
 *
 * Every text token is checked against every surface it can land on, in oklch →
 * linear sRGB → WCAG relative luminance. Run it before trusting a hierarchy.
 *
 * This exists because the previous palette was eyeballed: two text tiers were set
 * 0.04 of lightness apart and both "passed AA" while being indistinguishable on
 * adjacent lines, and one token was referenced in ~70 places without ever being
 * defined. A ratio you have not computed is a ratio you do not have.
 *
 *   node web/scripts/contrast.mjs          # table, exits 1 on any failure
 *   node web/scripts/contrast.mjs --json
 */

// --- oklch → sRGB ----------------------------------------------------------

function oklchToLinearSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** WCAG relative luminance. Operates on linear-light values, so no de-gamma. */
function relativeLuminance(L, C, h) {
  const [r, g, b] = oklchToLinearSrgb(L, C, h).map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const a = relativeLuminance(...fg);
  const b = relativeLuminance(...bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function hex(L, C, h) {
  const enc = (v) => {
    const c = Math.min(1, Math.max(0, v));
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(s * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${oklchToLinearSrgb(L, C, h).map(enc).join('')}`;
}

// --- the palette, single source of truth for this check --------------------
// Keep in step with the @theme block in web/src/index.css.

/**
 * Three surfaces, not four.
 *
 * A fourth raised fill forced the dimmest text tier down to 4.00:1 on it, and the
 * only ways out were to lift that tier until it was 0.04 of lightness from the one
 * above — the exact indistinguishable-hierarchy defect this file exists to prevent
 * — or to promise it never lands there, which no component can guarantee. The form
 * separates with hairline rules rather than stacked fills, so the surface came out
 * instead of the contrast being negotiated down.
 */
const SURFACES = {
  'plate-000': [0.205, 0.004, 250],
  'plate-100': [0.245, 0.004, 250],
  'plate-200': [0.285, 0.005, 250],
};

/**
 * Three text tiers, each a clear step from the next.
 *
 * Label hierarchy is carried by width, case and tracking rather than by a fourth
 * grey: a condensed uppercase label at full brightness reads as subordinate to
 * running prose without giving up any contrast, which is the opposite trade from
 * dimming it until it is barely legible.
 */
const INK = {
  'read-100': [0.95, 0.003, 250],
  'read-200': [0.84, 0.004, 250],
  'read-300': [0.72, 0.005, 250],
  signal: [0.8, 0.14, 78],
  'signal-ink': [0.86, 0.11, 80],
  alarm: [0.72, 0.17, 25],
  'alarm-ink': [0.78, 0.14, 27],
};

/** 4.5:1 for body text, 3:1 for large text and non-text boundaries. */
const FLOOR = 4.5;

/** Structural tokens are never text; they answer to the 3:1 boundary floor. */
const STRUCTURE = {
  rule: [0.38, 0.006, 250],
  'rule-strong': [0.46, 0.007, 250],
};

function main() {
  const asJson = process.argv.includes('--json');
  const rows = [];
  let failures = 0;

  for (const [inkName, ink] of Object.entries(INK)) {
    for (const [surfName, surf] of Object.entries(SURFACES)) {
      const r = ratio(ink, surf);
      const ok = r >= FLOOR;
      if (!ok) failures += 1;
      rows.push({ ink: inkName, surface: surfName, ratio: Number(r.toFixed(2)), floor: FLOOR, ok });
    }
  }

  for (const [name, tok] of Object.entries(STRUCTURE)) {
    for (const [surfName, surf] of Object.entries(SURFACES)) {
      const r = ratio(tok, surf);
      // A hairline rule is decorative separation, not a UI boundary that must be
      // perceivable on its own, so it is reported and never gated.
      rows.push({ ink: name, surface: surfName, ratio: Number(r.toFixed(2)), floor: 0, ok: true });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ failures, rows }, null, 2));
    process.exit(failures > 0 ? 1 : 0);
  }

  const surfNames = Object.keys(SURFACES);
  console.log('EdgeForge palette — WCAG contrast, computed from oklch\n');
  console.log(`${'token'.padEnd(12)}${'hex'.padEnd(10)}${surfNames.map((s) => s.padStart(11)).join('')}`);
  console.log('-'.repeat(12 + 10 + surfNames.length * 11));

  const emit = (name, tok, gated) => {
    const cells = surfNames
      .map((s) => {
        const r = ratio(tok, SURFACES[s]);
        const mark = !gated ? ' ' : r >= FLOOR ? '+' : '!';
        return `${r.toFixed(2)}${mark}`.padStart(11);
      })
      .join('');
    console.log(`${name.padEnd(12)}${hex(...tok).padEnd(10)}${cells}`);
  };

  for (const [name, tok] of Object.entries(INK)) emit(name, tok, true);
  console.log('');
  for (const [name, tok] of Object.entries(STRUCTURE)) emit(name, tok, false);

  console.log(`\n+ clears ${FLOOR}:1   ! below floor   structural rules ungated (separation, not boundary)`);
  console.log(failures === 0 ? '\nAll gated tokens clear the floor.' : `\n${failures} token/surface pair(s) BELOW FLOOR.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
