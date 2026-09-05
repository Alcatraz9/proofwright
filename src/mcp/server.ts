/**
 * EdgeForge as an MCP server.
 *
 * The same capabilities the dashboard calls, exposed to any agent that speaks
 * Model Context Protocol — Claude Desktop, Cursor, Kiro, a custom host. The point
 * is that a developer never has to open this product to use it: they ask their own
 * agent to test an application and the agent drives the pipeline, reads the
 * verdict, and reports the reasoning back in the conversation it was already in.
 *
 * Nothing here knows what a mission is. It is a transport: JSON-RPC 2.0 over
 * stdio, translating `tools/call` into `invoke()` and a result back into MCP
 * content. Adding a capability to the registry publishes it here with no edit to
 * this file, which is the property that made the capability layer worth building.
 *
 * Implemented directly rather than on the official SDK, so `npm run mcp` works
 * with nothing installed beyond what the server already needs. The surface used is
 * small and stable: initialize, tools/list, tools/call.
 *
 * Usage, in an MCP client's config:
 *   { "command": "npx", "args": ["tsx", "src/mcp/server.ts"], "cwd": "<repo>" }
 */
import { createInterface } from 'node:readline';
import { invoke, toolManifest } from '../capability/registry.js';
import { CapabilityError } from '../capability/types.js';
import '../capability/missions.js';
import '../capability/reports.js';

const PROTOCOL_VERSION = '2024-11-05';

interface Request {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: Request['id'], value: unknown): void {
  write({ jsonrpc: '2.0', id, result: value });
}

function failure(id: Request['id'], code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(request: Request): Promise<void> {
  const { id, method, params = {} } = request;

  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'edgeforge',
          version: '0.1.0',
          /**
           * Read by an agent deciding whether to use this at all, so it states the
           * boundary rather than only the capability: EdgeForge will decline to
           * repair a failing application, and an agent should expect a verdict of
           * needs_review to mean exactly that.
           */
          description:
            'Autonomous test orchestration. Give it a URL and it plans, generates, executes and repairs a browser test suite end to end. It repairs tests broken by interface changes and refuses to repair tests failing because the application is wrong — those escalate instead.',
        },
      });
      return;

    // A notification: no id, and the protocol expects no reply.
    case 'notifications/initialized':
      return;

    case 'tools/list':
      result(id, { tools: toolManifest() });
      return;

    case 'tools/call': {
      const name = params['name'];
      if (typeof name !== 'string') {
        failure(id, -32602, 'tools/call requires a string "name".');
        return;
      }
      const args = (params['arguments'] ?? {}) as unknown;

      try {
        const value = await invoke(name, args);
        /**
         * Returned as pretty-printed JSON in a text block. MCP allows structured
         * content, but every client renders text, and an agent reads JSON perfectly
         * well — while a human watching the transcript can also see what came back.
         */
        result(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        });
      } catch (error) {
        /**
         * Reported as a tool error rather than a protocol error. The call itself
         * was well formed; the operation failed, and the agent should read the
         * message and decide what to do rather than treat the server as broken.
         */
        const text =
          error instanceof CapabilityError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        result(id, { content: [{ type: 'text', text }], isError: true });
      }
      return;
    }

    case 'ping':
      result(id, {});
      return;

    default:
      if (id === undefined || id === null) return; // unknown notification
      failure(id, -32601, `Unknown method "${method}".`);
  }
}

function main(): void {
  const lines = createInterface({ input: process.stdin });

  lines.on('line', (line) => {
    const text = line.trim();
    if (!text) return;

    let request: Request;
    try {
      request = JSON.parse(text) as Request;
    } catch {
      failure(null, -32700, 'Parse error.');
      return;
    }

    void handle(request).catch((error: unknown) => {
      failure(request.id ?? null, -32603, error instanceof Error ? error.message : String(error));
    });
  });

  lines.on('close', () => process.exit(0));
}

main();
