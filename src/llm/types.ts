import type { z } from 'zod';

/**
 * The contract both providers implement.
 *
 * Extracted so a call site cannot tell which model answered it. The three callers
 * — plan generation, locator resolution, heal proposal — each want the same thing:
 * JSON in a known shape, or a thrown error. Nothing above this line should know
 * whether that came from Gemini or Groq, and nothing below it should know what the
 * JSON is for.
 */
export interface GenerateJsonOptions {
  prompt: string;
  schema: z.ZodType;
  systemInstruction?: string;
  model?: string;
  /** Low by default: this is extraction, not creative writing. */
  temperature?: number;
}

export interface GenerateJsonResult {
  data: unknown;
  raw: string;
  /** Which model actually answered, recorded on plans and heal attempts. */
  model: string;
  /** How many attempts it took. >1 means the service was transiently unavailable. */
  attempts: number;
}

export type LlmProvider = 'gemini' | 'groq';
