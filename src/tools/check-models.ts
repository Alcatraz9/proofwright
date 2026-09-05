import { GoogleGenAI } from '@google/genai';
import { requireApiKey } from '../config.js';

/**
 * Probes which models the key can reach, and what their free-tier ceiling is.
 *
 *   npm run models
 *
 * Worth a tool of its own because free-tier quota is per model, per day, and it
 * is the constraint most likely to break a live demonstration. `gemini-3.7-flash`
 * allows twenty generate-content requests a day — enough to build with and not
 * enough to demonstrate with, and the error only says so once the ceiling is
 * already hit. Knowing the number in advance is the difference between choosing a
 * model and discovering one.
 *
 * Each probe costs one request against the model it probes, so this is not
 * something to run in a loop.
 */

const CANDIDATES = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-3.7-flash',
];

async function main(): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: requireApiKey() });

  console.log('model                     status  detail');
  for (const model of CANDIDATES) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: 'Reply with the JSON {"ok":true} and nothing else.',
        config: { temperature: 0, responseMimeType: 'application/json' },
      });
      console.log(`${model.padEnd(25)} ok      ${(response.text ?? '').trim().slice(0, 40)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = /"code"\s*:\s*(\d+)/.exec(message)?.[1] ?? '?';
      const limit = /limit:\s*(\d+)/.exec(message)?.[1];
      const retry = /retryDelay"\s*:\s*"([^"]+)"/.exec(message)?.[1];
      const reason = /"status"\s*:\s*"([A-Z_]+)"/.exec(message)?.[1] ?? '';
      console.log(
        `${model.padEnd(25)} ${code.padEnd(7)} ${reason}${limit ? ` dailyLimit=${limit}` : ''}${
          retry ? ` retryAfter=${retry}` : ''
        }`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
