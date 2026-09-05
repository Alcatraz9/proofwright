import type { z } from 'zod';

/**
 * One thing the product can do, described once.
 *
 * The point of this layer is that there is exactly one definition of each
 * capability and every caller is an adapter over it. The HTTP router, the MCP
 * server, and the CLI do not each get to decide what "start a mission" means or
 * which fields it takes — they translate a transport into a call and a result
 * back into a transport.
 *
 * Two consequences worth stating, because they are the reason for the shape:
 *
 *   1. `input` and `output` are Zod schemas rather than TypeScript types alone.
 *      A type disappears at runtime; MCP needs to hand an agent a JSON Schema
 *      describing the arguments, and the repo already converts Zod to JSON
 *      Schema for the model's structured output (`llm/json-schema.ts`). The
 *      same converter serves both, so a capability cannot drift from its
 *      advertised contract.
 *
 *   2. `description` is not a comment. An agent calling this over MCP has
 *      nothing else to go on: it reads the description and decides whether this
 *      is the tool for the job. A vague one produces wrong calls, so these are
 *      written for a reader who cannot see the code.
 */
export interface Capability<I = unknown, O = unknown> {
  /** Tool name as an agent sees it. snake_case, stable — renaming breaks callers. */
  name: string;

  /** Short human label for menus and docs. */
  title: string;

  /**
   * What this does, when to reach for it, and what it returns. Written for an
   * agent with no other context.
   */
  description: string;

  input: z.ZodType<I>;
  output: z.ZodType<O>;

  /**
   * How the caller should expect it to behave.
   *
   *   read          — cheap, no side effects, safe to poll.
   *   write         — changes state, returns when done.
   *   long_running  — starts work and returns a handle immediately. MCP is
   *                   request/response and a mission takes minutes, so anything
   *                   slower than a few seconds must be start-then-poll rather
   *                   than a call that blocks until it finishes.
   */
  kind: 'read' | 'write' | 'long_running';

  /**
   * Where the REST adapter mounts it. `:param` segments bind by name and are
   * merged into the parsed input, so one handler serves `/missions/:missionId`
   * and the MCP argument `{ missionId }` without knowing which arrived.
   */
  http: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
  };

  handler: (input: I) => Promise<O> | O;
}

/** Thrown by a handler to select an HTTP status rather than a generic 500. */
export class CapabilityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export function notFound(message: string): CapabilityError {
  return new CapabilityError(404, message);
}

export function badRequest(message: string): CapabilityError {
  return new CapabilityError(400, message);
}

export function conflict(message: string): CapabilityError {
  return new CapabilityError(409, message);
}
