import { approvePlan, listPlanSummaries, loadPlan, unapprovePlan } from '../store/plans.js';
import { parseArgs } from '../util/args.js';

// ---------------------------------------------------------------------------
//   npm run approve                          # list plans and their status
//   npm run approve -- --plan checkout-flow
//   npm run approve -- --plan checkout-flow --revoke
// ---------------------------------------------------------------------------

function main(): void {
  const { positionals, flags, options } = parseArgs();
  const planId = options.get('plan') ?? positionals[0];

  if (!planId) {
    const summaries = listPlanSummaries();
    if (summaries.length === 0) {
      console.log('No plans yet. Run: npm run plan -- "<test case in plain English>"');
      return;
    }
    console.log('Plans:\n');
    for (const summary of summaries) {
      const baseline = summary.hasBaseline ? 'baseline recorded' : 'no baseline';
      console.log(
        `  ${summary.status.padEnd(8)} ${summary.planId.padEnd(24)} ${summary.stepCount} steps, ${baseline}`,
      );
    }
    console.log('\nApprove one with: npm run approve -- --plan <planId>');
    return;
  }

  const existing = loadPlan(planId);
  if (!existing) throw new Error(`No plan "${planId}".`);

  if (flags.has('revoke')) {
    const updated = unapprovePlan(planId);
    console.log(`${planId} is now ${updated?.status}.`);
    console.log('Its baseline is untouched, but nothing new can be recorded until it is approved.');
    return;
  }

  if (existing.status === 'APPROVED') {
    console.log(`${planId} was already approved at ${existing.approvedAt}.`);
    return;
  }

  // Printed before approving so the thing being approved is on screen. An
  // approval nobody read is the failure mode this gate exists to prevent.
  console.log(`Plan        ${planId} — ${existing.plan.name}`);
  console.log(`Start URL   ${existing.plan.startUrl}`);
  console.log(`Steps       ${existing.plan.steps.length}\n`);
  for (const step of existing.plan.steps) {
    const target = step.target ? step.target.description : '(acts on the page)';
    const value = step.valueRef ? ` <- $${step.valueRef}` : step.value ? ` <- "${step.value}"` : '';
    console.log(`  ${step.id}  ${step.action.padEnd(8)} ${target}${value}`);
  }

  const updated = approvePlan(planId);
  console.log(`\n${planId} is now ${updated?.status}.`);
  console.log(`Record a baseline with: npm run baseline -- --plan ${planId}`);
}

try {
  main();
} catch (err: unknown) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
