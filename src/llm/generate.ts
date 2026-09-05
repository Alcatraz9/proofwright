import { LLM_PROVIDER } from '../config.js';
import { generateJson as generateWithGemini } from './gemini.js';
import { generateJsonWithGroq } from './groq.js';
import { generateJsonWithSarvam } from './sarvam.js';
import type { GenerateJsonOptions, GenerateJsonResult } from './types.js';

export type { GenerateJsonOptions, GenerateJsonResult } from './types.js';

/**
 * One structured-output call, against whichever provider is configured.
 *
 * The three callers do not choose. A locator resolution and a heal proposal want
 * JSON in a known shape from whatever model this deployment has a key for, and
 * making that a per-call decision would spread provider knowledge across the
 * codebase for no gain.
 *
 * Selection is by `LLM_PROVIDER`, defaulting to whichever key is present, because
 * the common failure here is a correct key and a provider left pointing elsewhere.
 */
export async function generateJson(options: GenerateJsonOptions): Promise<GenerateJsonResult> {
  switch (LLM_PROVIDER) {
    case 'groq':
      return generateJsonWithGroq(options);
    case 'gemini':
      return generateWithGemini(options);
    default:
      return generateJsonWithSarvam(options);
  }
}
