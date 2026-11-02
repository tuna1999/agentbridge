/**
 * T9 scenario 4: a host that dies without cleaning its record must be listed as
 * `dead`, swept from the registry, and refused as a consult target.
 */
import { afterEach, expect, test } from "bun:test";
import { sweepStale } from "../../packages/core/src/index";
import {
 connectMcp,
 createFakeHost,
 readRecord,
 readToken,
 resultText,
 setupIntegrationEnv,
 simulateCrash,
 type FakeHost,
 type IntegrationEnv,
 type McpConnection,
} from "./helpers";

const envs: IntegrationEnv[] = [];
const hosts: FakeHost[] = [];
const connections: McpConnection[] = [];

afterEach(async () => {
 for (const connection of connections.splice(0)) {
  try {
   await connection.close();
  } catch {
   // already closed
  }
 }
 for (const host of hosts.splice(0)) host.shutdown();
 for (const env of envs.splice(0)) env.restore();
});

test("a crashed host is listed as dead, swept, and no longer a consult target", async () => {
 const env = setupIntegrationEnv();
 envs.push(env);
 const fake = createFakeHost({
  sessionId: "omp-int-dead",
  cwd: env.worktree,
  turn: { deltas: ["còn sống\n"], replyText: "còn sống\n" },
 });
 hosts.push(fake);
 await fake.publish();
 const record = readRecord(env, "omp-int-dead");
 const token = readToken(env, record);
 const connection = await connectMcp(env);
 connections.push(connection);

 const before = await connection.list();
 expect(resultText(before)).toContain("Phiên OMP (1)");
 expect(resultText(before)).toContain("omp-int-dead");
 expect(resultText(before)).toContain("alive");
 expect(before.structuredContent).toBeUndefined();

 // Crash: the server goes away, the record and token stay (pid now gone).
 fake.shutdown();
 await simulateCrash(record, token);

 const after = await connection.list();
 expect(resultText(after)).toContain("Phiên OMP (1)");
 expect(resultText(after)).toContain("omp-int-dead");
 expect(resultText(after)).toContain("dead");
 expect(after.structuredContent).toBeUndefined();

 const consulted = await connection.consult({ question: "còn đó không?" });
 expect(consulted.isError).toBe(true);
 expect(resultText(consulted)).toContain("no_target");
 expect(consulted.structuredContent).toBeUndefined();
 expect(fake.runCalls).toHaveLength(0);

 const swept = await sweepStale();
 expect(swept).toBe(1);

 const cleaned = await connection.list();
 expect(resultText(cleaned)).toContain("Không thấy phiên OMP nào");
 expect(cleaned.structuredContent).toBeUndefined();
});
