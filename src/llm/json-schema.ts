import { z } from 'zod';

/** Keys Gemini's schema dialect rejects or ignores; stripped recursively. */
const UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'title',
  'default',
  'const',
  'examples',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

type JsonSchema = Record<string, unknown>;

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== 'object') return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    out[key] = key === 'enum' ? value : sanitize(value);
  }

  // Gemini honours `propertyOrdering` to keep generated fields in a stable order,
  // which measurably improves structured-output quality. Zod emits properties in
  // declaration order, so we just mirror that.
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.propertyOrdering = Object.keys(out.properties as JsonSchema);
  }

  return out;
}

/**
 * Converts a zod schema into the OpenAPI-3.0-flavoured schema Gemini expects.
 *
 * Targeting `openapi-3.0` is deliberate: it emits `nullable: true` rather than
 * `type: [..., "null"]`, and inlines reused subschemas rather than emitting
 * `$defs`/`$ref` — both of which Gemini's dialect wants.
 */
export function toGeminiSchema(schema: z.ZodType): JsonSchema {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'output',
    reused: 'inline',
  });
  return sanitize(jsonSchema) as JsonSchema;
}

/**
 * The same schema, described for a caller supplying arguments rather than for a
 * model emitting a result.
 *
 * `io: 'input'` is the whole point. Under `'output'` a field carrying `.default()`
 * is always present once parsing finishes, so it is reported as required — which
 * is true of the parsed value and false of the call. An agent reading that manifest
 * concludes it must pass `mode` to start a mission, and the one argument that
 * genuinely matters stops looking special.
 *
 * Emitted as standard JSON Schema rather than Gemini's dialect: MCP clients read
 * plain JSON Schema, and `default` is worth keeping here, since a caller deciding
 * whether to pass an argument benefits from seeing what happens if it does not.
 */
export function toToolInputSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'inline',
  }) as JsonSchema;
}

/**
 * The same schema under the rules Groq's constrained decoding imposes.
 *
 * Nearly the inverse of `toGeminiSchema`, which is why it is a separate function
 * rather than a flag: Gemini's dialect rejects `additionalProperties` and this one
 * requires it on every object, set to false. Strict mode also requires every
 * property to appear in `required` — an omitted property is not "optional" to a
 * constrained decoder, it is a schema it refuses to compile.
 *
 * That sounds lossy and is not. Zod's `.nullable()` already emits a union with
 * null, which is how strict mode expresses an absent value, and the plan schema
 * uses nullable rather than optional throughout — `target: null` for a step that
 * acts on nothing, `value: null` for one that types nothing. So every field can be
 * required and still say "there is nothing here", which is what the schema meant
 * in the first place.
 *
 * `reused: 'inline'` keeps `$ref` out of it. Groq supports `$defs`, but inlining
 * removes a whole class of cross-provider difference for a schema this small.
 *
 * Constraint keywords are removed, and that is a design decision rather than a
 * workaround. Strict mode constrains *shape* by decoding, but validates bounds
 * like `minItems` and `minLength` after the fact and answers a violation with a
 * 400. That trades a repairable failure for an unrepairable one: the plan
 * generator already re-parses with zod and feeds rule violations back to the model
 * for another attempt, so a plan with too few steps becomes a second attempt with
 * a specific complaint. The same plan sent with `minItems` in the provider schema
 * becomes an HTTP error carrying nothing the pipeline can act on.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    reused: 'inline',
  }) as JsonSchema;
  return tighten(jsonSchema) as JsonSchema;
}

/**
 * Bounds the decoder cannot enforce, so it enforces them by rejecting the answer.
 * Kept out of the wire schema and left to zod, which can explain itself.
 */
const POST_HOC_CONSTRAINTS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'default',
  '$schema',
]);

/** Closes every object and marks every one of its properties required. */
function tighten(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tighten);
  if (node === null || typeof node !== 'object') return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (POST_HOC_CONSTRAINTS.has(key)) continue;
    out[key] = key === 'enum' ? value : tighten(value);
  }

  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as JsonSchema);
  }
  return out;
}
