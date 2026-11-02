/**
 * T9 scenario 1: the extension `Host` started with a fake `pi`/`ctx` publishes
 * its record inside the temp runtime dir and serves a streaming consult over
 * the real IPC transport. `runEphemeralTurn` is fake, so no OMP or model runs.
 */
import { afterEach, expect, test } from "bun:test";
import { request } from "../../packages/core/src/index";
import type { ConsultResult, ProgressBody } from "../../packages/protocol/src/index";
import {
 createFakeHost,
 readRecord,
 readToken,
 setupIntegrationEnv,
 type FakeHost,
 type IntegrationEnv,
} from "./helpers";

const envs: IntegrationEnv[] = [];
const hosts: FakeHost[] = [];

afterEach(() => {
 for (const host of hosts.splice(0)) host.shutdown();
 for (const env of envs.splice(0)) env.restore();
});

test("a fake OMP host publishes a record and streams over the IPC transport", async () => {
 const env = setupIntegrationEnv();
 envs.push(env);
 const fake = createFakeHost({
  sessionId: "omp-int-host",
  cwd: env.worktree,
  turn: { deltas: ["một\n", "hai\n"], replyText: "một\nhai\n" },
 });
 hosts.push(fake);
 await fake.publish();

 const record = readRecord(env, "omp-int-host");
 expect(record.sessionId).toBe("omp-int-host");
 expect(record.capabilities).toEqual(["status", "consult", "chat"]);
 expect(record.cwd).toBe(env.worktree);
 expect(record.endpoint.startsWith("unix:")).toBe(true);
 const token = readToken(env, record);

 const progress: ProgressBody[] = [];
 const { hello, result } = await request({
  endpoint: record.endpoint,
  token,
  from: { agent: "claude-code", sessionId: "caller-int-host" },
  to: { agent: "omp", sessionId: record.sessionId, instanceId: record.instanceId },
  type: "consult",
  body: { question: "host chạy chưa?", stream: true },
  onProgress: (value) => progress.push(value),
  timeoutMs: 5_000,
 });

 expect(hello.instanceId).toBe(record.instanceId);
 expect(hello.capabilities).toEqual(["status", "consult", "chat"]);
 expect((result as ConsultResult).replyText).toBe("một\nhai\n");
 expect(progress.filter((item) => item.phase === "delta").map((item) => item.delta)).toEqual([
  "một\n",
  "hai\n",
 ]);
 expect(fake.runCalls).toHaveLength(1);
 expect(typeof fake.runCalls[0]?.onTextDelta).toBe("function");
 expect(fake.runCalls[0]?.tools).toBe(false);
});
