import type { z } from 'zod';
import { GROQ_MODEL, requireGroqApiKey } from '../config.js';
import { toStrictJsonSchema } from './json-schema.js';
import type { GenerateJsonOptions, GenerateJsonResult } from './types.js';
import { recordUsage } from './usage.js';

/**
 * Groq, over its OpenAI-compatible endpoint.
 *
 * Written against `fetch` rather than the SDK deliberately: the surface used here
 * is one POST, and a dependency that exists to wrap one POST is a dependency to
 * install, audit, and keep current on a machine where `npm install` is the slowest
 * thing in the loop.
 *
 * Why this provider exists at all: the Gemini free tier allows twenty
 * generate-content requests **per day** on 2.5-flash, and a single nine-step
 * mission spends ten to fifteen of them — one plan call plus one locator
 * resolution per step. That is one mission a day, which is not a budget you can
 * develop against, let alone demo on. Groq's free tier is roughly thirty requests
 * a minute and fourteen thousand a day.
 *
 * The property that had to survive the switch is constrained decoding. The plan
 * pipeline's first layer of constraint is that the model *cannot* emit the wrong
 * shape or an unknown action, and a provider offering only best-effort JSON would
 * quietly demote that to a validation error caught later. Groq's `strict: true`
 * is constrained decoding, so the guarantee is the same — but it is available on
 * a limited set of models, so `STRICT_CAPABLE` below is a real constraint on which
 * model this may run.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_ATTEMPTS = 4;

/**
 * Ceiling on an honoured `retry-after`. A minute-long window is worth waiting out;
 * a daily quota is not, and a mission that blocks for an hour is indistinguishable
 * from one that hung.
 */
const MAX_RETRY_WAIT_MS = 70_000;

/**
 * Models whose structured output is constrained rather than best-effort.
 *
 * On anything else Groq accepts the schema and *tries* to honour it, which is a
 * different contract: it can return valid JSON of the wrong shape, or 400 on a
 * schema it could not satisfy. The plan validator would catch it, but the run
 * would have spent a call to learn something the decoder could have guaranteed.
 */
const STRICT_CAPABLE = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
]);

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * A 400 is normally final — a malformed request fails identically forever. One kind
 * is not: `json_validate_failed` means the model produced JSON its own schema
 * rejects, and that is a property of the sample rather than of the request. A
 * smaller model does it intermittently on a schema with nullable unions, and the
 * next sample usually satisfies it.
 *
 * Retried once, not four times. If two samples in a row cannot satisfy the schema,
 * the model is the wrong size for the prompt and waiting will not change that.
 */
const SCHEMA_REJECTION = /json_validate_failed|does not match the expected schema/i;
const MAX_SCHEMA_RETRIES = 1;

/**
 * Recovers a usable object from a schema-rejected generation, or `null`.
 *
 * Only the one malformation seen in the wild is repaired: the expected object
 * wrapped in a single-element array. Anything else — truncation, a genuinely
 * wrong shape, several objects — is not guessable and goes back to a resample.
 */
export function rescueFailedGeneration(body: string | undefined): unknown {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { failed_generation?: string } };
    const generation = parsed.error?.failed_generation;
    if (!generation) return null;
    const data = JSON.parse(generation) as unknown;
    if (Array.isArray(data) && data.length === 1 && typeof data[0] === 'object' && data[0] !== null) {
      return data[0];
    }
    return null;
  } catch {
    return null;
  }
}

export function supportsStrict(model: string): boolean {
  return STRICT_CAPABLE.has(model);
}

export async function generateJsonWithGroq({
  prompt,
  schema,
  systemInstruction,
  model = GROQ_MODEL,
  temperature = 0.1,
}: GenerateJsonOptions): Promise<GenerateJsonResult> {
  const apiKey = requireGroqApiKey();
  const strict = supportsStrict(model);
  let lastError: unknown;
  let schemaRetries = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature,
          /**
           * Set explicitly, because `gpt-oss` spends completion tokens on a
           * reasoning channel before it writes any JSON — a nine-step plan
           * measured over a thousand tokens for a one-line prompt. Truncation
           * under constrained decoding surfaces as `json_validate_failed` with an
           * empty `failed_generation`, which reads like a schema fault and is not.
           */
          max_completion_tokens: 8192,
          messages: [
            ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
            { role: 'user', content: prompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'response',
              strict,
              schema: toStrictJsonSchema(schema),
            },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error(
          `Groq returned ${response.status}: ${body.slice(0, 400) || response.statusText}`,
        );
        (error as Error & { status?: number; retryAfterMs?: number; body?: string }).status =
          response.status;
        // The full body, because a schema rejection carries `failed_generation` —
        // the model's actual output — and the truncated message loses it.
        (error as Error & { body?: string }).body = body;
        /**
         * Groq says how long to wait, and on a tokens-per-minute limit that is the
         * only number worth acting on. The window is a minute; exponential backoff
         * from 400ms retries four times inside three seconds, exhausts its attempts
         * while the limit is still in force, and reports a rate limit as a failed
         * recording. Locator resolution sends the page's element inventory per step,
         * so a four-step plan reaches TPM well before it reaches a request limit.
         */
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          if (Number.isFinite(seconds)) {
            (error as Error & { retryAfterMs?: number }).retryAfterMs = Math.min(
              seconds * 1000 + 500,
              MAX_RETRY_WAIT_MS,
            );
          }
        }
        throw error;
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      if (payload.usage) recordUsage(payload.usage);
      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new Error('Groq returned an empty response.');

      try {
        return { data: JSON.parse(text) as unknown, raw: text, model, attempts: attempt };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Not retried under strict mode, where the decoder cannot produce this; on a
        // best-effort model it can, and the message says which situation you are in.
        throw new Error(
          `Groq returned unparseable JSON${strict ? '' : ' (model is best-effort, not strict)'}: ${message}\n${text.slice(0, 500)}`,
        );
      }
    } catch (err) {
      lastError = err;
      const typed = err as Error & { status?: number; retryAfterMs?: number };
      const status = typed.status;

      if (status === 400 && SCHEMA_REJECTION.test(typed.message)) {
        /**
         * Before resampling, read what the model actually produced. Groq's 400
         * carries `failed_generation`, and the commonest rejection observed live
         * is the right object wrapped in a one-element array — `[{plan…}]` where
         * `{plan…}` was asked for. That is an envelope mistake, not a content
         * one, and unwrapping it recovers the sample that was already paid for.
         * The caller's Zod parse remains the real gate: a rescue that does not
         * satisfy it fails exactly as it would have.
         */
        const rescued = rescueFailedGeneration((typed as Error & { body?: string }).body);
        if (rescued !== null) {
          return { data: rescued, raw: JSON.stringify(rescued), model, attempts: attempt };
        }

        if (schemaRetries >= MAX_SCHEMA_RETRIES) throw err;
        schemaRetries += 1;
        /**
         * Heated on purpose. At near-zero temperature under constrained decoding
         * the second sample is close to a replay of the first — the OrangeHRM
         * plan failed twice with the identical array wrapper. A resample only
         * helps if it can differ.
         */
        temperature = Math.max(temperature, 0.7);
        continue; // resample immediately; there is nothing to wait for
      }

      if (status === undefined || !RETRYABLE.has(status) || attempt === MAX_ATTEMPTS) throw err;

      // The server's own figure when it gave one; otherwise exponential with
      // jitter, because a run heals several steps in quick succession and identical
      // backoff would send every retry into the same congested moment.
      const delay =
        typed.retryAfterMs ?? 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
