import { z } from 'zod';
import { GEMINI_MODEL, GROQ_MODEL, LLM_PROVIDER } from '../config.js';
import { generateJson } from '../llm/generate.js';
import { supportsStrict } from '../llm/groq.js';

/**
 * One cheap structured call against the configured provider.
 *
 * Exists to answer "is the key working and is the schema being honoured" in a
 * couple of seconds and one request, rather than by starting a mission and finding
 * out at the plan stage. It also reports whether the chosen model constrains
 * decoding, which is the difference between the plan validator being a safety net
 * and being the only thing standing between a hallucinated action and a run.
 *
 *   npm run llm:check
 */
const probeSchema = z.object({
  ok: z.boolean(),
  /** A closed set, because an enum is the thing constrained decoding proves. */
  verdict: z.enum(['stale_test', 'broken_application', 'unclear']),
  reason: z.string(),
});

async function main(): Promise<void> {
  const model = LLM_PROVIDER === 'groq' ? GROQ_MODEL : GEMINI_MODEL;

  console.log(`provider   ${LLM_PROVIDER}`);
  console.log(`model      ${model}`);
  if (LLM_PROVIDER === 'groq') {
    const strict = supportsStrict(model);
    console.log(
      `decoding   ${strict ? 'constrained (strict: true)' : 'BEST-EFFORT — schema not guaranteed'}`,
    );
    if (!strict) {
      console.log(
        '           Set GROQ_MODEL to openai/gpt-oss-20b, openai/gpt-oss-120b or\n' +
          '           qwen/qwen3.8-27b to get a guarantee rather than an attempt.',
      );
    }
  } else {
    console.log('decoding   constrained (responseSchema)');
  }

  const startedAt = Date.now();
  const result = await generateJson({
    prompt:
      'A test clicked a button and the page then showed a 500 error. Classify whether the test is stale or the application is broken.',
    schema: probeSchema,
    systemInstruction: 'You classify test failures. Answer only in the given schema.',
  });
  const elapsed = Date.now() - startedAt;

  const parsed = probeSchema.safeParse(result.data);
  console.log(`latency    ${elapsed}ms (${result.attempts} attempt(s))`);
  console.log(`schema     ${parsed.success ? 'honoured' : `VIOLATED — ${parsed.error.message}`}`);
  if (parsed.success) {
    console.log(`answer     ${parsed.data.verdict} — ${parsed.data.reason.slice(0, 100)}`);
  }
  console.log(`\n${parsed.success ? 'Ready.' : 'Not ready: the model did not honour the schema.'}`);
  if (!parsed.success) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
