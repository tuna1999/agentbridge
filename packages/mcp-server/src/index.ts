/**
 * @agentbridge/mcp-server stdio entry point. Spec: 01 §8.
 * stdout is reserved for MCP framing; diagnostics go to stderr or AGENTBRIDGE_LOG.
 */
import packageJson from "../package.json";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
 type CallerSupport,
 type CallerSupportDeps,
 defaultCallerSupportDeps,
 evaluateCallerSupport,
 unsupportedCallerMessage,
} from "./caller-support";
import { log, logError, writeStderrLine } from "./log";
import { registerTools, type ToolDependencies } from "./tools";

export const SERVER_NAME = "agentbridge";
export const SERVER_VERSION: string = packageJson.version;

export interface AgentBridgeServerOptions {
 /** `false` keeps the MCP surface empty for an unsupported caller. */
 registerTools?: boolean;
}

export interface GuardedServerOptions {
 /** Receives exactly one diagnostic line when the caller is unsupported. */
 onUnsupported?: (message: string) => void;
}

export interface GuardedAgentBridgeServer {
 server: McpServer;
 support: CallerSupport;
}

export function createAgentBridgeServer(
 deps: ToolDependencies = {},
 options: AgentBridgeServerOptions = {},
): McpServer {
 const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
 if (options.registerTools !== false) {
  registerTools(server, deps);
  return server;
 }
 // Unsupported caller: advertise `tools` with an empty list so MCP clients
 // (e.g. OMP loading Claude plugins) see a healthy server, not -32601 errors.
 server.server.registerCapabilities({ tools: {} });
 server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
 server.server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  isError: true,
  content: [{ type: "text", text: `[AgentBridge] unsupported_caller: tool ${request.params.name} is not available` }],
 }));
 return server;
}

/**
 * Startup gate: resolve caller support before any tool is registered. An
 * unsupported caller gets an empty server and a single diagnostic line.
 */
export async function createGuardedAgentBridgeServer(
 deps: ToolDependencies = {},
 guardDeps: CallerSupportDeps = defaultCallerSupportDeps(),
 options: GuardedServerOptions = {},
): Promise<GuardedAgentBridgeServer> {
 const support = await evaluateCallerSupport(guardDeps);
 if (support.supported) {
  return { server: createAgentBridgeServer(deps), support };
 }
 (options.onUnsupported ?? writeStderrLine)(unsupportedCallerMessage(support.reason));
 return { server: createAgentBridgeServer(deps, { registerTools: false }), support };
}

export async function main(): Promise<void> {
 const { server, support } = await createGuardedAgentBridgeServer();
 const transport = new StdioServerTransport();
 await server.connect(transport);
 // The unsupported diagnostic was already logged once; do not add noise.
 if (support.supported) log("MCP server connected over stdio");
}

if (import.meta.main) {
 main().catch((error: unknown) => {
  logError("MCP server failed", error);
  process.exitCode = 1;
 });
}
