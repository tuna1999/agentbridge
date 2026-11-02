import { expect, test } from "bun:test";
import type { SessionRecord } from "@agentbridge/core";
import type { ConsultResult } from "@agentbridge/protocol";
import type { SessionView } from "./client";
import { formatFailure, type Failure } from "./errors";
import { formatConsultResult, formatSessionTable } from "./format";
import { MCP_MESSAGES } from "./messages";

const SESSION_ID = "0199ab12-3456-7000-8000-abcdef012345";

const record: SessionRecord = {
	schema: "agentbridge.session/1",
	agent: "omp",
	agentVersion: "18.14.0",
	extensionVersion: "0.0.1",
	instanceId: "0199ab12-9999-7000-8000-abcdef012345",
	sessionId: SESSION_ID,
	sessionName: "review-arch",
	pid: 1234,
	procStart: "linux:5678",
	cwd: "/home/dev/project",
	git: { worktree: "/home/dev/project", commonDir: "/home/dev/project/.git", branch: "feat/bridge" },
	model: { provider: "openai", id: "gpt-5-codex" },
	status: "idle",
	capabilities: ["status", "consult"],
	endpoint: "unix:/run/user/1000/agentbridge/s/deadbeef.sock",
	tokenFile: "omp-0199ab12.token",
	startedAt: 1_700_000_000_000,
	heartbeatAt: 1_700_000_001_000,
};

const consultResult: ConsultResult = {
	replyText: "Thiết kế ổn, nhưng nên tách phần IPC client.",
	truncated: false,
	model: { provider: "openai", id: "gpt-5-codex" },
	usage: { input: 1234, output: 1834 },
	durationMs: 14_200,
	capped: true,
};

test("consult result framing matches §8.4", () => {
	expect(formatConsultResult(record, consultResult)).toMatchSnapshot();
});

test("truncated consult header says the reply was cut", () => {
	const text = formatConsultResult(record, { ...consultResult, truncated: true });
	expect(text).toContain("đã cắt theo replyMaxBytes");
	expect(text).toContain("<<<OMP_REPLY");
});

test("list table includes every required column", () => {
	const view: SessionView = {
		record,
		liveness: "alive",
		status: {
			sessionId: SESSION_ID,
			instanceId: record.instanceId,
			agentVersion: record.agentVersion,
			extensionVersion: record.extensionVersion,
			capabilities: record.capabilities,
			model: record.model,
			status: "idle",
			cwd: record.cwd,
			git: record.git,
			pendingMessages: false,
			policy: { projectAllowed: true, consultConsent: "ask" },
		},
	};
	expect(formatSessionTable([view])).toMatchSnapshot();
});

test("ambiguous_target error lists options for the user", () => {
	const failure: Failure = {
		code: "ambiguous_target",
		message: MCP_MESSAGES.ambiguousTarget,
		hint: "Hỏi người dùng chọn sessionId trong danh sách bên dưới rồi gọi lại với `target`.",
		options: [
			{
				sessionId: SESSION_ID,
				sessionName: "review-arch",
				status: "idle",
				liveness: "alive",
				startedAt: record.startedAt,
				worktree: "/home/dev/project",
				branch: "feat/bridge",
			},
			{
				sessionId: "0199ab12-7777-7000-8000-abcdef012345",
				status: "busy",
				liveness: "alive",
				startedAt: record.startedAt - 1,
				worktree: "/home/dev/project",
				branch: "main",
			},
		],
	};
	expect(formatFailure(failure)).toMatchSnapshot();
});
