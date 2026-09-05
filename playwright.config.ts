import { defineConfig } from '@playwright/test';

/**
 * Runs the specs ProofWright emits.
 *
 * Deliberately minimal and deliberately not CI wiring — the problem statement puts
 * CI/CD integration out of scope. This exists so a team can execute the generated
 * suite themselves and see that it is real code rather than a rendering of it.
 */
export default defineConfig({
  testDir: './tests/generated',
  timeout: 30_000,
  reporter: [['list']],
  use: {
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  },
});
