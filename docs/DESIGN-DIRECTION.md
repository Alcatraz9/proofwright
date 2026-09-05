# ProofWright — visual direction handoff

Written to be read cold. You are building a **replacement visual world** for an existing,
working dashboard. The direction is already chosen and recorded; your job is to execute it,
not to re-open it.

**Read these first, in this order:**

1. `PRODUCT.md` — product truth. Binding.
2. `.impeccable/surfaces/web-src.md` — the direction contract, six blocks. Binding.
3. `.impeccable/critique/2026-09-03T16-42-30Z__web-src.md` — the design review that led here.
4. `docs/CASES.md` — what the product actually does, with real verdicts.

Then load `~/.kiro/skills/impeccable/reference/new-work.md` §6 (Build with full commitment)
and `reference/craft-floor.md` immediately before you edit UI.

---

## The direction

**Aviation incident investigation / flight-data readout.**

The product's mechanism is a single question asked of every failure: *did we fail to find the
element, or did we fail to get the expected result?* The first is a stale test and gets
repaired. The second is a broken application and gets escalated, never repaired. That is the
same epistemics as an incident investigation — was it the instrument or the airframe? — and
the same refusal to guess.

The world is instrument-panel achromatics on a graphite ground, one signal accent that is
always also a control, hairline rules, tabular figures, stencil-cut labels. Recorded traces
are the only drawn things. Photographic plates — the before/after element crops from a heal —
are the only saturated things on the surface, which is correct, because they are the evidence.

**Seed key `4d82864c`**, mode Operate. Quote it if you need to reproduce the roll.

### What it refuses

The category always ships a **dark dashboard with green/red pills, metric cards and
sparklines**. That is what exists today, and it is the rut. Its predictable opposite —
**light friendly SaaS, rounded cards, an illustration** — is equally out. If someone could
guess the aesthetic from the category alone, or from category-plus-avoidance, it has failed.

Forge/metal imagery is the product name's literal reading. It is not the direction. Do not
reach for anvils, sparks or hammered texture.

### Three raises, each from a direction this one beat

Write these into the build; they are not optional flavour.

- **Total palette commitment.** One accent, and it is *simultaneously the interactive
  affordance*. An achromatic ground otherwise. Nothing else competes for attention.
- **State as a named cue with a text equivalent.** Every state addressable and labelled;
  never colour alone. This discharges the accessibility requirement structurally instead of
  by patching it later.
- **Every control reads as operable.** The outgoing build shipped its most important action —
  the one that starts a run — as a 15%-opacity tint that read as disabled. Do not repeat it.

### Honest risk

Investigation framing can read as cold or bureaucratic, and instrument panels invite more
chrome than a working tool wants. Aim for a calibrated instrument, not a cockpit pastiche.
Skeuomorphic bevels, brushed-metal gradients and glowing edges are all failure modes here —
and the detector flags the last one as `dark-glow`.

---

## Colour and type

**Colour strategy: Restrained** — neutrals plus one accent. This is the Operate default and
the brief does not license anything bolder. Colour commits at page scale: fields that own
regions, not accents scattered over a neutral ground.

Dark or light is not a default. Write one sentence of physical scene before you choose: a QA
engineer at a desk, mid-afternoon, triaging a red suite before a release cutoff. Let that
force the answer rather than inheriting the incumbent's dark ground by habit.

**Type.** Operate surfaces are well served by workhorse UI faces and system stacks. These are
training-data defaults and naming one requires a reason no other face could satisfy — a
subject association is never that reason:

> Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, Space Grotesk,
> Space Mono, IBM Plex, Inter-as-display, DM Sans, DM Serif, Outfit, Plus Jakarta Sans,
> Instrument Sans

The outgoing build used `Inter var`. Choosing it again is choosing the default.

Tabular figures are non-negotiable — this surface is full of counts, durations and ratios
that must align in columns.

---

## Binding constraints — do not renegotiate these

- **Name is ProofWright.** The incumbent header says "Self-healing QA". Rename it, and the
  README with it.
- **Six verdict states must stay semantically distinct**: pass, pass-via-fallback (drift),
  repaired (healed), failed, needs review, skipped. A pass and a pass-via-fallback must never
  read as the same state. **The hues are yours to choose; the distinctions are not.**
- **WCAG 2.1 AA is a product requirement.** The product scores accessibility as a headline
  number; failing the standard it measures would discredit the measurement in front of the
  one audience most likely to check. Text at or above 4.5:1 on every surface it is used on, a
  visible keyboard focus indicator on every interactive element, no meaning by colour alone,
  no path reachable by mouse but not keyboard.
- **Never overstate what a run established.** A repair accepted on the model's word alone is
  marked unverified, prominently — not folded away.
- **Preserve product truth, content, function and behaviour.** This is a visual replacement,
  not a rewrite. Do not change an API call signature or payload shape.

---

## Invariants learned the hard way

Each of these is a defect that actually shipped in the outgoing build. Re-introducing one is
a regression, not a fresh choice. Full detail in `docs/DEVELOPMENT-LOG.md`.

- **Define every colour token you reference.** `--color-ink-600` was used in ~70 places and
  never defined, so Tailwind emitted no rule and all of it inherited the body colour —
  tertiary copy rendered at full primary brightness. Grep your own class usage against your
  `@theme` block before you trust a hierarchy.
- **Solve contrast, don't eyeball it.** Compute oklch → sRGB → WCAG for every text tier
  against every surface it lands on. Leave margin: ambient washes lighten the backdrop, so a
  ratio of exactly 4.5 measures below it in the browser.
- **Do not put text over `backdrop-filter`.** It makes contrast non-deterministic and every
  text node over it is flagged. Removing one blur took contrast findings from 36 to 1, and at
  92% opacity the blur was invisible anyway.
- **No coloured box-shadows.** A chromatic halo on a dark surface is the most reliable tell of
  a generated interface. Watch for animations that only render mid-run — a cyan pulse ring on
  the running step escaped every idle scan and would have appeared in the demo.
- **Content visible by default.** Scroll-reveal must not start at `opacity: 0`. 12 of 16
  sections were invisible until scrolled past, so a failed script hid the page and every
  full-page capture showed an empty document.
- **Minimum 12px for functional text.** No `text-[10px]`, `[10.5px]`, `[11px]` or `[11.5px]`.
- **Cap prose measure** at ~68ch. Unconstrained paragraphs ran past 200 characters per line.
- **Never use `sr-only` for a data table.** It clips the table to one pixel while its cells
  keep full-size bounding boxes, which produced 40 phantom occlusion findings. Disclose the
  data behind a `<details>` instead — a sighted user wanting the numbers behind a chart cannot
  reach an `sr-only` table either.
- **Give every table a distinct `aria-label`.** Three separate reviewers were misled by
  `querySelectorAll('tbody tr')` counting chart-data rows alongside run rows.
- **Keyboard parity.** The desktop table used `<tr onClick>` with no `tabIndex` while the
  mobile card used a real `<button>` — desktop was *less* accessible than mobile.
- **One source of truth per surface.** The Releases screen drifted between its desktop and
  mobile trees three times — the sequence rail, then the pivot marker twice. It only stopped
  when the two trees were collapsed into one responsive list.

---

## Build sequence

This is **code-led**: no image generation is available, so there is no comp round. That is not
a discount on commitment — the ambition lives in the FIRST VIEWPORT block and the named
signature interaction, and the finish reviewer audits both in behaviour.

1. Build the first viewport as a thesis, not a header. The finding stated in words comes
   before any count. Land it fully committed; later passes clarify, never dilute.
2. Rebuild every atom in the form's vocabulary — nav, buttons, inputs, links. A stock
   component inside a committed form is a lapse.
3. Then the remaining screens inside the same system: Releases (a seven-release deposition
   sequence), Plans (specifications with a revision table and sign-off block), History (the
   case index).
4. Motion once, orchestrated. Reduced motion removes movement, not meaning — keep the
   feedback that carries state.
5. Responsive: verify 390px and 1280–1600px, not only your working width.

**Verification, every time** — the outgoing build was repeatedly reported as verified when it
was not:

```bash
npm run web:build && npx tsc --noEmit && npm --prefix web run typecheck && npm test
```

The server **preloads the bundle at boot**, so a rebuild alone changes nothing — you must
restart it. Screenshot at both viewports and *open the images*; several conclusions in this
project were wrong because a probe measured the wrong elements and nobody looked.

Run the detector once when the build is finished, not during:

```bash
impeccable-detect http://127.0.0.1:7860/          # and /releases /plans /history
```

Exit 0 clean, 2 findings, 1 unscannable. Baseline for the outgoing build was 91 findings, 54
of them `ai-color-palette` from cyan-on-dark — that rule is the main thing this redesign
should clear.

---

## Two things not to do

- **Do not write `DESIGN.md`.** On a replacement world it is written *at finish*, from the
  built world, by the documenter. A rulebook written up front gets defended against reality
  instead of describing it.
- **Do not copy the direction contract into source** — not into comments, `data-*`
  attributes, hidden DOM, metadata or anything browser-delivered. Reviewers read it from the
  surface brief.

## Finish

Not optional, and it is what "done" means here: batched screenshot round at both viewports →
critique against the contract → fix in one batch → detector once → spawn the finish reviewer
fresh with the artifact, screenshots, contract and detector findings → act on its disposition
word (`ship`, `fix`, `rebuild`, `recapture`) → then the documenter writes `DESIGN.md`.

A clean detector pass is not finished. Finished is the contract kept, the review closed, and
the system recorded.
