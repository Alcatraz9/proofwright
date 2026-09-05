import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Everything mutable lives under one root so a host can mount it, or lose it,
 * as a single unit. Hugging Face Spaces gives a writable but ephemeral
 * filesystem on the free tier, so `DATA_DIR` is overridable and the store seeds
 * itself on a cold start rather than assuming the last run's data survived.
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

export const PATHS = {
  /** Screenshots and visual diffs stay on disk; only their paths go in the db. */
  artifacts: path.join(DATA_DIR, 'artifacts'),
  db: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'qa.db'),
} as const;

/**
 * Read-only seed data committed to the repo, deliberately resolved against ROOT
 * rather than DATA_DIR.
 *
 * These are two different things that were the same directory back when the
 * prototype was CLI-only. The seed is source — it ships in the image and never
 * changes at runtime. DATA_DIR is state, and on a host that gives it a mounted
 * volume, resolving the seed there would look in an empty directory and find
 * nothing to seed from, which is exactly the cold start seeding exists for.
 */
export const SEED_PATHS = {
  plans: path.join(ROOT, 'data', 'plans'),
  baselines: path.join(ROOT, 'data', 'baselines'),
  /**
   * Screenshots and cached heal proposals that ship with the repo.
   *
   * A hosted container's filesystem is ephemeral, so a restart is a cold start: the
   * database and every captured artifact are gone. Seeding the plan and baseline was
   * already enough to make the first click a passing replay — but not enough to make
   * the first *heal* complete, because the heal card's "before" image is captured at
   * record time and would be missing, and the proposal cache would be empty so the
   * repair would spend a model call against a daily quota.
   */
  artifacts: path.join(ROOT, 'data', 'seed-artifacts'),
  healCache: path.join(ROOT, 'data', 'seed-heal-cache.json'),
} as const;

/**
 * Default model.
 *
 * Not the newest available, deliberately. Free-tier quota is per model per day,
 * and `gemini-3.7-flash` allows twenty generate-content requests in a day —
 * enough to develop against and not enough to demonstrate with. That ceiling is
 * invisible until it is hit, at which point healing simply stops working and the
 * error arrives inside a run. `npm run models` reports the ceilings.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

/**
 * Groq's default. `openai/gpt-oss-20b` is chosen for one reason: it is on the short
 * list whose structured output is *constrained* rather than best-effort, and this
 * pipeline's first guarantee is that the model cannot emit an unknown action.
 * Changing this to a model outside that list silently downgrades that guarantee.
 */
export const GROQ_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b';

/**
 * Which provider answers.
 *
 * Inferred from whichever key is present when unset, because the failure this
 * prevents is a correct GROQ_API_KEY sitting beside a provider still pointing at
 * Gemini — which presents as a quota error naming a model nobody chose.
 */
export const LLM_PROVIDER: 'gemini' | 'groq' = (() => {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === 'groq' || explicit === 'gemini') return explicit;
  if (process.env.GROQ_API_KEY) return 'groq';
  return 'gemini';
})();

export function requireGroqApiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw new Error('GROQ_API_KEY is not set. Add it to .env, or set LLM_PROVIDER=gemini.');
  }
  return key;
}

/**
 * Binds to loopback by default so a dev machine does not expose the runner to
 * its network. The container sets HOST=0.0.0.0 explicitly, which is required
 * there and safe because the container's own boundary is the exposed surface.
 */
export const SERVER = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 7860),
} as const;

/**
 * One run at a time by default. Each run drives a real Chromium across two
 * viewports, so on a small free-tier box a second concurrent run is the
 * difference between a slow demo and an OOM-killed container.
 */
export const RUN_CONCURRENCY = Math.max(1, Number(process.env.RUN_CONCURRENCY ?? 1));

/**
 * Where a run reaches the bundled app under test.
 *
 * Always loopback, never the public URL. The browser runs inside this same
 * process's container, so going out through the hosting proxy and back would add
 * TLS and a round trip to every navigation for no benefit — and on Hugging Face
 * the public origin is not even knowable from inside the container without
 * trusting a forwarded header. The public URL matters only to a human opening
 * /app/v2 to look at it.
 */
export const INTERNAL_ORIGIN = `http://127.0.0.1:${SERVER.port}`;

export function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set. Copy env.example to .env and add your key.');
  }
  return key;
}

/**
 * Resolves a plan's `valueRef` (e.g. "TEST_EMAIL") to a real value at execution time.
 * Secrets live only in the environment; a stored plan holds the name, never the value.
 */
export function resolveValueRef(ref: string): string {
  const value = process.env[ref];
  if (value === undefined) {
    throw new Error(`Plan references ${ref} but it is not set in the environment.`);
  }
  return value;
}

/**
 * The login the crawler uses to get past an authentication wall.
 *
 * Lives here because this module is the one that loads `.env`, and a caller that
 * read `process.env` directly would see nothing unless it happened to import
 * something that reached this file — which is exactly how the first authenticated
 * crawl silently skipped its own login step.
 */
export function testCredentials(): { identity?: string; secret?: string } {
  return {
    identity: process.env.TEST_EMAIL ?? process.env.TEST_USERNAME,
    secret: process.env.TEST_PASSWORD,
  };
}
