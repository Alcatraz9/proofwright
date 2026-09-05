import { SarvamAIClient, SarvamAIError } from 'sarvamai';
import type { SarvamAI } from 'sarvamai';
import {
  SARVAM_MODEL,
  SARVAM_REASONING_EFFORT,
  requireSarvamApiKey,
} from '../config.js';
import { toStrictJsonSchema } from './json-schema.js';
import type { GenerateJsonOptions, GenerateJsonResult } from './types.js';
import { recordUsage } from './usage.js';

/**
 * Sarvam, over the official SDK.
 *
 * Unlike the Groq client — which is hand-written against `fetch` because its
 * surface here is one POST — this one takes the dependency, and the deciding
 * factor is the retry policy rather than the ergonomics. The SDK retries 408, 429
 * and every 5xx while honouring `Retry-After` in both its seconds and HTTP-date
 * forms, falls back to `X-RateLimit-Reset`, and only then to exponential backoff
 * with jitter capped at sixty seconds. That is strictly better than the loop this
 * file used to carry, and the ceiling that matters on a starter tier is 40
 * requests a minute — a window a correct backoff waits out and a naive one
 * exhausts four attempts inside three seconds.
 *
 * Why this is the default provider. The other two are each unusable in one
 * direction: Gemini's free tier allows twenty generate-content requests *per day*
 * on 2.5-flash and a single nine-step mission spends ten to fifteen of them, and
 * Groq caps a request at 8,000 tokens — which a requirements document plus a site
 * map exceeds outright, with a 413 no retry can help.
 *
 * The property that had to survive the switch is constrained decoding. The plan
 * pipeline's first layer of constraint is that the model *cannot* emit the wrong
 * shape or an unknown action; a provider offering only best-effort JSON would
 * quietly demote that to a validation error caught a call later. Sarvam documents
 * `strict: true` as a guarantee rather than an attempt, and unlike Groq it holds
 * on every chat model rather than a short list — but `strict` is optional on the
 * wire and defaults to false, so it is passed explicitly below and its absence
 * would be silent.
 */

let client: SarvamAIClient | undefined;

function getClient(): SarvamAIClient {
  /**
   * `requireSarvamApiKey` rather than the SDK's own env lookup, which reads the
   * same `SARVAM_API_KEY`. Ours fails at the point of use with a message naming
   * the file to put it in and the two providers to fall back to; the SDK's names
   * a constructor argument the caller cannot see from here.
   */
  client ??= new SarvamAIClient({
    apiSubscriptionKey: requireSarvamApiKey(),
    maxRetries: 3,
  });
  return client;
}

/**
 * Every chat model Sarvam serves constrains decoding when asked to, so this is a
 * constant rather than the allow-list the Groq client needs. It stays a function
 * so `llm:check` can report decoding mode without knowing which provider answered.
 */
export function supportsStrict(_model: string): boolean {
  return true;
}

/**
 * A 400 is normally final — a malformed request fails identically forever, and the
 * SDK does not retry one. A complaint that the *sample* did not satisfy the schema
 * is different: that is a property of the sample rather than of the request, and
 * the next one usually satisfies it.
 *
 * Resampled once, not repeatedly. If two samples in a row cannot satisfy the
 * schema, the model is the wrong size for the prompt and asking again will not
 * change that.
 */
const SCHEMA_REJECTION = /json_validate_failed|does not match the expected schema/i;
const MAX_ATTEMPTS = 2;

function isSchemaRejection(error: unknown): boolean {
  if (!(error instanceof SarvamAIError) || error.statusCode !== 400) return false;
  return SCHEMA_REJECTION.test(`${error.message} ${JSON.stringify(error.body ?? '')}`);
}

/**
 * `attempts` counts *our* resamples, not the SDK's transport retries, which it
 * handles internally and does not report. A value above one therefore means the
 * model produced a sample its own schema rejected — not that the service was
 * briefly unavailable.
 */
export async function generateJsonWithSarvam({
  prompt,
  schema,
  systemInstruction,
  model = SARVAM_MODEL,
  temperature = 0.1,
}: GenerateJsonOptions): Promise<GenerateJsonResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await getClient().chat.completions({
        /**
         * Cast because the SDK types `model` as a closed union of what Sarvam
         * offered when it was generated, while `SARVAM_MODEL` is an environment
         * variable. Pinning the config to the union would mean an SDK bump before
         * anyone could point at a model Sarvam shipped that morning, and the API
         * is the authority on what it accepts — an unknown id comes back as a 400
         * naming it, which is a clearer failure than a compile error here.
         */
        model: model as SarvamAI.SarvamModelIds,
        temperature,
        /**
         * Set explicitly, because the wire default is 2,048 and a nine-step plan
         * exceeds that once the model has spent anything on reasoning first.
         */
        max_tokens: 8192,
        /**
         * Low by default: every call here is extraction against a schema that
         * already encodes the shape of the answer, and reasoning tokens come out
         * of the same completion budget as the JSON. Raise it via
         * `SARVAM_REASONING_EFFORT` if plan quality on a long PRD warrants it.
         */
        reasoning_effort: SARVAM_REASONING_EFFORT,
        messages: [
          ...(systemInstruction ? [{ role: 'system' as const, content: systemInstruction }] : []),
          { role: 'user' as const, content: prompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            // Optional on the wire and defaulted to false; omitting it is a silent
            // downgrade from a guarantee to an attempt.
            strict: true,
            schema: toStrictJsonSchema(schema),
          },
        },
      });

      if (response.usage) recordUsage(response.usage);

      const choice = response.choices[0];
      if (!choice) throw new Error('Sarvam returned no choices.');

      /**
       * Both checked before the parse, because both produce text that fails to
       * parse for a reason the parse error will not name. `length` means the
       * completion budget ran out mid-JSON — raise `max_tokens` or lower
       * `SARVAM_REASONING_EFFORT`, not something a retry fixes. A refusal is the
       * model declining, which arrives in its own field rather than as content.
       */
      if (choice.message.refusal) {
        throw new Error(`Sarvam refused the request: ${choice.message.refusal}`);
      }
      if (choice.finish_reason === 'length') {
        throw new Error(
          'Sarvam truncated its response at max_tokens before finishing the JSON. ' +
            'Lower SARVAM_REASONING_EFFORT, or shorten the prompt.',
        );
      }

      // Reasoning arrives in `reasoning_content`, so `content` is the JSON alone —
      // no scratchpad to strip, which a raw chat-completions endpoint cannot promise.
      const text = choice.message.content;
      if (!text) throw new Error('Sarvam returned an empty response.');

      try {
        return { data: JSON.parse(text) as unknown, raw: text, model, attempts: attempt };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Not resampled: under constrained decoding, output that will not parse is
        // a structural problem another identical call reproduces.
        throw new Error(`Sarvam returned unparseable JSON: ${message}\n${text.slice(0, 500)}`);
      }
    } catch (err) {
      lastError = err;
      // Everything transient was already retried inside the SDK, so the only thing
      // left worth another call is a sample the schema rejected.
      if (!isSchemaRejection(err) || attempt === MAX_ATTEMPTS) throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
