import type { Baseline } from './types.js';

/**
 * Rewrites a baseline's recorded origins onto wherever the app under test is now.
 *
 * Every step records the URL it was recorded on, and the replay refuses to act
 * when the browser is somewhere else — which is what stops an expired session
 * from being healed into pointing at a login form. That check compares origins,
 * so a baseline recorded at `http://127.0.0.1:7860` fails every step the moment
 * it is replayed anywhere else.
 *
 * That makes committed seed data unusable as soon as it is deployed. Hugging Face
 * serves the container at `https://<space>.hf.space` — a different scheme, a
 * different host and no port at all — so a baseline recorded on a laptop would
 * arrive and report that every page had diverged.
 *
 * Rebasing is not a workaround for that. "The application moved" is a real
 * condition — a staging host, a preview deployment, a different port — and it is
 * genuinely distinct from "the application navigated somewhere unexpected", which
 * is what the divergence check is for. Only the origin is replaced; every path is
 * left exactly as recorded, so a step that expected `/app/checkout` still expects
 * it and a real divergence is still caught.
 */
export function rebaseBaseline(baseline: Baseline, targetOrigin: string): Baseline {
  let origin: string;
  try {
    origin = new URL(targetOrigin).origin;
  } catch {
    // An unusable target is left alone rather than corrupting every URL in the
    // baseline. The replay will then fail honestly against the recorded origin.
    return baseline;
  }

  const rebase = (recorded: string): string => {
    try {
      const url = new URL(recorded);
      if (url.origin === origin) return recorded;
      return `${origin}${url.pathname}${url.search}${url.hash}`;
    } catch {
      return recorded;
    }
  };

  return {
    ...baseline,
    startUrl: rebase(baseline.startUrl),
    steps: baseline.steps.map((step) => ({
      ...step,
      pageUrl: rebase(step.pageUrl),
      // A navigate step's value is the URL it goes to, so it has to move as well
      // or the run would be sent back to the host it was recorded against.
      value: step.action === 'navigate' && step.value ? rebase(step.value) : step.value,
      expectedOutcome: {
        ...step.expectedOutcome,
        assertions: step.expectedOutcome.assertions.map((assertion) =>
          // urlContains holds a path fragment rather than a whole URL, so it is
          // origin-independent already and must not be touched.
          assertion.type === 'urlContains' && assertion.value?.startsWith('http')
            ? { ...assertion, value: rebase(assertion.value) }
            : assertion,
        ),
      },
    })),
  };
}

/** True when any recorded origin differs from the target. */
export function needsRebase(baseline: Baseline, targetOrigin: string): boolean {
  try {
    const origin = new URL(targetOrigin).origin;
    if (new URL(baseline.startUrl).origin !== origin) return true;
    return baseline.steps.some((step) => {
      try {
        return new URL(step.pageUrl).origin !== origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
