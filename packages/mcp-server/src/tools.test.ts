import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Envelope, newId, type ProgressBody } from "@agentbridge/protocol";
import type { BridgeIdentity } from "./identity";
import { createAgentBridgeServer } from "./index";
import { ERROR_TEXT } from "./messages";
import {
	createFakeHost,
	DEFAULT_REPLY,
	fakeChatResult,
	fakeConsultResult,
	type FakeHost,
	type FakeHostOptions,
} from "./test-helpers";
import {
	createToolHandlers,
	type ConsultExtra,
	type ProgressNotificationLike,
	type ToolDependencies,
} from "./tools";

const SESSION_A = "0199ab12-0000-7000-8000-000000000001";
const INSTANCE_A = "0199ab12-1111-7000-8000-000000000001";
const SESSION_B = "0199ab12-0000-7000-8000-000000000002";
const INSTANCE_B = "0199ab12-1111-7000-8000-000000000002";

let runtimeDir: string;
let projectDir: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["AGENTBRIDGE_RUNTIME_DIR", "AGENTBRIDGE_STATE_DIR", "AGENTBRIDGE_CONFIG"] as const;

beforeEach(async () => {
	runtimeDir = await mkdtemp(join(tmpdir(), "ab-mcp-test-"));
	projectDir = join(runtimeDir, "project");
	await mkdir(projectDir, { recursive: true });
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.AGENTBRIDGE_RUNTIME_DIR = runtimeDir;
	process.env.AGENTBRIDGE_STATE_DIR = join(runtimeDir, "state");
	process.env.AGENTBRIDGE_CONFIG = join(runtimeDir, "config.json");
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(runtimeDir, { recursive: true, force: true });
});

function deps(): ToolDependencies {
	return {
		resolveIdentity: async (): Promise<BridgeIdentity> => ({
			sessionId: "claude-test",
			pid: process.pid,
			cwd: projectDir,
			confidence: "env",
			projectRoot: projectDir,
			git: { worktree: projectDir, commonDir: join(projectDir, ".git"), branch: "main" },
		}),
		now: () => 1_000_000,
	};
}

function extra(
	notifications: ProgressNotificationLike[],
	controller = new AbortController(),
): { extra: ConsultExtra; controller: AbortController } {
	return {
		controller,
		extra: {
			signal: controller.signal,
			_meta: { progressToken: "progress-1" },
			sendNotification: async (notification) => {
				notifications.push(notification);
			},
		},
	};
}

function progressFrame(sessionId: string, replyTo: string, body: ProgressBody): Envelope {
	return {
		v: 1,
		id: newId(),
		type: "progress",
		replyTo,
		from: { agent: "omp", sessionId },
		ts: Date.now(),
		hop: 0,
		body,
	};
}

function errorFrame(
	sessionId: string,
	replyTo: string,
	code: string,
	message: string,
	details?: Record<string, unknown>,
): Envelope {
	const body: Record<string, unknown> = { code, message, retryable: true };
	if (details !== undefined) body.details = details;
	return {
		v: 1,
		id: newId(),
		type: "error",
		replyTo,
		from: { agent: "omp", sessionId },
		ts: Date.now(),
		hop: 0,
		body,
	};
}

function resultFrame(sessionId: string, replyTo: string, body: unknown): Envelope {
	return {
		v: 1,
		id: newId(),
		type: "result",
		replyTo,
		from: { agent: "omp", sessionId },
		ts: Date.now(),
		hop: 0,
		body,
	};
}

async function host(options: Partial<FakeHostOptions> = {}): Promise<FakeHost> {
	return createFakeHost({
		runtimeDir,
		sessionId: SESSION_A,
		instanceId: INSTANCE_A,
		cwd: projectDir,
		sessionName: "omp-main",
		...options,
	});
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	const aborted = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => aborted.resolve(), { once: true });
	await aborted.promise;
}

describe("agent_consult", () => {
	test("happy path sends include_files redacted and framed reply", async () => {
		await writeFile(join(projectDir, "note.ts"), "line one\nconst password = \"supersecret123\";\nline three\n");
		const notifications: ProgressNotificationLike[] = [];
		const fake = await host({
			onConsult: async (env, io) => {
				io.send(progressFrame(SESSION_A, env.id, { phase: "awaiting_consent" }));
				io.send(progressFrame(SESSION_A, env.id, { phase: "running" }));
				io.send(progressFrame(SESSION_A, env.id, { phase: "delta", delta: "Xin " }));
				io.send(progressFrame(SESSION_A, env.id, { phase: "delta", delta: "chào" }));
				io.send(resultFrame(SESSION_A, env.id, fakeConsultResult()));
			},
		});

		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.consult(
				{
					question: "Kiến trúc này ổn không?",
					include_files: [{ path: "note.ts", startLine: 2, endLine: 2 }],
					timeout_s: 30,
				},
				extra(notifications).extra,
			);

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("[AgentBridge] Phản hồi từ OMP");
			expect(text).toContain(`phiên ${SESSION_A.slice(0, 8)} "omp-main"`);
			expect(text).toContain("model openai/test-model · 14.2s · out 42 tok");
			expect(text).toContain("LƯU Ý: Nội dung dưới đây là ý kiến của một agent khác");
			expect(text).toContain(`<<<OMP_REPLY\n${DEFAULT_REPLY}\nOMP_REPLY>>>`);
			expect(result.structuredContent).toBeUndefined();

			expect(fake.consultBodies).toHaveLength(1);
			const body = fake.consultBodies[0];
			expect(body?.question).toBe("Kiến trúc này ổn không?");
			expect(body?.stream).toBe(true);
			expect(body?.attachments).toHaveLength(1);
			expect(body?.attachments?.[0]?.path).toBe("note.ts");
			expect(body?.attachments?.[0]?.startLine).toBe(2);
			expect(body?.attachments?.[0]?.endLine).toBe(2);
			expect(body?.attachments?.[0]?.text).toBe('const password = "[REDACTED:secret]";');
			expect(body?.attachments?.[0]?.text).not.toContain("supersecret123");

			expect(notifications).toHaveLength(1);
			expect(notifications[0]?.params.progressToken).toBe("progress-1");
			expect(notifications[0]?.params.message).toBe("Đang chờ người dùng xác nhận trong OMP…");
		} finally {
			await fake.close();
		}
	});

	test("truncated replies are marked in the consult text, capped is not exposed", async () => {
		const fake = await host({
			onConsult: async (env, io) => {
				io.send(resultFrame(SESSION_A, env.id, { ...fakeConsultResult(), truncated: true }));
			},
		});

		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.consult({ question: "Có bị cắt không?", timeout_s: 30 }, extra([]).extra);

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("đã cắt theo replyMaxBytes");
			expect(text).toContain("<<<OMP_REPLY");
			expect(text).not.toContain("capped");
			expect(text).not.toContain("maxTokens");
			expect(result.structuredContent).toBeUndefined();
		} finally {
			await fake.close();
		}
	});

	test("question is redacted before it reaches OMP", async () => {
		const fake = await host();
		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.consult(
				{ question: 'password = "supersecret123"', timeout_s: 30 },
				extra([]).extra,
			);

			expect(result.isError).toBeUndefined();
			expect(fake.consultBodies[0]?.question).toContain("[REDACTED:secret]");
			expect(fake.consultBodies[0]?.question).not.toContain("supersecret123");
		} finally {
			await fake.close();
		}
	});

	test("ambiguous_target returns options and never consults", async () => {
		const first = await host();
		const second = await host({
			sessionId: SESSION_B,
			instanceId: INSTANCE_B,
			sessionName: "omp-second",
		});

		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.consult(
				{ question: "Ai đang làm gì?", timeout_s: 30 },
				extra([]).extra,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("ambiguous_target");
			expect(text).toContain("Hãy hỏi người dùng chọn một phiên");
			expect(text).toContain(SESSION_A);
			expect(text).toContain(SESSION_B);
			expect(result.structuredContent).toBeUndefined();
			expect(first.consultBodies).toHaveLength(0);
			expect(second.consultBodies).toHaveLength(0);
		} finally {
			await first.close();
			await second.close();
		}
	});

	test("pathguard blocks .env before any IPC consult", async () => {
		await writeFile(join(projectDir, ".env"), "SECRET=supersecret\n");
		const fake = await host();

		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.consult(
				{ question: "Xem file này", include_files: [{ path: ".env" }], timeout_s: 30 },
				extra([]).extra,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("path_blocked");
			expect(text).toContain("bị chặn");
			expect(result.structuredContent).toBeUndefined();
			expect(fake.consultBodies).toHaveLength(0);
		} finally {
			await fake.close();
		}
	});

	test("cancellation aborts the IPC request and does not retry", async () => {
		const started = Promise.withResolvers<void>();
		const fake = await host({
			onConsult: async (_env, io) => {
				started.resolve();
				if (io.signal.aborted) return;
				const aborted = Promise.withResolvers<void>();
				io.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
			},
		});

		try {
			const controllers = extra([]);
			const handlers = createToolHandlers(deps());
			const pending = handlers.consult(
				{ question: "Chờ một chút", timeout_s: 30 },
				controllers.extra,
			);

			await started.promise;
			controllers.controller.abort();
			const result = await pending;

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("cancelled");
			expect(result.structuredContent).toBeUndefined();
			expect(fake.consultBodies).toHaveLength(1);
		} finally {
			await fake.close();
		}
	});

	test("target_exited is returned once, never retried", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fake = await host({
			onConsult: async () => {
				started.resolve();
				await release.promise;
			},
		});

		try {
			const handlers = createToolHandlers(deps());
			const pending = handlers.consult({ question: "Bạn còn đó không?", timeout_s: 30 }, extra([]).extra);

			await started.promise;
			await fake.close();
			release.resolve();
			const result = await pending;

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("target_exited");
			expect(text).toContain("KHÔNG tự động thử lại");
			expect(text).not.toContain("Quá thời gian chờ (timeout_s).");
			expect(fake.consultBodies).toHaveLength(1);
		} finally {
			release.resolve();
			await fake.close();
		}
	});

	test("client timeout gets the timeout-specific message and no retry advice", async () => {
		const started = Promise.withResolvers<void>();
		const fake = await host({
			onConsult: async (_env, io) => {
				started.resolve();
				await waitForAbort(io.signal);
			},
		});

		try {
			const handlers = createToolHandlers(deps());
			// Direct handler call bypasses the zod minimum; 100 ms keeps the test fast.
			const pending = handlers.consult({ question: "Còn đó không?", timeout_s: 0.1 }, extra([]).extra);
			await started.promise;
			const result = await pending;

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("target_exited");
			expect(text).toContain("Quá thời gian chờ (timeout_s).");
			expect(text).toContain("OMP có thể vẫn đang xử lý hoặc đang chờ xác nhận.");
			expect(text).toContain("Không tự động gọi lại; hỏi người dùng có muốn tăng timeout_s không.");
			expect(text).not.toContain("Phiên OMP đóng kết nối trước khi trả kết quả.");
			expect(result.structuredContent).toBeUndefined();
			expect(fake.consultBodies).toHaveLength(1);
		} finally {
			await fake.close();
		}
	});

	test("retryable host errors are surfaced without a second attempt", async () => {
		const fake = await host({
			onConsult: async (env, io) => {
				io.send(errorFrame(SESSION_A, env.id, "busy_limit", "already running"));
			},
		});

		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.consult(
				{ question: "Thử lại xem", timeout_s: 30 },
				extra([]).extra,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("busy_limit");
			expect(text).toContain("KHÔNG tự động thử lại");
			expect(result.structuredContent).toBeUndefined();
			expect(fake.consultBodies).toHaveLength(1);
		} finally {
			await fake.close();
		}
	});
});

describe("agent_chat", () => {
	test("happy path sends a redacted message and frames the reply as reference data", async () => {
		const notifications: ProgressNotificationLike[] = [];
		const fake = await host({
			onChat: async (env, io) => {
				io.send(progressFrame(SESSION_A, env.id, { phase: "awaiting_consent" }));
				io.send(progressFrame(SESSION_A, env.id, { phase: "running" }));
				io.send(progressFrame(SESSION_A, env.id, { phase: "delta", delta: "Đã " }));
				io.send(resultFrame(SESSION_A, env.id, fakeChatResult()));
			},
		});

		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.chat(
				{ message: 'password = "supersecret123"', timeout_s: 30 },
				extra(notifications).extra,
			);

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("[AgentBridge] OMP đã trả lời trong phiên chat");
			expect(text).toContain(`phiên ${SESSION_A.slice(0, 8)} "omp-main"`);
			expect(text).toContain("model openai/test-model · 14.2s · out 42 tok");
			expect(text).toContain("LƯU Ý: Nội dung dưới đây là ý kiến của một agent khác");
			expect(text).toContain("DỮ LIỆU THAM KHẢO");
			expect(text).toContain(`<<<OMP_REPLY\n${DEFAULT_REPLY}\nOMP_REPLY>>>`);
			expect(result.structuredContent).toBeUndefined();

			expect(fake.chatBodies).toHaveLength(1);
			const body = fake.chatBodies[0];
			expect(body?.message).toContain("[REDACTED:secret]");
			expect(body?.message).not.toContain("supersecret123");
			expect(body?.timeoutMs).toBe(30_000);
			expect(notifications[0]?.params.message).toBe("Đang chờ người dùng xác nhận trong OMP…");
		} finally {
			await fake.close();
		}
	});

	test("chat_disabled and busy are surfaced as text errors", async () => {
		for (const code of ["chat_disabled", "busy"]) {
			const fake = await host({
				onChat: async (env, io) => {
					io.send(errorFrame(SESSION_A, env.id, code, code));
				},
			});
			try {
				const handlers = createToolHandlers(deps());
				const result = await handlers.chat({ message: "Thử", timeout_s: 30 }, extra([]).extra);
				expect(result.isError).toBe(true);
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				expect(text).toContain(code);
				expect(result.structuredContent).toBeUndefined();
				expect(fake.chatBodies).toHaveLength(1);
			} finally {
				await fake.close();
			}
		}
	});
	test("chat_timeout gets the do-not-resend message", async () => {
		const fake = await host({
			onChat: async (env, io) => {
				io.send(
					errorFrame(SESSION_A, env.id, "target_exited", "chat timed out", {
						reason: "chat_timeout",
					}),
				);
			},
		});
		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.chat({ message: "Chờ", timeout_s: 30 }, extra([]).extra);
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain(
				"OMP có thể vẫn đang chạy lượt này trong phiên; KHÔNG gửi lại tin, hãy hỏi người dùng hoặc dùng agent_status.",
			);
			expect(text).toContain("Không tự động gửi lại tin.");
			expect(text).not.toContain("Quá thời gian chờ (timeout_s).");
			expect(result.structuredContent).toBeUndefined();
		} finally {
			await fake.close();
		}
	});
});

describe("error hints", () => {
	test("config hints point to the ~/.agentbridge default and AGENTBRIDGE_HOME", () => {
		for (const code of ["project_not_allowed", "chat_disabled"]) {
			const hint = ERROR_TEXT[code]?.hint ?? "";
			expect(hint).toContain("~/.agentbridge/config.json");
			expect(hint).toContain("AGENTBRIDGE_HOME");
			expect(hint).not.toContain("~/.config/agentbridge");
		}
	});
});

describe("MCP registration", () => {
	test("lists tools with schemas and routes agent_list", async () => {
		const fake = await host({ consent: "always" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createAgentBridgeServer(deps());
		const client = new Client({ name: "test-client", version: "0.0.0" });

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);

			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
				"agent_chat",
				"agent_consult",
				"agent_list",
				"agent_status",
			]);
			const consultTool = listed.tools.find((tool) => tool.name === "agent_consult");
			expect(consultTool?.inputSchema.required).toContain("question");
			expect(consultTool?._meta?.["anthropic/maxResultSizeChars"]).toBe(100000);
			const chatTool = listed.tools.find((tool) => tool.name === "agent_chat");
			expect(chatTool?.inputSchema.required).toContain("message");
			expect(chatTool?._meta?.["anthropic/maxResultSizeChars"]).toBe(100000);
			for (const tool of listed.tools) expect(tool.outputSchema).toBeUndefined();

			const result = await client.callTool({ name: "agent_list", arguments: { scope: "worktree" } });
			const content = result.content as Array<{ type: string; text?: string }>;
			expect(content[0]?.type).toBe("text");
			expect(content[0]?.text).toContain("Phiên OMP (1)");
			expect(result.structuredContent).toBeUndefined();
		} finally {
			await client.close();
			await server.close();
			await fake.close();
		}
	});
});

describe("agent_list and agent_status", () => {
	test("agent_list shows consent from status", async () => {
		const fake = await host({ consent: "always" });
		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.list({ scope: "worktree" });

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Phiên OMP (1)");
			expect(text).toContain(SESSION_A);
			expect(text).toContain("openai/test-model");
			expect(text).toContain("idle");
			expect(text).toContain(projectDir);
			expect(text).toContain("main");
			expect(text).toContain("alive");
			expect(text).toContain("always");
			expect(result.structuredContent).toBeUndefined();
		} finally {
			await fake.close();
		}
	});

	test("agent_status returns every field as text", async () => {
		const fake = await host();
		try {
			const handlers = createToolHandlers(deps());
			const result = await handlers.status({});

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Trạng thái phiên OMP");
			expect(text).toContain(`Session: ${SESSION_A}`);
			expect(text).toContain("Model: openai/test-model");
			expect(text).toContain("Status: idle");
			expect(text).toContain("Liveness: alive");
			expect(text).toContain(`Worktree: ${projectDir}`);
			expect(text).toContain("Branch: main");
			expect(text).toContain("Project allowed: có");
			expect(text).toContain("Consent: ask");
			expect(result.structuredContent).toBeUndefined();
		} finally {
			await fake.close();
		}
	});
});
