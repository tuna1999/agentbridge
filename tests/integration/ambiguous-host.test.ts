/**
 * T9 scenario 5: two hosts in the same worktree are never auto-selected; an
 * explicit target routes the consult to exactly one of them.
 */
import { afterEach, expect, test } from "bun:test";
import {
 connectMcp,
 createFakeHost,
 resultText,
 setupIntegrationEnv,
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

test("two hosts in one worktree require an explicit target", async () => {
 const env = setupIntegrationEnv();
 envs.push(env);
 const alpha = createFakeHost({
  sessionId: "omp-int-alpha",
  cwd: env.worktree,
  turn: { deltas: ["trả lời alpha\n"], replyText: "trả lời alpha\n" },
 });
 const bravo = createFakeHost({
  sessionId: "omp-int-bravo",
  cwd: env.worktree,
  turn: { deltas: ["trả lời bravo\n"], replyText: "trả lời bravo\n" },
 });
 hosts.push(alpha, bravo);
 await alpha.publish();
 await bravo.publish();
 const connection = await connectMcp(env);
 connections.push(connection);

 const listed = await connection.list();
 expect(resultText(listed)).toContain("Phiên OMP (2)");
 expect(resultText(listed)).toContain("omp-int-alpha");
 expect(resultText(listed)).toContain("omp-int-bravo");
 expect(listed.structuredContent).toBeUndefined();

 const ambiguous = await connection.consult({ question: "ai trả lời?" });
 expect(ambiguous.isError).toBe(true);
 expect(resultText(ambiguous)).toContain("ambiguous_target");
 expect(resultText(ambiguous)).toContain("omp-int-alpha");
 expect(resultText(ambiguous)).toContain("omp-int-bravo");
 expect(ambiguous.structuredContent).toBeUndefined();

 const targeted = await connection.consult({ question: "ai trả lời?", target: "omp-int-alpha" });
 expect(targeted.isError).toBeFalsy();
 expect(targeted.structuredContent).toBeUndefined();
 expect(resultText(targeted)).toContain("trả lời alpha");
 expect(resultText(targeted)).not.toContain("trả lời bravo");

 const other = await connection.consult({ question: "ai trả lời?", target: "omp-int-bravo" });
 expect(other.isError).toBeFalsy();
 expect(other.structuredContent).toBeUndefined();
 expect(resultText(other)).toContain("trả lời bravo");

 // Each targeted consult ran on exactly one host.
 expect(alpha.runCalls).toHaveLength(1);
 expect(bravo.runCalls).toHaveLength(1);
});
