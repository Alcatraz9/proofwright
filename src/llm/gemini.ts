import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { GEMINI_MODEL, requireApiKey } from '../config.js';
import { toGeminiSchema } from './json-schema.js';
import type { GenerateJsonOptions, GenerateJsonResult } from './types.js';

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: requireApiKey() });
  return client;
}

// Shared with the Sarvam and Groq clients, so a caller cannot tell which one answered.
export type { GenerateJsonOptions, GenerateJsonResult } from './types.js';

/**
 * HTTP statuses worth trying again.
 *
 * 503 is the one that matters in practice. A free-tier model returns "this model
 * is currently experiencing high demand" under load, and a single attempt makes
 * healing a coin flip — a real run lost its repair to one 503 and reported a
 * stale locator as an unfixed failure, which was the honest outcome but not a
 * useful one.
 *
 * 429 is rate limiting and 500/502/504 are gateway noise. A 400 or 403 is not
 * retried: a malformed request or a bad key will fail identically forever, and
 * retrying it just delays the error.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function retryableStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  // The SDK surfaces the API's JSON error body in the message.
  const match = /"code"\s*:\s*(\d{3})/.exec(message) ?? /\b(429|500|502|503|504)\b/.exec(message);
  const status = match ? Number(match[1]) : null;
  if (status === null || !RETRYABLE_STATUS.has(status)) return null;

  // A per-day quota is not transient, and retrying it wastes four attempts and
  // several seconds to arrive at the identical error. The distinction is in the
  // body: a daily ceiling names a PerDay quota id, where a burst limit does not.
  if (status === 429 && /PerDay|per day|generate_content_free_tier_requests/i.test(message)) {
    return null;
  }
  return status;
}

const MAX_ATTEMPTS = 4;

/**
 * One structured-output call, retried on transient unavailability.
 *
 * `responseSchema` constrains decoding, so the reply is always syntactically
 * valid JSON in the right shape. Semantic validation (zod parse + the per-action
 * rules) still happens on our side afterwards — the schema constrains form, not
 * meaning.
 */
export async function generateJson({
  prompt,
  schema,
  systemInstruction,
  model = GEMINI_MODEL,
  temperature = 0.1,
}: GenerateJsonOptions): Promise<GenerateJsonResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await getClient().models.generateContent({
        model,
        contents: prompt,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          temperature,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
        },
      });

      const text = response.text;
      if (!text) throw new Error('Gemini returned an empty response.');

      try {
        return { data: JSON.parse(text) as unknown, raw: text, model, attempts: attempt };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Not retried: the schema constrains decoding, so unparseable output is a
        // structural problem that another identical call will reproduce.
        throw new Error(`Gemini returned unparseable JSON: ${message}\n${text.slice(0, 500)}`);
      }
    } catch (err) {
      lastError = err;
      const status = retryableStatus(err);
      if (status === null || attempt === MAX_ATTEMPTS) throw err;

      // Exponential with jitter. Jitter matters because a run heals several steps
      // in quick succession, and identical backoff would send every retry into
      // the same congested moment.
      const delay = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
