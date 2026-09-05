import { extractPage, REF_ATTRIBUTE } from '../browser/extract.js';
import { executeAction, settle } from '../browser/execute.js';
import { toFingerprint } from '../browser/fingerprint.js';
import { buildLocator, describeLocator, resolveLocators } from '../browser/locator.js';
import { launchBrowser, newPage } from '../browser/session.js';
import { deriveOutcome } from '../baseline/outcome.js';
import { VisualRecorder } from '../baseline/visual.js';
import { baselineShotPath, captureElementShot } from '../browser/screenshot.js';
import type { Baseline, BaselineStep } from '../baseline/types.js';
import { saveBaseline } from '../store/baselines.js';
import { approvePlan, loadPlan, savePlan } from '../store/plans.js';
import { intentPlanSchema, type IntentPlan } from '../intent/types.js';
import { PATHS, SEED_PATHS } from '../config.js';
import { parseArgs } from '../util/args.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Records a baseline without a model in the loop.
 *
 *   npm run seed:fixture -- --base http://127.0.0.1:7860
 *
 * The normal recorder asks a model which element on the page satisfies a step's
 * semantic target. That is the right design for a test written in English about
 * an app nobody has described. It is the wrong tool for the fixture, whose
 * markup we wrote: here the target is known exactly, so it is named directly and
 * the model is not consulted at all.
 *
 * Everything downstream of the match is the real pipeline — the same locator
 * derivation, the same uniqueness verification against the live page, the same
 * outcome observation. So the baseline this produces is not a mock; it is what
 * the recorder would have produced had the model matched correctly.
 *
 * This exists so a cold start has a demoable, committed baseline that costs no
 * API quota, and so the replay path can be exercised without a key at all.
 */

interface Recipe {
  stepId: string;
  intent: string;
  sourcePhrase: string;
  action: BaselineStep['action'];
  /** CSS selector naming the exact element, used only to pick it out of the page. */
  select: string | null;
  value?: string;
  valueRef?: string;
  targetDescription: string | null;
  targetContext: string | null;
}

const PLAN_ID = 'fixture-checkout';

const INSTRUCTION =
  'Log in with my test account, search the catalogue, open the first product, ' +
  'add it to the basket, proceed to checkout, and confirm the order total is shown.';

const RECIPES: Recipe[] = [
  {
    stepId: 'fill-email',
    intent: 'Type the test account email into the email field',
    sourcePhrase: 'Log in with my test account',
    action: 'fill',
    select: '[data-testid="login-email"]',
    valueRef: 'TEST_EMAIL',
    targetDescription: 'email input field',
    targetContext: 'login form',
  },
  {
    stepId: 'fill-password',
    intent: 'Type the test account password into the password field',
    sourcePhrase: 'Log in with my test account',
    action: 'fill',
    select: '[data-testid="login-password"]',
    valueRef: 'TEST_PASSWORD',
    targetDescription: 'password input field',
    targetContext: 'login form',
  },
  {
    stepId: 'submit-login',
    intent: 'Submit the login form',
    sourcePhrase: 'Log in with my test account',
    action: 'click',
    select: '[data-testid="login-submit"]',
    targetDescription: 'sign in button',
    targetContext: 'login form',
  },
  {
    stepId: 'fill-search',
    intent: 'Type a search term into the catalogue search field',
    sourcePhrase: 'search the catalogue',
    action: 'fill',
    select: 'input[type="search"]',
    value: 'cable',
    targetDescription: 'catalogue search field',
    targetContext: 'catalogue',
  },
  {
    stepId: 'click-search',
    intent: 'Press the search button to run the search',
    sourcePhrase: 'search the catalogue',
    action: 'click',
    // The icon-only search button. In the legacy release it has no accessible
    // name and no text, so the only locator available is its id — and the
    // accessibility remediation replaces it with a named semantic button and
    // drops that id. This one step is the accessibility-fix-breaks-a-test case.
    select: '.searchbar button',
    targetDescription: 'search button',
    targetContext: 'catalogue',
  },
  {
    stepId: 'open-product',
    intent: 'Open the first product in the catalogue',
    sourcePhrase: 'open the first product',
    action: 'click',
    select: '[data-product="ns-1001"] a.button',
    targetDescription: 'view button on the first product',
    targetContext: 'product grid',
  },
  {
    stepId: 'add-to-basket',
    intent: 'Add the product to the basket',
    sourcePhrase: 'add it to the basket',
    action: 'click',
    // No test id, by design: this is the control v2 renames, so the step has to
    // rely on its role and text and therefore genuinely goes stale.
    select: 'form[action$="/cart"] button',
    targetDescription: 'add to cart button',
    targetContext: 'product detail',
  },
  {
    stepId: 'go-to-checkout',
    intent: 'Proceed from the basket to checkout',
    sourcePhrase: 'proceed to checkout',
    action: 'click',
    // Also deliberately test-id-free. v2 renames this to "Continue to Payment",
    // which breaks the role locator and the text fallback together — the heal
    // this whole demo turns on.
    select: 'a.button[href$="/checkout"]',
    targetDescription: 'checkout link',
    targetContext: 'basket',
  },
  {
    stepId: 'assert-total',
    intent: 'Confirm the order total is displayed',
    sourcePhrase: 'confirm the order total is shown',
    action: 'assert',
    // The amount beside the inert "Total" label. Its locator resolves through
    // labelledBy, so its identity comes from the label and not from its own
    // digits — a price change then fails an assertion that named the price and
    // passes one that did not, instead of looking like a missing element.
    select: 'dd[id$="total"]',
    targetDescription: 'order total amount',
    targetContext: 'order summary',
  },
];

function buildPlan(startUrl: string): IntentPlan {
  return intentPlanSchema.parse({
    name: 'Fixture checkout flow',
    description:
      'Signs in, opens the first product, adds it to the basket, reaches checkout and ' +
      'checks that a total is displayed.',
    startUrl,
    requiredValueRefs: ['TEST_EMAIL', 'TEST_PASSWORD'],
    steps: RECIPES.map((recipe) => ({
      id: recipe.stepId,
      intent: recipe.intent,
      sourcePhrase: recipe.sourcePhrase,
      action: recipe.action,
      target: recipe.targetDescription
        ? { description: recipe.targetDescription, context: recipe.targetContext }
        : null,
      value: recipe.value ?? null,
      valueRef: recipe.valueRef ?? null,
      // Null on purpose: the instruction says a total is *shown*, not what it
      // reads. Recording the figure here would turn every price change into a
      // failure the tester never asked for.
      expectedValue: null,
      expectedOutcome: null,
    })),
  });
}

async function main(): Promise<void> {
  const { options, flags } = parseArgs();
  const base = (options.get('base') ?? 'http://127.0.0.1:7860').replace(/\/$/, '');
  const startUrl = `${base}/app/`;
  const headed = flags.has('headed');

  const email = process.env.TEST_EMAIL || 'demo@example.com';
  const password = process.env.TEST_PASSWORD || 'demo-password';
  // Set for this process so the fill steps resolve, without requiring a .env for
  // what is a fixed, non-secret fixture credential.
  process.env.TEST_EMAIL = email;
  process.env.TEST_PASSWORD = password;

  console.log(`Recording against ${startUrl}`);

  const plan = buildPlan(startUrl);
  savePlan({
    plan,
    model: 'none (fixture recipe)',
    targetUrl: startUrl,
    instruction: INSTRUCTION,
    planId: PLAN_ID,
  });
  approvePlan(PLAN_ID);

  const browser = await launchBrowser({ headed });
  const steps: BaselineStep[] = [];
  const visual = new VisualRecorder();

  try {
    const page = await newPage(browser);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await visual.captureIfNew(page);

    for (const recipe of RECIPES) {
      const urlBefore = page.url();

      // Extraction stamps every element it saw with a ref attribute, so the
      // snapshot has to be taken before the named element can be looked up.
      const before = await extractPage(page);

      // The named element must be one the extractor actually saw. If it is not,
      // the recipe and the fixture have drifted apart and the baseline would be
      // quietly wrong, so this stops rather than guessing.
      const ref = recipe.select
        ? await page
            .locator(recipe.select)
            .first()
            .getAttribute(REF_ATTRIBUTE)
            .catch(() => null)
        : null;

      if (recipe.select && !ref) {
        throw new Error(
          `Step ${recipe.stepId}: "${recipe.select}" did not match an extracted element on ${urlBefore}.`,
        );
      }

      const element = ref ? before.elements.find((e) => e.ref === ref) : undefined;
      if (recipe.select && !element) {
        throw new Error(`Step ${recipe.stepId}: element ${ref} was not in the page snapshot.`);
      }

      const resolved = element ? await resolveLocators(page, element) : null;
      if (element && !resolved) {
        throw new Error(
          `Step ${recipe.stepId}: no locator uniquely selects the target on ${urlBefore}. ` +
            'The fixture needs a test id or a distinguishable accessible name here.',
        );
      }

      const stepLocator = resolved?.primary ?? null;
      const value = recipe.valueRef ? (process.env[recipe.valueRef] ?? null) : (recipe.value ?? null);

      // Captured before the step executes, while the element is still there and
      // still in its pre-action state. This is the "before" half of the pair shown
      // when a heal later replaces it.
      if (stepLocator) {
        await captureElementShot({
          page,
          locator: buildLocator(page, stepLocator),
          relPath: baselineShotPath(PLAN_ID, recipe.stepId),
        });
      }

      // Executing the step is how the recorder reaches the next page, which is
      // why resolution is per-step: step N's page does not exist until N-1 ran.
      await executeAction({
        page,
        action: recipe.action,
        locator: stepLocator ? buildLocator(page, stepLocator) : null,
        value,
      });
      await settle(page);

      // After the step, because executing it is how the recorder reaches the next
      // page — and the next page is the one that needs recording.
      const captured = await visual.captureIfNew(page);
      if (captured) {
        console.log(
          `  ${' '.repeat(18)} visual: recorded ${captured[0]?.pagePath} at ${captured.map((c) => `${c.viewport}(${c.elementCount})`).join(', ')}`,
        );
      }

      const after = await extractPage(page);
      const outcome = await deriveOutcome({
        page,
        action: recipe.action,
        stepLocator,
        // Null on purpose: the instruction asked that a total be shown, not what
        // it reads. Recording the figure would turn a price change into a failure
        // nobody asked for.
        expectedValue: null,
        intended: recipe.intent,
        urlBefore,
        urlAfter: page.url(),
        before,
        after,
      });

      steps.push({
        stepId: recipe.stepId,
        intent: recipe.intent,
        action: recipe.action,
        value: recipe.valueRef ? null : (recipe.value ?? null),
        valueRef: recipe.valueRef ?? null,
        pageUrl: urlBefore,
        locator: stepLocator,
        fallbackLocators: resolved?.fallbacks ?? [],
        fingerprint: element ? toFingerprint(element) : null,
        expectedOutcome: outcome,
        resolution: { confidence: 1, reason: 'Named directly by the fixture recipe.' },
        healHistory: [],
      });

      console.log(
        `  ${recipe.stepId.padEnd(18)} ${recipe.action.padEnd(7)} ${
          stepLocator ? describeLocator(stepLocator) : '(page-level)'
        }${resolved && resolved.fallbacks.length > 0 ? `  +${resolved.fallbacks.length} fallback` : ''}`,
      );
      for (const assertion of outcome.assertions) {
        console.log(
          `  ${' '.repeat(18)} assert: ${assertion.type}${assertion.value ? ` "${assertion.value}"` : ''}`,
        );
      }
      if (outcome.assertions.length === 0) {
        console.log(`  ${' '.repeat(18)} assert: none — nothing observable changed`);
      }
    }
  } finally {
    await browser.close();
  }

  const baseline: Baseline = {
    baselineId: `${PLAN_ID}-${Date.now()}`,
    planId: PLAN_ID,
    createdAt: new Date().toISOString(),
    model: 'none (fixture recipe)',
    startUrl,
    steps,
    visualBaselines: visual.signatures,
  };

  saveBaseline(baseline);
  const stored = loadPlan(PLAN_ID);
  console.log(`\nRecorded ${steps.length} steps for ${PLAN_ID} (plan is ${stored?.status}).`);

  // Writing the pair into the repo's read-only seed directory is what makes a
  // cold start demoable. The recorded origin does not need to match wherever
  // this is deployed — a baseline is rebased onto the running app when it is
  // replayed — so a file recorded on a laptop port is portable.
  if (flags.has('export')) {
    await fs.mkdir(SEED_PATHS.plans, { recursive: true });
    await fs.mkdir(SEED_PATHS.baselines, { recursive: true });

    const planFile = path.join(SEED_PATHS.plans, `${PLAN_ID}.json`);
    const baselineFile = path.join(SEED_PATHS.baselines, `${PLAN_ID}.json`);
    await fs.writeFile(planFile, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    await fs.writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');

    // The screenshots go with them. A committed baseline whose "before" images are
    // absent produces a half-empty heal card on any fresh deployment.
    const shotsFrom = path.join(PATHS.artifacts, 'baselines', PLAN_ID);
    const shotsTo = path.join(SEED_PATHS.artifacts, 'baselines', PLAN_ID);
    let copied = 0;
    try {
      await fs.mkdir(shotsTo, { recursive: true });
      for (const name of await fs.readdir(shotsFrom)) {
        if (!name.endsWith('.png')) continue;
        await fs.copyFile(path.join(shotsFrom, name), path.join(shotsTo, name));
        copied += 1;
      }
    } catch {
      /* no shots captured */
    }

    console.log(`Exported seed data:\n  ${planFile}\n  ${baselineFile}`);
    console.log(`  ${copied} screenshot(s) -> ${shotsTo}`);
    console.log('Run `npm run export:cache` after a heal to commit the proposal cache too.');
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
