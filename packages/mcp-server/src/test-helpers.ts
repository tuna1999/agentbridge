/** Real T4 server with a fake OMP handler, used only by tests. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	endpointFor,
	getProcStart,
	type RequestIO,
	type SessionRecord,
	startServer,
	writeRecord,
} from "@agentbridge/core";
import {
	type ChatBody,
	type ChatResult,
	type ConsultBody,
	type ConsultResult,
	type Envelope,
	type HelloResult,
	newId,
	type StatusPolicy,
	type StatusResult,
} from "@agentbridge/protocol";

export interface FakeHostOptions {
	runtimeDir: string;
	sessionId: string;
	instanceId: string;
	cwd: string;
	sessionName?: string;
	consent?: StatusPolicy["consultConsent"];
	onConsult?: (env: Envelope, io: RequestIO) => Promise<void>;
	onChat?: (env: Envelope, io: RequestIO) => Promise<void>;
}

export interface FakeHost {
	record: SessionRecord;
	token: string;
	endpoint: string;
	consultBodies: ConsultBody[];
	chatBodies: ChatBody[];
	close(): Promise<void>;
}

const AGENT_VERSION = "omp-test";
const EXTENSION_VERSION = "0.0.0-test";

function model(): { provider: string; id: string } {
	return { provider: "openai", id: "test-model" };
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

export function fakeStatus(options: {
	sessionId: string;
	instanceId: string;
	cwd: string;
	consent: StatusPolicy["consultConsent"];
}): StatusResult {
	return {
		sessionId: options.sessionId,
		instanceId: options.instanceId,
		agentVersion: AGENT_VERSION,
		extensionVersion: EXTENSION_VERSION,
		capabilities: ["status", "consult", "chat"],
		model: model(),
		status: "idle",
		cwd: options.cwd,
		git: { worktree: options.cwd, commonDir: join(options.cwd, ".git"), branch: "main" },
		pendingMessages: false,
		policy: { projectAllowed: true, consultConsent: options.consent },
	};
}

export const DEFAULT_REPLY = "Xin chào từ OMP";

export function fakeConsultResult(replyText = DEFAULT_REPLY): ConsultResult {
	return {
		replyText,
		truncated: false,
		model: model(),
		usage: { input: 100, output: 42 },
		durationMs: 14_200,
		capped: true,
	};
}

export function fakeChatResult(replyText = DEFAULT_REPLY): ChatResult {
	return {
		replyText,
		truncated: false,
		model: model(),
		usage: { input: 100, output: 42 },
		durationMs: 14_200,
	};
}

export async function createFakeHost(options: FakeHostOptions): Promise<FakeHost> {
	const { runtimeDir, sessionId, instanceId, cwd } = options;
	const endpoint = endpointFor(runtimeDir, instanceId);
	await mkdir(join(runtimeDir, "s"), { recursive: true, mode: 0o700 });

	const token = `token-${instanceId}`;
	const consultBodies: ConsultBody[] = [];
	const chatBodies: ChatBody[] = [];

	const identity = (serverNonce: string): HelloResult => ({
		sessionId,
		instanceId,
		agentVersion: AGENT_VERSION,
		extensionVersion: EXTENSION_VERSION,
		protocol: 1,
		capabilities: ["status", "consult", "chat"],
		model: model(),
		status: "idle",
		serverNonce,
	});

	const handle = await startServer({
		endpoint,
		token,
		identity,
		onRequest: async (env, io) => {
			if (env.type === "status") {
				const status = fakeStatus({
					sessionId,
					instanceId,
					cwd,
					consent: options.consent ?? "ask",
				});
				io.send(resultFrame(sessionId, env.id, status));
				return;
			}
			if (env.type === "chat") {
				const body = env.body as ChatBody;
				chatBodies.push(body);
				if (options.onChat !== undefined) {
					await options.onChat(env, io);
					return;
				}
				io.send(resultFrame(sessionId, env.id, fakeChatResult()));
				return;
			}
			if (env.type !== "consult") return;
			const body = env.body as ConsultBody;
			consultBodies.push(body);
			if (options.onConsult !== undefined) {
				await options.onConsult(env, io);
				return;
			}
			io.send(resultFrame(sessionId, env.id, fakeConsultResult()));
		},
	});

	const procStart = await getProcStart(process.pid);
	const record: SessionRecord = {
		schema: "agentbridge.session/1",
		agent: "omp",
		agentVersion: AGENT_VERSION,
		extensionVersion: EXTENSION_VERSION,
		instanceId,
		sessionId,
		pid: process.pid,
		procStart,
		cwd,
		git: { worktree: cwd, commonDir: join(cwd, ".git"), branch: "main" },
		model: model(),
		status: "idle",
		capabilities: ["status", "consult", "chat"],
		endpoint,
		tokenFile: `omp-${sessionId}.token`,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	};
	if (options.sessionName !== undefined) record.sessionName = options.sessionName;

	await writeRecord(record, token);

	return {
		record,
		token,
		endpoint,
		consultBodies,
		chatBodies,
		close: () => handle.close(),
	};
}
