import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Dirs,
	endpointFor,
	request,
	resolveDirs,
	type SessionRecord,
	writeRecord,
} from "@agentbridge/core";
import { ProtocolError, type Peer, type StatusResult } from "@agentbridge/protocol";
import factory, {
	AUTOCHAT_FLAG,
	Host,
	createOmpLike,
	type OmpAgentEndLike,
	type OmpContextLike,
	type OmpEventName,
	type OmpEventHandler,
	type PiLike,
} from "./index";

interface FakeCtx extends OmpContextLike {
	statusCalls: Array<[string, string | undefined]>;
	notifications: Array<[string, string | undefined]>;
	intervals: Array<{ callback: () => void; ms: number | undefined }>;
	clearedTimers: unknown[];
	setStatusThrows: boolean;
	idle: boolean;
	setSessionId(id: string): void;
	setIdle(idle: boolean): void;
}

function makeCtx(
	sessionId: string,
	options: {
		cwd?: string;
		kind?: string;
		hasUI?: boolean;
		mode?: string;
		consult?: boolean;
		setStatusThrows?: boolean;
	} = {},
): FakeCtx {
	let currentId = sessionId;
	const ctx: FakeCtx = {
		ui: {
			setStatus(key, text) {
				ctx.statusCalls.push([key, text]);
				if (ctx.setStatusThrows) throw new Error("setStatus failed");
			},
			notify(message, type) {
				ctx.notifications.push([message, type]);
			},
		},
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? process.cwd(),
		agent: { kind: options.kind ?? "main" },
		model: { provider: "openai", id: "gpt-test" },
		sessionManager: { getSessionId: () => currentId },
		isIdle: () => ctx.idle,
		hasPendingMessages: () => false,
		setInterval(callback, ms) {
			const timer = { id: ctx.intervals.length + 1 };
			ctx.intervals.push({ callback: callback as () => void, ms });
			return timer;
		},
		clearTimer(timer) {
			ctx.clearedTimers.push(timer);
		},
		...((options.consult ?? true)
			? {
				runEphemeralTurn: async () => {
					throw new Error("not used in T6");
				},
			}
			: {}),
		statusCalls: [],
		notifications: [],
		intervals: [],
		clearedTimers: [],
		setStatusThrows: options.setStatusThrows ?? false,
		idle: true,
		setSessionId(id: string) {
			currentId = id;
		},
		setIdle(idle: boolean) {
			ctx.idle = idle;
		},
	};
	return ctx;
}

function makePi(sessionName?: string): {
	pi: PiLike;
	handlers: Map<OmpEventName, OmpEventHandler[]>;
	commands: Map<string, Parameters<PiLike["registerCommand"]>[1]>;
	flags: Map<string, { description?: string; type: "boolean" | "string"; default?: boolean | string }>;
	getFlag(name: string): boolean | string | undefined;
	fire(event: OmpEventName, ctx: OmpContextLike, payload?: OmpAgentEndLike): Promise<void>;
	run(args: string, ctx: OmpContextLike): Promise<void>;
} {
	const handlers = new Map<OmpEventName, OmpEventHandler[]>();
	const commands = new Map<string, Parameters<PiLike["registerCommand"]>[1]>();
	const flags = new Map<
		string,
		{ description?: string; type: "boolean" | "string"; default?: boolean | string }
	>();
	const pi: PiLike = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerFlag(name, options) {
			flags.set(name, options);
		},
		getFlag() {
			return undefined;
		},
		getSessionName() {
			return sessionName;
		},
	};
	return {
		pi,
		handlers,
		commands,
		flags,
		getFlag(name: string) {
			return pi.getFlag?.(name);
		},
		async fire(event, ctx, payload = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		async run(args, ctx) {
			const command = commands.get("agentbridge");
			if (command === undefined) throw new Error("command not registered");
			await command.handler(args, ctx);
		},
	};
}

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const savedEnv = {
	runtime: process.env.AGENTBRIDGE_RUNTIME_DIR,
	state: process.env.AGENTBRIDGE_STATE_DIR,
	config: process.env.AGENTBRIDGE_CONFIG,
	home: process.env.AGENTBRIDGE_HOME,
};

function setupEnv(): { root: string; dirs: Dirs } {
	const root = mkdtempSync(join(tmpdir(), "agentbridge-omp-test-"));
	roots.push(root);
	process.env.AGENTBRIDGE_HOME = join(root, "home");
	process.env.AGENTBRIDGE_RUNTIME_DIR = join(root, "run");
	process.env.AGENTBRIDGE_STATE_DIR = join(root, "state");
	process.env.AGENTBRIDGE_CONFIG = join(root, "config.json");
	return { root, dirs: resolveDirs() };
}

function restoreEnv(key: "runtime" | "state" | "config" | "home"): void {
	const name = {
		runtime: "AGENTBRIDGE_RUNTIME_DIR",
		state: "AGENTBRIDGE_STATE_DIR",
		config: "AGENTBRIDGE_CONFIG",
		home: "AGENTBRIDGE_HOME",
	}[key];
	const value = savedEnv[key];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		try {
			await cleanup();
		} catch {
			// best-effort test cleanup
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	restoreEnv("runtime");
	restoreEnv("state");
	restoreEnv("config");
	restoreEnv("home");
});

async function readRecord(sessionId: string): Promise<{ record: Record<string, unknown>; token: string }> {
	const dirs = resolveDirs();
	const record = JSON.parse(await readFile(join(dirs.sessionsDir, `omp-${sessionId}.json`), "utf8")) as Record<
		string,
		unknown
	>;
	const token = (await readFile(join(dirs.sessionsDir, String(record.tokenFile)), "utf8")).trim();
	return { record, token };
}

async function statusOf(record: Record<string, unknown>, token: string): Promise<StatusResult> {
	const result = await request({
		endpoint: String(record.endpoint),
		token,
		from: { agent: "claude-code", sessionId: "test-client" },
		to: {
			agent: "omp",
			sessionId: String(record.sessionId),
			instanceId: String(record.instanceId),
		},
		type: "status",
		body: {},
		timeoutMs: 2_000,
	});
	return result.result as StatusResult;
}

function deadRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
	const sessionId = overrides.sessionId ?? "dead-session";
	return {
		schema: "agentbridge.session/1",
		agent: "omp",
		agentVersion: "18.14.0",
		extensionVersion: "0.0.0-test",
		instanceId: "dead-instance",
		sessionId,
		pid: 999_999_999,
		procStart: "linux:1",
		cwd: "/tmp",
		status: "idle",
		capabilities: ["status"],
		endpoint: "unix:/tmp/dead.sock",
		tokenFile: `omp-${sessionId}.token`,
		startedAt: 1,
		heartbeatAt: 1,
		...overrides,
	};
}

async function listenUnixSocket(path: string, dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const server = createServer();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(path, () => resolve());
	await promise;
	cleanups.push(async () => {
		server.close();
	});
}

test("factory registers handlers and command without I/O", () => {
	const { dirs } = setupEnv();
	const { pi, handlers, commands, flags } = makePi();
	factory(pi);

	const expectedEvents: OmpEventName[] = [
		"agent_end",
		"agent_start",
		"message_end",
		"message_start",
		"message_update",
		"session_shutdown",
		"session_start",
		"session_switch",
		"tool_approval_requested",
		"tool_approval_resolved",
	];
	expect([...handlers.keys()].sort()).toEqual(expectedEvents.sort());
	expect(commands.has("agentbridge")).toBe(true);
	expect(commands.get("agentbridge")?.getArgumentCompletions?.("auto")?.map((item) => item.value)).toEqual([
		"autochat ",
	]);
	expect(flags.get(AUTOCHAT_FLAG)).toMatchObject({ type: "string" });
	expect(flags.get(AUTOCHAT_FLAG)?.default).toBeUndefined();
	expect(existsSync(dirs.runtimeDir)).toBe(false);
	expect(existsSync(dirs.sessionsDir)).toBe(false);
});

test("subagent sessions do not publish", async () => {
	const { root, dirs } = setupEnv();
	const { pi, fire } = makePi();
	factory(pi);
	const ctx = makeCtx("sub-1", { cwd: root, kind: "sub" });

	await fire("session_start", ctx);

	expect(existsSync(dirs.runtimeDir)).toBe(false);
	expect(ctx.statusCalls).toEqual([]);
});

test("publishes a record and answers status over IPC", async () => {
	const { root, dirs } = setupEnv();
	const { pi, fire } = makePi("my session");
	factory(pi);
	const ctx = makeCtx("s1", { cwd: root });
	cleanups.push(() => fire("session_shutdown", ctx));

	await fire("session_start", ctx);

	const expectedCwd = await realpath(root);
	const { record, token } = await readRecord("s1");
	expect(record.schema).toBe("agentbridge.session/1");
	expect(record.agent).toBe("omp");
	expect(record.sessionId).toBe("s1");
	expect(record.sessionName).toBe("my session");
	expect(record.cwd).toBe(expectedCwd);
	expect(record.status).toBe("idle");
	expect(record.capabilities).toEqual(["status", "consult"]);
	expect(record.tokenFile).toBe("omp-s1.token");
	expect(String(record.endpoint).startsWith(`unix:${dirs.socketsDir}/`)).toBe(true);
	expect(token.length).toBeGreaterThan(20);
	expect(ctx.statusCalls).toContainEqual(["agentbridge", "🔗 bridge"]);
	expect(ctx.intervals.length).toBe(1);
	expect(ctx.intervals[0]?.ms).toBe(15_000);

	const status = await statusOf(record, token);
	expect(status.sessionId).toBe("s1");
	expect(status.instanceId).toBe(String(record.instanceId));
	expect(status.status).toBe("idle");
	expect(status.cwd).toBe(expectedCwd);
	expect(status.pendingMessages).toBe(false);
	expect(status.policy).toEqual({ projectAllowed: false, consultConsent: "ask" });
	expect(status.capabilities).toEqual(["status", "consult"]);
	expect(status.model).toEqual({ provider: "openai", id: "gpt-test" });
});

test("publish sweeps a dead session's record, token, and socket", async () => {
	const { root, dirs } = setupEnv();
	const instanceId = "dead-publish-instance";
	const endpoint = endpointFor(dirs.runtimeDir, instanceId);
	const socketPath = endpoint.slice("unix:".length);
	await listenUnixSocket(socketPath, dirs.socketsDir);
	const dead = deadRecord({ sessionId: "dead-publish", instanceId, endpoint });
	await writeRecord(dead, "dead-token");

	const { pi } = makePi();
	const host = new Host(createOmpLike(pi, "0.0.0-test"));
	cleanups.push(async () => host.shutdownSync());
	await host.publish(makeCtx("live-session", { cwd: root }));

	expect(existsSync(join(dirs.sessionsDir, "omp-dead-publish.json"))).toBe(false);
	expect(existsSync(join(dirs.sessionsDir, dead.tokenFile))).toBe(false);
	expect(existsSync(socketPath)).toBe(false);
	expect(existsSync(join(dirs.sessionsDir, "omp-live-session.json"))).toBe(true);
});

test("publish succeeds when the stale sweep fails", async () => {
	const { root, dirs } = setupEnv();
	const { pi } = makePi();
	let sweepCalls = 0;
	const host = new Host(createOmpLike(pi, "0.0.0-test"), {
		sweepStale: async () => {
			sweepCalls += 1;
			throw new Error("sweep failed");
		},
	});
	cleanups.push(async () => host.shutdownSync());
	const ctx = makeCtx("after-sweep-failure", { cwd: root });
	await host.publish(ctx);

	expect(sweepCalls).toBe(1);
	expect(existsSync(join(dirs.sessionsDir, "omp-after-sweep-failure.json"))).toBe(true);
	expect(ctx.statusCalls).toContainEqual(["agentbridge", "🔗 bridge"]);
	expect(ctx.notifications).toEqual([]);
});

test("status-only capability when runEphemeralTurn is absent", async () => {
	const { root } = setupEnv();
	const { pi, fire } = makePi();
	factory(pi);
	const ctx = makeCtx("s-status", { cwd: root, consult: false });
	cleanups.push(() => fire("session_shutdown", ctx));

	await fire("session_start", ctx);

	const { record } = await readRecord("s-status");
	expect(record.capabilities).toEqual(["status"]);
	expect(ctx.statusCalls).toContainEqual(["agentbridge", "🔗 bridge (status-only)"]);
});

test("agent and approval events drive reported status, honoring willContinue", async () => {
	const { root } = setupEnv();
	const { pi, fire } = makePi();
	factory(pi);
	const ctx = makeCtx("s2", { cwd: root });
	cleanups.push(() => fire("session_shutdown", ctx));
	await fire("session_start", ctx);
	const { record, token } = await readRecord("s2");

	await fire("agent_start", ctx);
	expect((await statusOf(record, token)).status).toBe("busy");

	await fire("agent_end", ctx, { willContinue: true });
	expect((await statusOf(record, token)).status).toBe("busy");

	await fire("agent_end", ctx, { willContinue: false });
	expect((await statusOf(record, token)).status).toBe("idle");

	await fire("tool_approval_requested", ctx);
	expect((await statusOf(record, token)).status).toBe("waiting");

	await fire("tool_approval_resolved", ctx);
	expect((await statusOf(record, token)).status).toBe("busy");
});

test("heartbeat rewrites the record when status changes", async () => {
	const { root } = setupEnv();
	const { pi } = makePi();
	const ctx = makeCtx("hb", { cwd: root });
	const host = new Host(createOmpLike(pi, "0.0.0-test"));
	cleanups.push(async () => {
		host.shutdownSync();
	});
	await host.publish(ctx);

	const idle = await readRecord("hb");
	expect(idle.record.status).toBe("idle");
	expect(idle.record.agentVersion).toBe("unknown");
	expect(idle.record.extensionVersion).toBe("0.0.0-test");

	ctx.setIdle(false);
	host.agentStart(ctx);
	await host.heartbeat();
	expect((await readRecord("hb")).record.status).toBe("busy");

	ctx.setIdle(true);
	host.agentEnd(ctx, { willContinue: false });
	await host.heartbeat();
	expect((await readRecord("hb")).record.status).toBe("idle");
});

test("session_switch rotates instanceId and token and removes the old record", async () => {
	const { root } = setupEnv();
	const { pi, fire } = makePi();
	factory(pi);
	const first = makeCtx("s3", { cwd: root });
	cleanups.push(() => fire("session_shutdown", first));
	await fire("session_start", first);
	const dirs = resolveDirs();
	const oldRecordPath = join(dirs.sessionsDir, "omp-s3.json");
	const old = await readRecord("s3");
	const oldTokenPath = join(dirs.sessionsDir, String(old.record.tokenFile));

	const second = makeCtx("s4", { cwd: root });
	await fire("session_switch", second);

	expect(existsSync(oldRecordPath)).toBe(false);
	expect(existsSync(oldTokenPath)).toBe(false);
	const next = await readRecord("s4");
	expect(next.record.instanceId).not.toBe(old.record.instanceId);
	expect(next.token).not.toBe(old.token);
	expect(next.record.instanceId).toBeTypeOf("string");
	const files = await readdir(dirs.sessionsDir);
	expect(files).toEqual(["omp-s4.json", "omp-s4.token"]);
});

test("session_shutdown removes the record and token synchronously", async () => {
	const { root } = setupEnv();
	const { pi, fire } = makePi();
	factory(pi);
	const ctx = makeCtx("s5", { cwd: root });
	await fire("session_start", ctx);
	const dirs = resolveDirs();
	const recordPath = join(dirs.sessionsDir, "omp-s5.json");
	const tokenPath = join(dirs.sessionsDir, "omp-s5.token");
	expect(existsSync(recordPath)).toBe(true);
	expect(existsSync(tokenPath)).toBe(true);

	await fire("session_shutdown", ctx);

	expect(existsSync(recordPath)).toBe(false);
	expect(existsSync(tokenPath)).toBe(false);
	expect(ctx.statusCalls.at(-1)).toEqual(["agentbridge", undefined]);
	expect(ctx.clearedTimers.length).toBe(1);
});

test("callback failures are contained and reported once", async () => {
	const { root, dirs } = setupEnv();
	const { pi, fire } = makePi();
	factory(pi);
	const ctx = makeCtx("s6", { cwd: root, setStatusThrows: true });
	cleanups.push(() => fire("session_shutdown", ctx));

	await fire("session_start", ctx);
	expect(existsSync(join(dirs.sessionsDir, "omp-s6.json"))).toBe(true);

	// The managed timer wrapper must not throw even if the UI keeps failing.
	expect(() => ctx.intervals[0]?.callback()).not.toThrow();

	const broken = makeCtx("s7", { cwd: root });
	(broken.sessionManager as { getSessionId(): string }).getSessionId = () => {
		throw new Error("session manager failed");
	};
	await fire("session_start", broken);
	expect(broken.notifications.length).toBe(1);
	expect(broken.notifications[0]?.[1]).toBe("warning");
});

test("command works without config and keeps trust in memory only", async () => {
	const { root, dirs } = setupEnv();
	const { pi, fire, run } = makePi();
	factory(pi);
	const ctx = makeCtx("s8", { cwd: root });
	cleanups.push(() => fire("session_shutdown", ctx));
	await fire("session_start", ctx);

	await run("status", ctx);
	const statusMessage = ctx.notifications.at(-1)?.[0] ?? "";
	expect(statusMessage).toContain("endpoint:");
	expect(statusMessage).toContain("session: s8");
	expect(statusMessage).toContain("project: không được phép");
	expect(statusMessage).toContain("consent: ask");

	await run("trust", ctx);
	expect(ctx.notifications.at(-1)?.[0]).toContain("đã tin phiên này");
	await run("status", ctx);
	expect(ctx.notifications.at(-1)?.[0]).toContain("trusted trong phiên");
	expect(existsSync(join(root, "config.json"))).toBe(false);

	await run("untrust", ctx);
	await run("status", ctx);
	expect(ctx.notifications.at(-1)?.[0]).not.toContain("trusted trong phiên");

	await run("off", ctx);
	expect(existsSync(join(dirs.sessionsDir, "omp-s8.json"))).toBe(false);
	expect(ctx.statusCalls.at(-1)).toEqual(["agentbridge", undefined]);

	await run("on", ctx);
	const { record } = await readRecord("s8");
	expect(record.sessionId).toBe("s8");
});

test("status policy reflects config and request count", async () => {
	const { root, dirs } = setupEnv();
	const expectedCwd = await realpath(root);
	writeFileSync(
		process.env.AGENTBRIDGE_CONFIG as string,
		JSON.stringify({ version: 1, projects: [expectedCwd], consult: { consent: "session" } }),
	);
	const { pi, fire, run } = makePi();
	factory(pi);
	const ctx = makeCtx("s9", { cwd: root });
	cleanups.push(() => fire("session_shutdown", ctx));
	await fire("session_start", ctx);

	const { record, token } = await readRecord("s9");
	const status = await statusOf(record, token);
	expect(status.policy).toEqual({ projectAllowed: true, consultConsent: "session" });

	await run("status", ctx);
	expect(ctx.notifications.at(-1)?.[0]).toContain("request: 1");
	expect(ctx.notifications.at(-1)?.[0]).toContain("project: được phép");

	expect(record.tokenFile).toBe("omp-s9.token");
	void dirs;
});

test("self-target consult and chat are denied before consent", async () => {
	const { root } = setupEnv();
	const expectedCwd = await realpath(root);
	writeFileSync(
		process.env.AGENTBRIDGE_CONFIG as string,
		JSON.stringify({
			version: 1,
			projects: [expectedCwd],
			consult: { consent: "always" },
			chat: { enabled: true },
		}),
	);

	const selectCalls: string[] = [];
	const runCalls: unknown[] = [];
	const sent: string[] = [];
	const base = makeCtx("self-target", { cwd: root });
	const ctx: OmpContextLike = {
		...base,
		ui: {
			setStatus() {
				// Not asserted.
			},
			notify() {
				// Not asserted.
			},
			async select(title) {
				selectCalls.push(title);
				return "Gửi";
			},
		},
		async runEphemeralTurn(options) {
			runCalls.push(options);
			return { replyText: "must not run" };
		},
	};
	const pi: PiLike = {
		on() {
			// Host is driven directly by this test.
		},
		registerCommand() {
			// No command surface needed.
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	};
	const host = new Host(createOmpLike(pi, "test"), {
		selfPid: 1234,
		readParentPid: async (pid) => {
			if (pid === 1234) return 1000;
			if (pid === 4321) return 1234;
			if (pid === 5555) return 1111;
			return undefined;
		},
	});
	cleanups.push(async () => {
		host.shutdownSync();
	});
	await host.publish(ctx);

	const { record, token } = await readRecord("self-target");
	const endpoint = String(record.endpoint);
	const to: Peer = {
		agent: "omp",
		sessionId: String(record.sessionId),
		instanceId: String(record.instanceId),
	};
	const from: Peer = { agent: "claude-code", sessionId: "caller-session", pid: 1234 };

	// Status is intentionally outside the self-target rule.
	const status = await request({
		endpoint,
		token,
		from,
		to,
		type: "status",
		body: {},
		timeoutMs: 2_000,
	});
	// The IPC client returns `unknown`; this test requested a status envelope.
	const statusResult = status.result as StatusResult;
	expect(statusResult.sessionId).toBe("self-target");

	const consultSelf = await request({
		endpoint,
		token,
		from,
		to,
		type: "consult",
		body: { question: "hello" },
		timeoutMs: 2_000,
	}).catch((error: unknown) => error);
	expect(consultSelf).toBeInstanceOf(ProtocolError);
	if (consultSelf instanceof ProtocolError) {
		expect(consultSelf.code).toBe("denied");
		expect(consultSelf.details).toEqual({ reason: "self_target" });
	}

	const consultDescendant = await request({
		endpoint,
		token,
		from: { ...from, pid: 4321 },
		to,
		type: "consult",
		body: { question: "hello" },
		timeoutMs: 2_000,
	}).catch((error: unknown) => error);
	expect(consultDescendant).toBeInstanceOf(ProtocolError);
	if (consultDescendant instanceof ProtocolError) {
		expect(consultDescendant.code).toBe("denied");
		expect(consultDescendant.details).toEqual({ reason: "self_target" });
	}

	const chatSelf = await request({
		endpoint,
		token,
		from,
		to,
		type: "chat",
		body: { message: "hello", timeoutMs: 500 },
		timeoutMs: 2_000,
	}).catch((error: unknown) => error);
	expect(chatSelf).toBeInstanceOf(ProtocolError);
	if (chatSelf instanceof ProtocolError) {
		expect(chatSelf.code).toBe("denied");
		expect(chatSelf.details).toEqual({ reason: "self_target" });
	}

	expect(selectCalls).toEqual([]);
	expect(runCalls).toEqual([]);
	expect(sent).toEqual([]);
});
