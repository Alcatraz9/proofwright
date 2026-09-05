---
name: ProofWright
description: Fault attribution for recorded suites
colors:
  plate-000: "oklch(0.205 0.004 250)"
  plate-100: "oklch(0.245 0.004 250)"
  plate-200: "oklch(0.285 0.005 250)"
  rule: "oklch(0.38 0.006 250)"
  rule-strong: "oklch(0.46 0.007 250)"
  read-100: "oklch(0.95 0.003 250)"
  read-200: "oklch(0.84 0.004 250)"
  read-300: "oklch(0.72 0.005 250)"
  signal: "oklch(0.8 0.14 78)"
  signal-ink: "oklch(0.86 0.11 80)"
  alarm: "oklch(0.72 0.17 25)"
  alarm-ink: "oklch(0.78 0.14 27)"
typography:
  readout:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontStretch: "112%"
    fontWeight: 500
    letterSpacing: "-0.005em"
  label-cut:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontStretch: "78%"
    fontWeight: 600
    fontSize: "12px"
    lineHeight: 1.35
    letterSpacing: "0.14em"
  body:
    fontFamily: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: 1.6
  mono-figures:
    fontFamily: "'Azeret Mono Variable', ui-monospace, monospace"
    fontFeature: "tnum 1, lnum 1"
    letterSpacing: "-0.01em"
rounded:
  plate: "2px"
spacing:
  panel-px: "16px"
  panel-py: "20px"
  gap-rule: "12px"
  section-gap: "16px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.plate-000}"
    rounded: "{rounded.plate}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.signal-ink}"
  button-default:
    backgroundColor: "{colors.plate-200}"
    textColor: "{colors.read-100}"
    rounded: "{rounded.plate}"
    padding: "8px 12px"
  button-danger:
    backgroundColor: "{colors.plate-200}"
    textColor: "{colors.alarm-ink}"
    rounded: "{rounded.plate}"
    padding: "8px 12px"
  button-ghost:
    textColor: "{colors.read-200}"
    rounded: "{rounded.plate}"
    padding: "8px 12px"
  button-disabled:
    backgroundColor: "{colors.plate-100}"
    textColor: "{colors.read-300}"
    rounded: "{rounded.plate}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.plate-000}"
    textColor: "{colors.read-100}"
    rounded: "{rounded.plate}"
    padding: "8px 10px"
  panel:
    backgroundColor: "{colors.plate-100}"
    rounded: "{rounded.plate}"
---

# Design System: ProofWright

## Overview

**Creative North Star: "The Incident Record"**

A fault-attribution readout built in the idiom of an aviation incident investigation: instrument-panel achromatics on a graphite ground, one signal accent that is always simultaneously a control, hairline rules instead of shadows, stencil-cut labels, and channel traces as the only drawn things on the surface. The interface asks one question of every failure — was the element not found, or was the result not what was recorded? — and states the answer in a sentence before anything else.

The surface is dark by design, not by default. The world is a calibrated instrument read under controlled lighting, not a dark-mode toggle of a light product. There is no light variant; the contrast ratios, the hairline rules, and the achromatic hierarchy are tuned to this specific ground. Every value in the palette was solved by a contrast script (`node web/scripts/contrast.mjs`) that computes oklch → linear sRGB → WCAG relative luminance for every text token against every surface it can land on.

Two chromatic tokens exist, both semantic. No colour on this surface is decorative, and there is deliberately no green: a passing step is quiet achromatic, because "nothing to see here" should not compete for attention with the one row that needs it.

**Key Characteristics:**
- Attribution before remedy — the finding is a sentence, not a count, and leads the page.
- Six verdict states separated on three non-colour channels (drawn mark, trace style, written label), with colour as a fourth that is never the only one.
- One accent (`signal`), simultaneously every interactive affordance and every caution cue.
- No shadows anywhere. Depth comes from rules and fill values.
- Self-hosted variable faces, not linked. No outbound font requests.
- All contrast ratios computed and gated, never eyeballed.

## Colors

The palette is three near-achromatic surfaces, three text tiers, two hairline separators, and exactly two chromatic tokens. Every value is authored in oklch and solved against every surface it can land on. Run `node web/scripts/contrast.mjs` before changing any token.

### Primary (Semantic chromatics)

- **Signal** (`oklch(0.8 0.14 78)`, #efb146): Caution, and simultaneously every interactive affordance — links, focus rings, active nav tabs, the primary button fill, disclosure controls, selected toggle state, decisive parameter markers, drift warnings, and the text selection colour (at 30% mix). Nothing on the surface carries this hue without either asking for action or being action. Worst case ratio: 7.56:1 on plate-200.
- **Signal Ink** (`oklch(0.86 0.11 80)`, #f7c97b): The hover and pressed state of signal elements, and the written label for accessibility testability findings. Slightly lighter and less saturated so hover reads as a response. Worst case ratio: 9.30:1 on plate-200.
- **Alarm** (`oklch(0.72 0.17 25)`, #fd736d): Reserved for exactly one meaning — the application is at fault. Failure marks, the failed-step trace colour, failure classifications, and the left edge of a fault-register finding block. Nothing else may borrow this hue. Worst case ratio: 5.37:1 on plate-200.
- **Alarm Ink** (`oklch(0.78 0.14 27)`, #ff9286): The text form of alarm — failure labels, error notes, danger button text. Worst case ratio: 6.63:1 on plate-200.

### Neutral (Surfaces and text)

Three surfaces, deliberately not four. A fourth raised fill forced the dimmest text tier to 4.00:1, and the only escapes were a hierarchy too fine to see or a promise about where a token lands that no component can keep.

- **Plate 000** (`oklch(0.205 0.004 250)`, #262829): The page ground, header background, scrollbar tracks, input fills, code block backgrounds.
- **Plate 100** (`oklch(0.245 0.004 250)`, #303233): Panel and card fills. One step up from the ground.
- **Plate 200** (`oklch(0.285 0.005 250)`, #3a3c3e): Raised interactive surfaces — default buttons, confidence bar backgrounds, scrollbar thumbs on hover. The highest fill in the system.

Three text tiers:

- **Read 100** (`oklch(0.95 0.003 250)`, #edeff0): Primary text — headings, panel titles, decisive parameter values, strong labels. Ratio: 15.48:1 / 14.02:1 / 12.40:1 against the three surfaces.
- **Read 200** (`oklch(0.84 0.004 250)`, #c8cbcd): Body and secondary — finding headlines, prose explanations, monospaced values, quiet-register labels. Ratio: 10.97:1 / 9.93:1 / 8.79:1.
- **Read 300** (`oklch(0.72 0.005 250)`, #a2a5a8): Tertiary — timestamps, hints, subordinate copy, label-cut text. Ratio: 7.22:1 / 6.54:1 / 5.79:1. Subordination is carried by width, case and tracking rather than by dimming toward the floor.

Two structural tokens (decorative separation, not gated):

- **Rule** (`oklch(0.38 0.006 250)`, #404345): Panel borders, row dividers, default trace colour, the standard hairline. Reported at 1.79 / 1.62 / 1.43 against surfaces — decorative, not a UI boundary.
- **Rule Strong** (`oklch(0.46 0.007 250)`, #55585c): Hover-state borders, disclosure traces, the outgoing trace on a passed step. Reported at 2.52 / 2.28 / 2.02.

### Named Rules

**The No Green Rule.** There is no green anywhere in the palette. A passing step is quiet achromatic. A wall of green pills is what this replaced, and a pass that screams for attention competes with the one row that needs it.

**The Signal Monopoly Rule.** Signal is the only warm chroma on the surface. It is simultaneously caution and interactive affordance — every coloured element either asks for action or is action. A second accent would break this, because it would introduce a colour that is not a control.

**The Alarm Reservation Rule.** Alarm is reserved for one meaning: the application is at fault. No warning, no caution, no "needs attention" state may borrow it. If it appears, the application broke.

## Typography

**Sans Face:** Archivo Variable (latin subset, 88KB, self-hosted, `woff2-variations`). Weight axis 100–900, width axis 62%–125%. The width axis is the structural device: condensed labels and normal-width readouts from a single file, without a second face or a second weight doing the work of a different shape.

**Mono Face:** Azeret Mono Variable (latin subset, 26KB, self-hosted, `woff2-variations`). Weight axis 400–600. Locators, counts, durations, ratios — anything that must align in a column or where `l` against `1` and `0` against `O` must be distinguishable.

**Character:** Dense instrument-panel typography where hierarchy comes from four different shapes rather than from dimming toward the floor. A label is subordinate to prose because it is condensed, tracked, and uppercased, not because it is lighter.

### Hierarchy — Four Reading Registers

- **Label-cut** (Archivo, 78% width, 600 weight, 12px, line-height 1.35, tracking 0.14em, uppercase, `read-300`): What a thing is called. Field names, chip labels, section headings, button text, status indicators. Condensed and tracked so it reads as subordinate to running prose at full contrast.
- **Readout** (Archivo, 112% width, 500 weight, size varies by context, tracking −0.005em, `text-wrap: balance`): The sentence that states a finding. Extended width carries weight across the full measure without needing size alone. Used for finding verdict words at `clamp(1.5rem, 3.4vw, 2.25rem)`, finding headlines at `clamp(0.9375rem, 1.5vw, 1.125rem)`, panel titles at 17px, and empty-state titles at 15px/19px.
- **Body** (Archivo, normal width, 13px, line-height ~1.6): Prose explanations, consequence paragraphs, hints. Capped at `max-width: 36em` (the `.measure` class), which lands at ~72 average characters at every size — `ch` was rejected because Archivo's zero glyph is 0.66em, making a `68ch` cap resolve to ~91 characters.
- **Mono-figures** (Azeret Mono, tabular-nums lining-nums, tracking −0.01em): Counts, durations, confidence scores, elapsed times, step IDs, locator strings. Two sub-registers: `.figures` applies tabular-nums to the sans face for inline numbers; `.mono-figures` switches to the mono face for columnar data.

### Named Rules

**The Shape-Not-Shade Rule.** Hierarchy comes from width, case, and tracking, not from dimming. The three text tiers are well separated (15.48 / 10.97 / 7.22 against the page), but subordination within a tier is carried by register shape. A condensed uppercase label at full contrast reads as lower than running prose without trading legibility for rank.

**The Minimum 12px Rule.** No functional text below 12px. The build shipped 10px, 10.5px and 11px text that were flagged; the floor is 12px for any text a reader is expected to read.

**The Measure Cap Rule.** Prose is capped at 36em (`max-width: 36em`), which holds ~72 average characters per line. Applied via the `.measure` class and is non-negotiable — unconstrained paragraphs previously ran past 200 characters.

## Layout

Single-column max-width container at `110rem` (1760px), with `px-4` (16px) padding below `sm` (640px) and `px-6` (24px) above. The header is sticky (`sticky top-0 z-30`), and the tab navigation is part of it.

Five screens behind a tab bar: Console (the finding readout), Missions (the autonomous pipeline readout), Releases (the fixture narrative), Plans (specifications with approval gate), History (the case index with hand-drawn SVG charts).

On Console, the finding block takes the full width — it previously shared a row with arming controls, leaving ~270px of empty plate. Below it, the step channel and analysis panels are side by side on wider viewports, stacked on mobile.

Spacing rhythm uses Tailwind's scale: `gap-2` (8px), `gap-3` (12px), `gap-4` (16px), `gap-5` (20px), `gap-6` (24px). Panel internal padding is `px-4 py-5` (→ `px-6` at `sm`). Section gaps within panels are `space-y-4` (16px). Rule-separated sections use `border-b border-rule` with consistent `py-3` / `py-3.5` vertical rhythm.

Responsive breakpoint is `sm` at 640px. Verified at 390px (mobile) and 1440px (desktop). The `clamp()` function on the verdict word scales `1.5rem → 2.25rem` across viewport width.

Keyboard navigation: `g c` / `g m` / `g r` / `g p` / `g h` chord shortcuts for screen switching, `Ctrl+Enter` to start a run, `Ctrl+.` to halt, `Ctrl+H` to toggle healing, `?` for the legend overlay. Skip-to-content link targets `#readout`.

## Elevation & Depth

Flat. No `box-shadow` anywhere in the system — not on panels, not on buttons, not on hover, not on the legend overlay. Depth is communicated entirely by fill value steps (plate-000 → plate-100 → plate-200) and hairline rules (`border border-rule`). A soft-shadowed rounded rectangle is the thing that stands in for content when there is none, and this surface has plenty.

The legend overlay uses `bg-plate-000/90` (90% opacity page ground) as a scrim. No blur — `backdrop-filter` was removed after it made contrast non-deterministic and produced 36 findings.

### Named Rules

**The No Shadow Rule.** Nothing on this surface has a box-shadow. Tonal layering and hairline rules do all the depth work. A coloured box-shadow — particularly a chromatic halo on a dark surface — is the most reliable tell of a generated interface.

**The No Blur Rule.** No `backdrop-filter: blur()`. At 92% opacity the blur was invisible, but it made every text node over it a contrast violation. Removing one blur took findings from 36 to 1.

## Shapes

Near-square. The system radius is `2px` (`--radius-plate`). Applied to panels, buttons, inputs, code blocks, the confidence bar, plates (evidence images), and the toggle track. Toggle knobs use `1px` radius.

No rounded corners beyond 2px. No pill shapes, no circular elements except the pending-state mark (a 1.25-unit-radius circle, which is a channel symbol, not a UI shape).

Borders are `1px solid` using `rule` or `rule-strong`. The finding block's left border is `2px` and coloured by register — this is the only structural use of a thicker rule, and it carries the attribution's register directly.

## Components

### Buttons

Four tones, each a visually distinct shape rather than a shade of the same one:

- **Primary:** Solid signal fill, plate-000 text, semibold label-cut. Reads unambiguously as a control — the previous build's 15%-opacity tint was read as disabled by every reviewer.
- **Default:** Plate-200 fill, rule-strong border, read-100 text. Hover lifts border to signal.
- **Danger:** Plate-200 fill, alarm/60 border, alarm-ink text. Hover lifts border to full alarm.
- **Ghost:** Transparent, read-200 text. Hover adds rule border and lifts text to read-100.
- **Disabled:** Plate-100 fill, rule border, read-300 text — a different shape from every enabled tone, not the same shape faded. `cursor-not-allowed`.

All buttons use label-cut register (condensed, tracked, uppercase), `rounded-plate` (2px), `px-3 py-2` (12px × 8px), and the shared focus ring.

### Focus Treatment

One focus ring everywhere: `outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-signal focus-visible:outline-offset-2` on `:focus-visible`. The `outline-solid` is load-bearing: Tailwind v4 compiles `outline-2` to `outline-style: var(--tw-outline-style)` and `outline-none` sets that variable to `none`, so both in the same class string resolve the style to `none` while the width and colour resolve correctly — no ring paints. Naming `outline-solid` under the same variant overrides the variable. Signal-coloured, offset so it clears the element's own border, visible on both plate values. Applied via the `focusRing` constant exported from `web/src/components/ui.tsx`. Measured after the fix: 89 focused controls across all five screens paint a ring, none without. Mouse clicks do not leave a ring; every keyboard arrival is unmistakable.

### Panels (Plates)

Rule-bordered plates on plate-100 fill. Header is rule-separated from body (not tinted), carrying a label-cut title at 17px readout weight, an optional subtitle in read-300, and optional right-hand instruments. No nesting of plates — the bezel pattern prevents it.

### Toggle (Switch)

A two-position switch with a square knob (4×4, 1px radius) on a square track. State is written out — "Armed" / "Off" — alongside the control, because position alone is the one cue a screen reader does not get. Active state: signal/25 fill with signal border and signal knob. Inactive: plate-000 fill with rule border and rule-strong knob.

### Inputs

Plate-000 fill, rule border, 13px read-100 text, read-300 placeholder. Hover lifts border to rule-strong. Focus adds signal border and the standard focus ring.

### Code (Locators)

Monospace text in a rule-bordered plate-000 inline block with `select-all` — the text is a selector and must be copyable. `px-1.5 py-0.5`, 12px, read-200.

### The Finding Block (Signature Component)

The first thing on the surface. A full-width rule-bordered plate-100 panel with a 2px left border coloured by register (quiet → rule-strong, stated → read-200, attention → signal, fault → alarm). Inside: the verdict word at display readout size with `attribute-settle` animation, the headline sentence below it, the consequence paragraph, and a parameter strip separated by a top rule. The decisive parameter is left-bordered in signal with a "Decided by —" prefix. Primary action sits with the finding, not in a header.

### The Step Channel (Signature Component)

A time-ordered readout, not a list. One trace runs the height of the run, and each step is a mark on it. Grid layout: `3.5rem` elapsed axis | `1.75rem` channel column | `minmax(0, 1fr)` readout. Four trace styles (solid, dashed, dotted, spliced) correspond to verdict states and are defined as CSS border styles on a zero-width absolute-positioned rule. The spliced trace (repair) is drawn as a doubled rule (3px wide, border on both sides) to be distinguishable without colour.

### The Heal Card (Signature Component)

The evidence record for a repair. Left-bordered (not boxed — a bordered box inside the channel plate would be a card inside a card). Contains: identity comparison (previous vs repaired locator with strategy labels), two plates (before/after element crops — the only saturated images on the surface), confidence bar with admission floor marker, quoted model reasoning, corroboration section, counter strip, and a revert button. Accepted repairs get rule-strong left border; refused ones get alarm.

### Icons (Authored SVG set)

All icons share one geometry: 16-unit viewBox, 1.5-unit stroke, square caps (`strokeLinecap: square`) and miter joins (`strokeLinejoin: miter`). Square terminals are deliberate — rounded strokes read as friendly signage, and this is a set of instrument marks. `currentColor` for both stroke and fill, `aria-hidden` and `focusable={false}`.

Seven channel terminus marks (pass, fallback, repaired, failed, review, skipped, pending) plus seven interface icons (close, disclose, external, retry, run, stop, deploy). The disclose chevron rotates rather than swapping to a second glyph.

### The Missions Surface (The Instrument Strip)

The autonomous pipeline readout. A mission takes a URL, and the orchestrator crawls the application, plans specifications, evaluates its own coverage, re-plans for what it missed, records, executes, heals, and reports — writing down what it decided at every stage boundary. The surface answers two questions in two registers without two trees: the strip says "is it alive and where is it", the exhibit says "what did it decide and what is missing".

#### Structure

A persistent band of four named channels sits above everything on a mission and stays put while the body beneath it changes. Below the strip, a rail of five exhibits: Decisions (the default), Coverage, Site map, Scenarios, Report. On wide viewports the exhibit selector is a left-hand rail with a signal left-border on the active item; on narrow viewports it becomes a scrolling row of the same buttons, reflowed, never duplicated.

The start form is a single-panel affair: one URL field is the whole minimum, with a disclosure control ("Narrow the scope") that reveals stated intent, requirements, test credentials, and a supervised-mode checkbox. The mission index below it lists missions newest-first as linked rows with status chip, target URL, stage, decision count, coverage reading.

#### The Channel Vocabulary

Each channel is a stencil-cut label over a tabular figure, separated from its neighbours by a hairline rule and nothing else — deliberately not a metric card. A channel with no reading yet says `NoReading` ("No reading", "Not started", "Not scored") in `read-300` rather than showing a zero, because zero is a measurement and "not yet" is not. Four channels on every mission:

- **Stage** — which of the six pipeline stages the orchestrator is in (`explore → plan → evaluate_coverage → generate → execute → report`), with a note on whether the mission is autonomous or supervised. Uses `attention` register while live, `stated` when finished.
- **Elapsed** — wall-clock duration from creation, ticking live via a 1-second interval while the mission runs. `mono-figures`.
- **Coverage** — the latest coverage reading (from `coverageRounds`) while running, or the final report score when finished. Shows the round number while live and "final" when complete. `stated` register when a reading exists, `dim` otherwise.
- **Decisions** — the count, plus a breakdown of notable outcomes (`N escalated · N retried · N failed`). "All routine" when there is nothing to call out.

While live, the most recent decision is carried beneath the strip in full — action and reason — so the reasoning is never demoted to a drill-down.

#### The Five Exhibits

1. **Decisions** — the default, and the default for a reason: the reasoning is the product's argument for itself. An ordered transcript of every stage-boundary decision, filterable by outcome. Outcome filters are square-cornered `label-cut` buttons at the 2px plate radius, with counts visible on each; a count of zero renders disabled rather than vanishing, because an absent filter reads as an absent outcome. Each decision row carries: stage name (8.5rem fixed-width `label-cut`), outcome chip (mark + label), duration in `mono-figures`, timestamp right-aligned, then the action as a `readout` headline and the reason as `measure`-capped body prose.

2. **Coverage** — the climb across re-plan rounds, drawn as a `CoverageTrace`: an ordered list where each round carries its score, the delta from the previous round, the gap count, a measured rule whose width is the score percentage (drawn because a recorded trace is the one thing this world draws), a breakdown of refusal/forms/pages coverage, and a sentence on what the orchestrator did next (`replanned`, `nothing_fillable`, `budget_spent`, `replan_failed`). Below the trace, the final coverage section from the report, with gaps grouped by kind.

3. **Site map** — the crawl record. Pages listed in visit order with depth, title, auth status, element count, destructive actions (recorded and never operated, stated with a signal left-border), blind spots, and disclosed forms. Forms show field names with `required` in signal, input types in `mono-figures`, and untestable-here notes. Budget summary (pages visited / allowed, depth limit, elapsed) above the page list.

4. **Scenarios** — the plan-level readout. Each scenario carries its name as a `readout` headline, a `ScenarioVerdictChip`, kind label, step count, intent, outcome, the verdict's own meaning as a note, and a `Code` block for the emitted spec file. Below the scenarios: emitted specifications section and repairs section listing each heal action with its locator change, verification status, and cache provenance.

5. **Report** — the score, its parts, and its caveats. The weighted overall score at 38px `figures` weight, with each part (functional, coverage) as a rule-separated instrument showing score, weight, and note. Caveats appear in the same section, always drawn, as signal-left-bordered items. An empty caveats array renders as an explicit statement that none were recorded. Below: outcomes summary, stated requirements comparison (if supplied), and provenance.

#### Mission Status Vocabulary

Seven statuses, each separated on three channels (mark, label, register):

- **Queued** (`dim`, `MarkPending`): waiting for the single run slot.
- **In flight** (`stated`, `MarkPending`): working; quiet stretches are normal.
- **Pass** (`quiet`, `MarkPass`): every scenario ran and held.
- **Failed** (`fault`, `MarkFailed`): a scenario could not complete.
- **Held for review** (`attention`, `MarkReview`): something rests on judgement.
- **Cancelled** (`dim`, `MarkSkipped`): halted before finishing.
- **Orchestrator fault** (`fault`, `MarkFailed`): the pipeline itself stopped; nothing was established about the application.

#### Decision Outcome Vocabulary

Five outcomes:

- **Ok** (`quiet`): the stage did what it set out to do.
- **Skipped** (`dim`): deliberately not done, with grounds stated.
- **Retried** (`attention`): the orchestrator went round again for gaps it found itself.
- **Escalated** (`attention`): handed to a person rather than guessed at. Refusing to decide is the point.
- **Failed** (`fault`): the stage could not complete.

#### Gap Kind Vocabulary

Four kinds, grouped so the non-actionable kind does not read as a backlog:

- **Untested flow** (`attention`): a page or form no plan touches.
- **Untested boundary** (`attention`): a boundary the form invites and no plan tries.
- **Untested refusal** (`attention`): a refusal path nothing exercises.
- **Not testable here** (`dim`): a fact, not a work item — no submit control, or past the crawl budget. Written as "Not testable here" in the dim register.

#### Scenario Verdict Vocabulary

Five verdicts reusing the same channel system as step states:

- **Pass** (`quiet`): every step ran and held.
- **Failed** (`fault`): a step could not complete and no repair satisfied it.
- **Held for review** (`attention`): ran, but something rests on judgement.
- **No baseline** (`dim`, `MarkSkipped`): no executable baseline was produced. This is not a failure of the application.
- **Runner fault** (`fault`): the harness failed; nothing was established.

#### Three Honesty Rules

These are structural, not advisory — the surface is shaped as it is because of them:

1. **The Caveat Bond Rule.** `quality.overall` never renders without `quality.caveats`. An empty caveats array renders as an explicit statement that none were recorded — "No caveats were recorded for this score. That is the report stating it found nothing to qualify — not an omission, and not the same as a score with no caveats because nobody looked." Silence would read as "nothing to declare", which is a claim the report has not made.

2. **The Not-Run Distinction Rule.** A scenario with verdict `not_run` is neither a pass nor a failure. It means no executable baseline was produced, which is a statement about the tool and not a finding about the application. It sits in the `dim` register with the `MarkSkipped` mark. Rendering it in the fault register would accuse the application of something the report explicitly does not claim.

3. **The Unexplored Fact Rule.** Gaps of kind `unexplored` are facts, not work items — a form with no submit control, a page past the crawl budget. Written as "Not testable here" in the `dim` register so they do not read as a backlog. Recorded rather than dropped, because an absent gap reads as an absent problem.

## Do's and Don'ts

### Do:

- **Do** solve contrast computationally before trusting a hierarchy. Run `node web/scripts/contrast.mjs` after any palette change. A ratio you have not computed is a ratio you do not have.
- **Do** define every colour token you reference. Grep class usage against the `@theme` block — an undefined token inherits body colour and renders at full primary brightness without warning.
- **Do** keep content visible by default. Scroll-reveal animations transition `translateY` only, never `opacity: 0`. A failed observer must leave the page readable.
- **Do** use `<details>` for progressive disclosure of per-page data. A sighted user wanting the numbers behind a chart cannot reach an `sr-only` table either.
- **Do** give every table and landmark a distinct `aria-label`. Three separate reviewers were misled by undifferentiated `querySelectorAll('tbody tr')`.
- **Do** use the `.measure` class (36em / ~72ch) on every prose block. Unconstrained paragraphs ran past 200 characters per line.
- **Do** keep one responsive tree per screen. The Releases screen drifted between its desktop and mobile trees three times before collapsing them into one responsive list.
- **Do** verify at both 390px and 1440px and open the screenshots. Several conclusions in this project were wrong because a probe measured the wrong elements and nobody looked.

### Don't:

- **Don't** add a fourth surface. Three surfaces and three text tiers are the maximum the palette supports while keeping the dimmest tier well above 4.5:1 on every surface.
- **Don't** add a green token. Passing is quiet achromatic, and the absence of green is the point.
- **Don't** put text over `backdrop-filter`. It makes contrast non-deterministic. Removing one blur took findings from 36 to 1.
- **Don't** use coloured `box-shadow`. A chromatic halo on a dark surface is the most reliable signature of a generated interface. A cyan pulse ring on the running step escaped every idle scan and appeared in the demo.
- **Don't** use `sr-only` for data tables. It clips the table to one pixel while its cells keep full-size bounding boxes, producing phantom occlusion findings. Disclose with `<details>` instead.
- **Don't** start scroll-reveal at `opacity: 0`. Twelve of sixteen sections were invisible until scrolled past, so a failed script hid the page and every full-page capture showed an empty document.
- **Don't** use `<tr onClick>` without `tabIndex` and keyboard handling. The desktop table was less accessible than mobile because mobile used a real `<button>`.
- **Don't** set text below 12px. The detector flagged 10px, 10.5px, 11px and 11.5px text in the outgoing build.
- **Don't** use Inter. The face was replaced; re-introducing it returns the surface to its previous default.
- **Don't** use text-glyph icons (`✕`, `+`, `−`). They inherit the face's weight and metrics, cannot hold a stroke weight against the authored SVG set, and land in the accessibility tree as characters.
