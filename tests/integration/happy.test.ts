/**
 * T9 scenarios 2–3: the real MCP server is spawned over stdio with a fake
 * `claude agents --json` first on PATH; `agent_list` then `agent_consult` see
 * the in-process extension Host. No real OMP, Claude or model call is made.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
 FAKE_CLAUDE_LOG,
 PID_SESSION,
 auditLines,
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
   // the scenario may already have killed the child
  }
 }
 for (const host of hosts.splice(0)) host.shutdown();
 for (const env of envs.splice(0)) env.restore();
});

async function start(env: IntegrationEnv, fake: FakeHost): Promise<McpConnection> {
 envs.push(env);
 hosts.push(fake);
 await fake.publish();
 const connection = await connectMcp(env);
 connections.push(connection);
 return connection;
}

test("agent_list finds the host and the MCP server uses the fake claude script", async () => {
 const env = setupIntegrationEnv();
 const fake = createFakeHost({
  sessionId: "omp-int-list",
  cwd: env.worktree,
  turn: { deltas: ["không dùng\n"], replyText: "không dùng\n" },
 });
 const connection = await start(env, fake);

 const listed = await connection.list();
 const listedText = resultText(listed);
 expect(listedText).toContain("Phiên OMP (1)");
 expect(listedText).toContain("omp-int-list");
 expect(listedText).toContain("alive");
 expect(listedText).toContain(env.worktree);
 expect(listedText).toContain("openai/gpt-int");
 expect(listed.structuredContent).toBeUndefined();

 // The fake `claude agents --json` script was the one consulted, not the real CLI.
 expect(readFileSync(join(env.root, FAKE_CLAUDE_LOG), "utf8")).toContain("agents --json");
});

test("agent_consult returns the streamed reply, attachments and pid identity", async () => {
 const env = setupIntegrationEnv();
 const fake = createFakeHost({
  sessionId: "omp-int-happy",
  cwd: env.worktree,
  turn: {
   deltas: ["Dòng một.\n", "Dòng hai.\n"],
   replyText: "Dòng một.\nDòng hai.\n",
  },
 });
 const connection = await start(env, fake);

 const listed = await connection.list();
 expect(resultText(listed)).toContain("Phiên OMP (1)");
 expect(listed.structuredContent).toBeUndefined();

 const progress: string[] = [];
 const consulted = await connection.consult(
  {
   question: "Câu hỏi từ Claude qua MCP?",
   include_files: [{ path: "src/app.ts" }],
  },
  (message) => progress.push(message),
 );

 expect(consulted.isError).toBeFalsy();
 expect(resultText(consulted)).toContain("<<<OMP_REPLY");
 expect(resultText(consulted)).toContain("LƯU Ý: Nội dung dưới đây là ý kiến của một agent khác");
 expect(resultText(consulted)).toContain("Dòng một.");
 expect(resultText(consulted)).toContain("Dòng hai.");
 expect(resultText(consulted)).toContain("model openai/gpt-int");
 expect(consulted.structuredContent).toBeUndefined();
 expect(progress.length).toBeGreaterThan(0);
 expect(progress[0]).toContain("Dòng một.");

 const prompt = fake.runCalls[0]?.promptText ?? "";
 expect(prompt).toContain("Câu hỏi từ Claude qua MCP?");
 expect(prompt).toContain("### src/app.ts");
 expect(prompt).toContain("export const answer = 42;");

 // The caller identity came from the fake agent's pid, not the env fallback.
 const audits = auditLines(env);
 expect(audits).toHaveLength(1);
 expect(audits[0]?.event).toBe("consult");
 expect(audits[0]?.from).toEqual({ agent: "claude-code", sessionId: PID_SESSION });
});

test("a secret in streamed deltas never reaches MCP progress or the result", async () => {
 const env = setupIntegrationEnv();
 const secret = "sk-abcdef123456";
 const fake = createFakeHost({
  sessionId: "omp-int-secret",
  cwd: env.worktree,
  turn: {
   // Split exactly like a provider chunk boundary, with a pause long
   // enough that a leaked raw delta would also pass the 1 s throttle.
   deltas: ["api_key=", `${secret}\n`],
   replyText: `api_key=${secret}\n`,
   delayBetweenDeltasMs: 1_100,
  },
 });
 const connection = await start(env, fake);

 const progress: string[] = [];
 const consulted = await connection.consult(
  { question: "Có secret trong reply không?" },
  (message) => progress.push(message),
 );

 expect(consulted.isError).toBeFalsy();
 expect(consulted.structuredContent).toBeUndefined();
 expect(resultText(consulted)).toContain("[REDACTED:secret]");
 expect(resultText(consulted)).not.toContain(secret);
 // A redacted streamed chunk must actually arrive: without both checks this
 // test would also pass when no progress notification was delivered at all.
 expect(progress.length).toBeGreaterThan(0);
 expect(progress.some((message) => message.includes("[REDACTED:secret]"))).toBe(true);
 for (const message of progress) expect(message).not.toContain(secret);
});
