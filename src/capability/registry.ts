import { z } from 'zod';
import { toToolInputSchema } from '../llm/json-schema.js';
import { CapabilityError, type Capability } from './types.js';

const registry = new Map<string, Capability<never, unknown>>();

export function register<I, O>(capability: Capability<I, O>): Capability<I, O> {
  if (registry.has(capability.name)) {
    throw new Error(`Capability "${capability.name}" is already registered.`);
  }
  registry.set(capability.name, capability as unknown as Capability<never, unknown>);
  return capability;
}

export function capabilities(): Capability<never, unknown>[] {
  return [...registry.values()];
}

export function lookup(name: string): Capability<never, unknown> | undefined {
  return registry.get(name);
}

/**
 * Validate, call, validate.
 *
 * Both adapters come through here so neither can skip a check the other
 * performs. Input is parsed before the handler sees it, which is what lets the
 * handlers take typed arguments and stop defending against malformed ones.
 *
 * The output parse looks redundant — we wrote the handler, after all — but it is
 * what makes the advertised JSON Schema trustworthy. An agent that was told a
 * field exists should not discover otherwise at runtime, and the failure surfaces
 * here in development rather than in front of a caller.
 */
export async function invoke(name: string, rawInput: unknown): Promise<unknown> {
  const capability = lookup(name);
  if (!capability) {
    throw new CapabilityError(404, `No capability "${name}".`);
  }

  const parsedInput = capability.input.safeParse(rawInput ?? {});
  if (!parsedInput.success) {
    throw new CapabilityError(400, formatIssues(parsedInput.error));
  }

  const result = await capability.handler(parsedInput.data as never);

  const parsedOutput = capability.output.safeParse(result);
  if (!parsedOutput.success) {
    throw new Error(
      `Capability "${name}" returned a value that does not match its own output schema: ${formatIssues(
        parsedOutput.error,
      )}`,
    );
  }
  return parsedOutput.data;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * The catalogue an MCP client receives from `tools/list`.
 *
 * `kind` is folded into the description rather than sent as a separate field,
 * because MCP has nowhere to put it and an agent that does not know a call
 * returns before the work finishes will poll the wrong thing — or worse, report
 * a mission as complete because the call that started it succeeded.
 */
export function toolManifest(): {
  name: string;
  description: string;
  inputSchema: unknown;
}[] {
  return capabilities().map((capability) => ({
    name: capability.name,
    description:
      capability.kind === 'long_running'
        ? `${capability.description}\n\nReturns immediately with a handle; the work continues in the background. Poll for completion rather than assuming this call finished it.`
        : capability.description,
    inputSchema: toToolInputSchema(capability.input),
  }));
}
