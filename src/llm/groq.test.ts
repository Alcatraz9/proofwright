import assert from 'node:assert/strict';
import test from 'node:test';
import { rescueFailedGeneration } from './groq.js';

/** The live failure: the expected object wrapped in a one-element array. */
const groq400 = (failedGeneration: string) =>
  JSON.stringify({
    error: {
      message:
        "Generated JSON does not match the expected schema. Please adjust your prompt. See 'failed_generation' for more details.",
      type: 'invalid_request_error',
      code: 'json_validate_failed',
      failed_generation: failedGeneration,
    },
  });

test('unwraps the expected object from a one-element array', () => {
  const plan = { name: 'Primary Journey Test', steps: [{ id: 'step-1' }] };
  const rescued = rescueFailedGeneration(groq400(JSON.stringify([plan])));
  assert.deepEqual(rescued, plan);
});

test('refuses an array with several elements — not guessable', () => {
  assert.equal(rescueFailedGeneration(groq400(JSON.stringify([{ a: 1 }, { b: 2 }]))), null);
});

test('refuses a bare non-object generation', () => {
  assert.equal(rescueFailedGeneration(groq400(JSON.stringify('just a string'))), null);
  assert.equal(rescueFailedGeneration(groq400(JSON.stringify([42]))), null);
});

test('refuses a truncated (unparseable) generation', () => {
  assert.equal(rescueFailedGeneration(groq400('[\n{"name":"Primary Jour')), null);
});

test('handles a missing or empty body', () => {
  assert.equal(rescueFailedGeneration(undefined), null);
  assert.equal(rescueFailedGeneration(''), null);
  assert.equal(rescueFailedGeneration('not json at all'), null);
});
