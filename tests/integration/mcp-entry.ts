/**
 * Integration harness entry point for the MCP server.
 *
 * The production stdio entry refuses to expose tools when an `omp` process is
 * in its ancestry (T14). This suite can itself run under `omp` (for example
 * inside an agent worker), so a spawned child would see a real OMP ancestor
 * even though the fake `claude agents` pid points at the test process.
 *
 * This entry keeps the production guard and tool wiring but neutralizes only
 * the process-name probe. The probe itself is covered by
 * `packages/mcp-server/src/caller-support.test.ts`; identity gating still runs
 * here, so a missing Claude Code session still produces an empty tool surface.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getParentPid } from "../../packages/core/src/index";
import { createGuardedAgentBridgeServer } from "../../packages/mcp-server/src/index";
import { createIdentityResolver } from "../../packages/mcp-server/src/identity";

const resolver = createIdentityResolver();
const { server } = await createGuardedAgentBridgeServer(
 {},
 {
  ppid: process.ppid,
  platform: process.platform,
  readParentPid: getParentPid,
  readProcessName: async () => undefined,
  resolveIdentity: () => resolver.resolve(),
 },
);
await server.connect(new StdioServerTransport());
