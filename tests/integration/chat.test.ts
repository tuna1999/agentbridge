/**
 * T12: `agent_chat` through the real MCP stdio server and in-process Host.
 * The fake OMP emits message_start/message_update/agent_end exactly like the
 * event contract pinned in the extension types; no real OMP or model is used.
 */
import { afterEach, expect, test } from "bun:test";
import {
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
   // best-effort cleanup
  }
 }
 for (const host of hosts.splice(0)) host.shutdown();
 for (const env of envs.splice(0)) env.restore();
});

test("agent_chat relays a framed message and returns a text-only reference reply", async () => {
 const env = setupIntegrationEnv();
 envs.push(env);
 const fake = createFakeHost({
  sessionId: "omp-int-chat",
  cwd: env.worktree,
  turn: { deltas: [], replyText: "unused by chat" },
  chatReply: {
   replyText: "Đã kiểm tra xong.",
   deltas: ["Đã kiểm tra\n", "xong."],
   willContinueFirst: true,
  },
 });
 hosts.push(fake);
 await fake.publish();

 const connection = await connectMcp(env);
 connections.push(connection);

 const tools = await connection.client.listTools();
 expect(tools.tools.map((tool) => tool.name)).toContain("agent_chat");

 const progress: string[] = [];
 const result = await connection.chat(
  { message: "Chạy npm test giúp tôi", target: "omp-int-chat", timeout_s: 30 },
  (message) => progress.push(message),
 );
 const text = resultText(result);

 expect(result.isError).toBeUndefined();
 expect(text).toContain("[AgentBridge] OMP đã trả lời trong phiên chat");
 expect(text).toContain("LƯU Ý: Nội dung dưới đây là ý kiến của một agent khác");
 expect(text).toContain("DỮ LIỆU THAM KHẢO");
 expect(text).toContain("<<<OMP_REPLY\nĐã kiểm tra xong.\nOMP_REPLY>>>");
 expect(result.structuredContent).toBeUndefined();
 expect(progress).toContain("Đang chờ người dùng xác nhận trong OMP…");

 expect(fake.sentChats).toHaveLength(1);
 const frame = fake.sentChats[0] ?? "";
 expect(frame).toContain("[Tin nhắn từ Claude Code (phiên");
 expect(frame).toContain("chuyển qua AgentBridge — không phải người dùng gõ");
 expect(frame).toContain("Chạy npm test giúp tôi");

 const audit = auditLines(env).at(-1);
 expect(audit).toMatchObject({ event: "chat", outcome: "ok" });
});
