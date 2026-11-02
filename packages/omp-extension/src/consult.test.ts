import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request, resolveDirs } from "@agentbridge/core";
import {
	type ConsultBody,
	type ConsultResult,
	type Peer,
	type ProgressBody,
	ProtocolError,
} from "@agentbridge/protocol";
import factory, {
	createOmpLike,
	type OmpAgentEndLike,
	type OmpContextLike,
	type OmpDialogOptions,
	type OmpEphemeralResult,
	type OmpEphemeralTurnOptions,
	type OmpEventName,
	type OmpEventHandler,
	type OmpSelectItem,
	type PiLike,
} from "./index";
import { ConsultManager, CONSENT_OPTIONS, type ConsultRequest } from "./consult";

interface SelectCall {
	title: string;
	options: OmpSelectItem[];
	dialogOptions?: OmpDialogOptions;
}

type SelectHandler = (
	title: string,
	options: OmpSelectItem[],
	dialogOptions?: OmpDialogOptions,
) => string | undefined | Promise<string | undefined>;
type RunHandler = (options: OmpEphemeralTurnOptions) => OmpEphemeralResult | Promise<OmpEphemeralResult>;

interface WidgetCall {
	key: string;
	/**
	 * What OMP would actually display: string-array widgets are sliced to 10
	 * lines by `extension-ui-controller.ts` before rendering.
	 */
	lines: string[] | undefined;
	/** Lines handed to setWidget, before OMP's cap, to prove we stay inside it. */
	rawLineCount: number | undefined;
	/** Reply lines fed to the widget before this call; 0 before the first delta. */
	fedReplyLines: number;
	placement: string | undefined;
}

interface FakeCtx extends OmpContextLike {
	selectCalls: SelectCall[];
	runCalls: OmpEphemeralTurnOptions[];
	notifications: Array<[string, string | undefined]>;
	widgetCalls: WidgetCall[];
	fedReplyLines: number;
	selectHandler: SelectHandler;
	runHandler: RunHandler;
}

function makeCtx(sessionId: string): FakeCtx {
	const ctx: FakeCtx = {
		ui: {
			setStatus() { },
			notify(message, type) {
				ctx.notifications.push([message, type]);
			},
			async select(title, options, dialogOptions) {
				ctx.selectCalls.push({ title, options, dialogOptions });
				return ctx.selectHandler(title, options, dialogOptions);
			},
			setWidget(key, lines, options) {
				ctx.widgetCalls.push({
					key,
					// OMP 18.14.0 `MAX_WIDGET_LINES = 10`: content.slice(0, 10) then a
					// "... (widget truncated)" notice. Reproduce the slice so tests fail
					// if the newest reply line would be cut off.
					lines: lines === undefined ? undefined : lines.slice(0, 10),
					rawLineCount: lines?.length,
					fedReplyLines: ctx.fedReplyLines,
					placement: options?.placement,
				});
			},
		},
		mode: "tui",
		hasUI: true,
		cwd: process.env.AGENTBRIDGE_CONFIG
			? dirname(process.env.AGENTBRIDGE_CONFIG)
			: process.cwd(),
		agent: { kind: "main" },
		model: { provider: "openai", id: "gpt-test" },
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => true,
		hasPendingMessages: () => false,
		setInterval: () => 1,
		clearTimer: () => undefined,
		async runEphemeralTurn(options) {
			ctx.runCalls.push(options);
			return ctx.runHandler(options);
		},
		selectCalls: [],
		runCalls: [],
		notifications: [],
		widgetCalls: [],
		fedReplyLines: 0,
		selectHandler: () => undefined,
		runHandler: () => ({ replyText: "ok" }),
	};
	return ctx;
}

type CommandHandler = (args: string, ctx: OmpContextLike) => Promise<void> | void;

function makePi(): {
	pi: PiLike;
	handlers: Map<OmpEventName, OmpEventHandler[]>;
	fire(event: OmpEventName, ctx: OmpContextLike, payload?: OmpAgentEndLike): Promise<void>;
	runCommand(args: string, ctx: OmpContextLike): Promise<void>;
} {
	const handlers = new Map<OmpEventName, OmpEventHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const pi: PiLike = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options.handler);
		},
	};
	return {
		pi,
		handlers,
		async fire(event, ctx, payload = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		async runCommand(args, ctx) {
			const handler = commands.get("agentbridge");
			if (handler === undefined) throw new Error("agentbridge command is not registered");
			await handler(args, ctx);
		},
	};
}

interface RecordFile extends Record<string, unknown> {
	endpoint: string;
	sessionId: string;
	instanceId: string;
	tokenFile: string;
}

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const savedEnv = {
	runtime: process.env.AGENTBRIDGE_RUNTIME_DIR,
	state: process.env.AGENTBRIDGE_STATE_DIR,
	config: process.env.AGENTBRIDGE_CONFIG,
	home: process.env.AGENTBRIDGE_HOME,
};

function setupEnv(): { root: string; stateDir: string } {
	const root = mkdtempSync(join(tmpdir(), "agentbridge-consult-test-"));
	roots.push(root);
	process.env.AGENTBRIDGE_HOME = join(root, "home");
	process.env.AGENTBRIDGE_RUNTIME_DIR = join(root, "run");
	process.env.AGENTBRIDGE_STATE_DIR = join(root, "state");
	process.env.AGENTBRIDGE_CONFIG = join(root, "config.json");
	return { root, stateDir: join(root, "state") };
}

interface ConfigOverrides {
	projects?: string[];
	allowFrom?: string[];
	consult?: Record<string, unknown>;
	audit?: Record<string, unknown>;
	ui?: Record<string, unknown>;
}

function writeConfig(root: string, overrides: ConfigOverrides = {}): void {
	const config = {
		version: 1,
		projects: overrides.projects ?? [root],
		allowFrom: overrides.allowFrom ?? ["claude-code"],
		consult: {
			consent: "always",
			consentTimeoutMs: 60_000,
			maxQuestionBytes: 32_768,
			maxAttachmentBytes: 65_536,
			maxContextBytes: 1_048_576,
			replyMaxBytes: 32_768,
			maxTokens: 4_096,
			allowUncapped: false,
			ratePerMinute: 60,
			toolsOff: true,
			...overrides.consult,
		},
		audit: { content: false, maxBytes: 5_242_880, ...overrides.audit },
		ui: {
			liveWidget: true,
			widgetLines: 6,
			widgetHoldMs: 20_000,
			...overrides.ui,
		},
	};
	writeFileSync(process.env.AGENTBRIDGE_CONFIG as string, JSON.stringify(config));
}

async function startHost(
	ctx: OmpContextLike,
): Promise<{
	record: RecordFile;
	token: string;
	fire(event: OmpEventName, ctx: OmpContextLike, payload?: OmpAgentEndLike): Promise<void>;
	runCommand(args: string, ctx: OmpContextLike): Promise<void>;
}> {
	const app = makePi();
	factory(app.pi);
	await app.fire("session_start", ctx);
	const dirs = resolveDirs();
	const sessionId = ctx.sessionManager.getSessionId();
	const record = JSON.parse(
		readFileSync(join(dirs.sessionsDir, `omp-${sessionId}.json`), "utf8"),
	) as RecordFile;
	const token = readFileSync(join(dirs.sessionsDir, record.tokenFile), "utf8").trim();
	cleanups.push(() => app.fire("session_shutdown", ctx));
	return {
		record,
		token,
		fire: (event, eventCtx, payload) => app.fire(event, eventCtx, payload),
		runCommand: (args, commandCtx) => app.runCommand(args, commandCtx),
	};
}

interface ConsultCallOptions {
	onProgress?: (progress: ProgressBody) => void;
	signal?: AbortSignal;
	from?: Peer;
}

async function consult(
	record: RecordFile,
	token: string,
	body: ConsultBody,
	options: ConsultCallOptions = {},
): Promise<ConsultResult> {
	const result = await request({
		endpoint: record.endpoint,
		token,
		from: options.from ?? { agent: "claude-code", sessionId: "caller-session-abcdef" },
		to: { agent: "omp", sessionId: record.sessionId, instanceId: record.instanceId },
		type: "consult",
		body,
		onProgress: options.onProgress,
		signal: options.signal,
		timeoutMs: 5_000,
	});
	return result.result as ConsultResult;
}

async function consultError(
	record: RecordFile,
	token: string,
	body: ConsultBody,
	options: ConsultCallOptions = {},
): Promise<ProtocolError> {
	try {
		await consult(record, token, body, options);
	} catch (error) {
		if (error instanceof ProtocolError) return error;
		throw error;
	}
	throw new Error("expected the consult to fail");
}

function auditLines(stateDir: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(join(stateDir, "audit.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function auditText(stateDir: string): string {
	try {
		return readFileSync(join(stateDir, "audit.jsonl"), "utf8");
	} catch {
		return "";
	}
}

/**
 * Poll until `predicate` holds. The widget throttle/hold use real timers, so
 * these tests wait on the observed state instead of a fixed sleep.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
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
	const names = [
		"AGENTBRIDGE_RUNTIME_DIR",
		"AGENTBRIDGE_STATE_DIR",
		"AGENTBRIDGE_CONFIG",
		"AGENTBRIDGE_HOME",
	] as const;
	const values = [savedEnv.runtime, savedEnv.state, savedEnv.config, savedEnv.home];
	for (let index = 0; index < names.length; index += 1) {
		const name = names[index];
		const value = values[index];
		if (name === undefined) continue;
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

test("happy path streams deltas, passes limits, and audits metadata only", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root, { consult: { maxContextBytes: 12_345, replyMaxBytes: 1_000, maxTokens: 100 } });
	const ctx = makeCtx("omp-happy");
	const replies = ["Xin chào\n", "bạn khỏe?\n"];
	ctx.runHandler = async (options) => {
		for (const delta of replies) await options.onTextDelta?.(delta);
		return { replyText: replies.join(""), assistantMessage: { usage: { input: 10, output: 2 } } };
	};
	const { record, token } = await startHost(ctx);
	const progress: ProgressBody[] = [];

	const result = await consult(
		record,
		token,
		{
			question: "Vì sao test flaky?",
			attachments: [{ path: "src/a.ts", startLine: 1, endLine: 2, text: "const a = 1;" }],
			stream: true,
			limits: { maxTokens: 50, replyMaxBytes: 500 },
		},
		{ onProgress: (value) => progress.push(value) },
	);

	expect(result.replyText).toBe(replies.join(""));
	expect(result.truncated).toBe(false);
	expect(result.capped).toBe(true);
	expect(result.model).toEqual({ provider: "openai", id: "gpt-test" });
	expect(result.usage).toEqual({ input: 10, output: 2 });
	expect(result.durationMs).toBeGreaterThanOrEqual(0);
	expect(progress.map((item) => item.phase)).toEqual(["running", "delta", "delta"]);
	expect(progress.filter((item) => item.phase === "delta").map((item) => item.delta)).toEqual(replies);

	expect(ctx.runCalls.length).toBe(1);
	const options = ctx.runCalls[0];
	expect(options).toBeDefined();
	expect(options?.tools).toBe(false);
	expect(options?.maxContextBytes).toBe(12_345);
	expect(options?.maxTokens).toBe(50);
	expect(options?.replyMaxBytes).toBe(500);
	expect(options?.dedupeReply).toBe(true);
	expect(options?.signal).toBeInstanceOf(AbortSignal);
	expect(options?.promptText).toContain("Vì sao test flaky?");
	expect(options?.promptText).toContain("### src/a.ts:1-2");

	const audits = auditLines(stateDir);
	expect(audits.length).toBe(1);
	const entry = audits[0] ?? {};
	expect(entry.event).toBe("consult");
	expect(entry.outcome).toBe("ok");
	expect(entry.from).toEqual({ agent: "claude-code", sessionId: "caller-session-abcdef" });
	expect(entry.to).toEqual({ sessionId: "omp-happy" });
	expect(entry.questionBytes).toBeGreaterThan(0);
	expect(entry.replyBytes).toBeGreaterThan(0);
	expect(entry.usage).toEqual({ input: 10, output: 2 });
	expect(auditText(stateDir)).not.toContain("Vì sao test flaky?");
	expect(auditText(stateDir)).not.toContain("Xin chào");
});

test("consent deny shows call context and returns denied", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root, { consult: { consent: "ask", consentTimeoutMs: 1_234 } });
	const ctx = makeCtx("omp-deny");
	ctx.selectHandler = () => "Từ chối";
	const { record, token } = await startHost(ctx);
	const progress: ProgressBody[] = [];
	const longQuestion = "a".repeat(350);

	const error = await consultError(
		record,
		token,
		{ question: longQuestion, attachments: [{ path: "x.ts", text: "x" }] },
		{ onProgress: (value) => progress.push(value) },
	);

	expect(error.code).toBe("denied");
	expect(ctx.runCalls.length).toBe(0);
	expect(progress.map((item) => item.phase)).toEqual(["awaiting_consent"]);
	expect(ctx.selectCalls.length).toBe(1);
	const call = ctx.selectCalls[0];
	expect(call?.options).toEqual([...CONSENT_OPTIONS]);
	expect(call?.dialogOptions?.timeout).toBe(1_234);
	expect(call?.dialogOptions?.signal).toBeInstanceOf(AbortSignal);
	expect(call?.title).toContain(`${"a".repeat(300)}…`);
	expect(call?.title).toContain("Đính kèm: 1");
	expect(call?.title).toContain("caller session: caller-session-abcdef");

	const audits = auditLines(stateDir);
	expect(audits.at(-1)?.event).toBe("denied");
	expect(audits.at(-1)?.outcome).toBe("denied");
});

test("consent timeout returns consent_timeout", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root, { consult: { consent: "ask" } });
	const ctx = makeCtx("omp-timeout");
	ctx.selectHandler = () => undefined;
	const { record, token } = await startHost(ctx);

	const error = await consultError(record, token, { question: "timeout?" });

	expect(error.code).toBe("consent_timeout");
	expect(ctx.runCalls.length).toBe(0);
	expect(auditLines(stateDir).at(-1)?.outcome).toBe("consent_timeout");
});

test("consent 'session' asks once and remembers the grant", async () => {
	const { root } = setupEnv();
	writeConfig(root, { consult: { consent: "session" } });
	const ctx = makeCtx("omp-session");
	ctx.selectHandler = () => CONSENT_OPTIONS[1] ?? "Cho phép trong phiên này";
	const { record, token } = await startHost(ctx);

	const first = await consult(record, token, { question: "first?" });
	const second = await consult(record, token, { question: "second?" });

	expect(first.replyText).toBe("ok");
	expect(second.replyText).toBe("ok");
	expect(ctx.selectCalls.length).toBe(1);
	expect(ctx.runCalls.length).toBe(2);
});

test("project_not_allowed is denied before consent", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root, { projects: [] });
	const ctx = makeCtx("omp-project");
	const { record, token } = await startHost(ctx);

	const error = await consultError(record, token, { question: "allowed?" });

	expect(error.code).toBe("project_not_allowed");
	expect(ctx.selectCalls.length).toBe(0);
	expect(ctx.runCalls.length).toBe(0);
	expect(auditLines(stateDir).at(-1)?.event).toBe("denied");
	expect(auditLines(stateDir).at(-1)?.outcome).toBe("project_not_allowed");
});

test("a second consult while one runs returns busy_limit", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-busy");
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	ctx.runHandler = async () => {
		started?.();
		await gate;
		return { replyText: "done" };
	};
	const { record, token } = await startHost(ctx);

	const first = consult(record, token, { question: "first" });
	await running;
	const error = await consultError(record, token, { question: "second" });
	release?.();
	expect((await first).replyText).toBe("done");
	expect(error.code).toBe("busy_limit");
});

test("rate_limited after the token bucket is empty", async () => {
	const { root } = setupEnv();
	writeConfig(root, { consult: { ratePerMinute: 1 } });
	const ctx = makeCtx("omp-rate");
	const { record, token } = await startHost(ctx);

	expect((await consult(record, token, { question: "one" })).replyText).toBe("ok");
	const error = await consultError(record, token, { question: "two" });
	expect(error.code).toBe("rate_limited");
});

test("too_large checks attachments before consent", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root, { consult: { maxAttachmentBytes: 8 } });
	const ctx = makeCtx("omp-large");
	const { record, token } = await startHost(ctx);

	const error = await consultError(record, token, {
		question: "big?",
		attachments: [{ path: "big.txt", text: "123456789" }],
	});

	expect(error.code).toBe("too_large");
	expect(ctx.selectCalls.length).toBe(0);
	expect(ctx.runCalls.length).toBe(0);
	expect(auditLines(stateDir).at(-1)?.outcome).toBe("too_large");
});

test("maxTokens rejection maps to max_tokens_unsupported when retry is disabled", async () => {
	const { root } = setupEnv();
	writeConfig(root, { consult: { maxTokens: 100, allowUncapped: false } });
	const ctx = makeCtx("omp-capped");
	ctx.runHandler = () => {
		throw new Error("Model openai/gpt does not support maxTokens for ephemeral turns. Omit the cap.");
	};
	const { record, token } = await startHost(ctx);

	const error = await consultError(record, token, { question: "cap?" });

	expect(error.code).toBe("max_tokens_unsupported");
	expect(ctx.runCalls.length).toBe(1);
	expect(ctx.runCalls[0]?.maxTokens).toBe(100);
});

test("allowUncapped retries once without maxTokens and reports capped=false", async () => {
	const { root } = setupEnv();
	writeConfig(root, { consult: { maxTokens: 100, allowUncapped: true, maxContextBytes: 2_048 } });
	const ctx = makeCtx("omp-uncapped");
	ctx.runHandler = (options) => {
		if (options.maxTokens !== undefined) {
			throw new Error("Model openai/gpt does not support maxTokens for ephemeral turns.");
		}
		return { replyText: "uncapped", assistantMessage: { usage: { output: 1 } } };
	};
	const { record, token } = await startHost(ctx);

	const result = await consult(record, token, { question: "cap?" });

	expect(result.replyText).toBe("uncapped");
	expect(result.capped).toBe(false);
	expect(ctx.runCalls.length).toBe(2);
	expect(ctx.runCalls[0]?.maxTokens).toBe(100);
	expect("maxTokens" in (ctx.runCalls[1] ?? {})).toBe(false);
	expect(ctx.runCalls[1]?.maxContextBytes).toBe(2_048);
});

test("session/model change maps to model_changed", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-model");
	ctx.runHandler = () => {
		throw new Error("Active model changed during ephemeral turn; retry.");
	};
	const { record, token } = await startHost(ctx);

	const error = await consultError(record, token, { question: "model?" });
	expect(error.code).toBe("model_changed");
});

test("abort reaches the fake turn's signal and is audited as cancelled", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-abort");
	const controller = new AbortController();
	let started: (() => void) | undefined;
	let aborted: (() => void) | undefined;
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	const observed = new Promise<void>((resolve) => {
		aborted = resolve;
	});
	ctx.runHandler = (options) =>
		new Promise<OmpEphemeralResult>((_resolve, reject) => {
			started?.();
			options.signal?.addEventListener("abort", () => {
				aborted?.();
				reject(new Error("aborted"));
			});
		});
	const manager = new ConsultManager(createOmpLike(makePi().pi, "test"));
	const pending = manager.handle({
		ctx,
		sessionId: "omp-abort",
		project: root,
		requestId: "abort-request",
		from: { agent: "claude-code", sessionId: "caller" },
		body: { question: "abort?" },
		signal: controller.signal,
		isTrusted: () => true,
		trustSession: () => undefined,
		sendProgress: () => undefined,
	});
	await running;

	controller.abort();
	await observed;
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	expect(ctx.runCalls[0]?.signal?.aborted).toBe(true);
	expect(auditLines(stateDir).at(-1)?.outcome).toBe("cancelled");
});

test("secret reply is redacted and audit content stays off by default", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root);
	const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
	const questionSecret = "password = supersecretvalue123";
	const ctx = makeCtx("omp-redact");
	ctx.runHandler = () => ({ replyText: `token ${secret}` });
	const { record, token } = await startHost(ctx);

	const result = await consult(record, token, { question: `Dùng ${questionSecret} được không?` });

	expect(result.replyText).toContain("[REDACTED:openai_key]");
	expect(result.replyText).not.toContain(secret);
	const raw = auditText(stateDir);
	expect(raw).not.toContain(secret);
	expect(raw).not.toContain(questionSecret);
	expect(raw).not.toContain("supersecretvalue123");
});

test("audit.content=true stores redacted question and reply", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root, { audit: { content: true } });
	const ctx = makeCtx("omp-audit-content");
	ctx.runHandler = () => ({ replyText: "api_key = abcdefghijklmnop" });
	const { record, token } = await startHost(ctx);

	await consult(record, token, { question: "password = my-secret-value" });

	const entry = auditLines(stateDir).at(-1) ?? {};
	expect(String(entry.question)).toContain("[REDACTED:secret]");
	expect(String(entry.reply)).toContain("[REDACTED:secret]");
	expect(String(entry.question)).not.toContain("my-secret-value");
	expect(String(entry.reply)).not.toContain("abcdefghijklmnop");
});

test("auth failures append an auth_fail audit line without the token", async () => {
	const { root, stateDir } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-auth");
	const { record, token } = await startHost(ctx);

	await expect(
		request({
			endpoint: record.endpoint,
			token: "wrong-token",
			from: { agent: "claude-code", sessionId: "intruder" },
			to: { agent: "omp", sessionId: record.sessionId, instanceId: record.instanceId },
			type: "status",
			body: {},
			timeoutMs: 2_000,
		}),
	).rejects.toMatchObject({ code: "unauthorized" });

	await waitFor(
		() => auditLines(stateDir).some((entry) => entry.event === "auth_fail"),
		"the auth_fail audit line",
	);
	expect(auditText(stateDir)).not.toContain(token);
	expect(token.length).toBeGreaterThan(20);
});

test("ConsultManager rejects a duplicate request id before loading policy", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-dedupe");
	const manager = new ConsultManager(createOmpLike(makePi().pi, "test"));
	const requestBase: ConsultRequest = {
		ctx,
		sessionId: "omp-dedupe",
		project: root,
		requestId: "duplicate-id",
		from: { agent: "claude-code", sessionId: "caller" },
		body: { question: "same id" },
		signal: new AbortController().signal,
		isTrusted: () => true,
		trustSession: () => undefined,
		sendProgress: () => undefined,
	};

	expect((await manager.handle(requestBase)).replyText).toBe("ok");
	await expect(manager.handle(requestBase)).rejects.toMatchObject({ code: "duplicate" });
});

test("streaming redacts a secret split across two deltas", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const secret = "sk-abcdef123456";
	const ctx = makeCtx("omp-stream-secret");
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.("api_key=");
		await options.onTextDelta?.(`${secret}\n`);
		await options.onTextDelta?.("dư cuối");
		return { replyText: `api_key=${secret}\ndư cuối` };
	};
	const { record, token } = await startHost(ctx);
	const progress: ProgressBody[] = [];

	const result = await consult(
		record,
		token,
		{ question: "stream?", stream: true },
		{ onProgress: (value) => progress.push(value) },
	);

	const deltas = progress.filter((item) => item.phase === "delta").map((item) => item.delta ?? "");
	expect(deltas).toEqual(["api_key=[REDACTED:secret]\n"]);
	expect(deltas.join("")).not.toContain(secret);
	expect(deltas.join("")).not.toContain("dư cuối");
	expect(result.replyText).toBe("api_key=[REDACTED:secret]\ndư cuối");
	expect(result.replyText).not.toContain(secret);
});

test("a PEM header stops delta streaming but the result stays complete", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const dashes = "-".repeat(5);
	const begin = `${dashes}BEGIN RSA PRIVATE KEY${dashes}`;
	const end = `${dashes}END RSA PRIVATE KEY${dashes}`;
	const keyBody = "MIIEowIBAAKCAQEA1234567890";
	const pem = [begin, keyBody, end].join("\n");
	const ctx = makeCtx("omp-stream-pem");
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.("trước\n");
		await options.onTextDelta?.(`${pem}\n`);
		await options.onTextDelta?.("sau\n");
		return { replyText: `trước\n${pem}\nsau\n` };
	};
	const { record, token } = await startHost(ctx);
	const progress: ProgressBody[] = [];

	const result = await consult(
		record,
		token,
		{ question: "pem?", stream: true },
		{ onProgress: (value) => progress.push(value) },
	);

	const deltas = progress.filter((item) => item.phase === "delta").map((item) => item.delta ?? "");
	expect(deltas).toEqual(["trước\n"]);
	expect(deltas.join("")).not.toContain(keyBody);
	expect(result.replyText).toBe(`trước\n[REDACTED:private_key]\nsau\n`);
});

test("an overlong unterminated delta flushes redacted up to the last whitespace", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-stream-long");
	const streamed = `password=supersecretvalue123 ${"word ".repeat(1_000)}`;
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.(streamed);
		return { replyText: "done" };
	};
	const { record, token } = await startHost(ctx);
	const progress: ProgressBody[] = [];

	await consult(
		record,
		token,
		{ question: "long?", stream: true },
		{ onProgress: (value) => progress.push(value) },
	);

	const deltas = progress.filter((item) => item.phase === "delta").map((item) => item.delta ?? "");
	expect(deltas.length).toBe(1);
	expect(deltas[0]?.startsWith("password=[REDACTED:secret] word ")).toBe(true);
	expect(deltas[0]?.endsWith(" ")).toBe(true);
	expect(deltas.join("")).not.toContain("supersecretvalue123");
});

test("consent dialog sanitizes controls, bidi, blank lines, line count and caller session", async () => {
	const { root } = setupEnv();
	writeConfig(root, { consult: { consent: "ask" } });
	const ctx = makeCtx("omp-consent-clean");
	ctx.selectHandler = () => "Từ chối";
	const { record, token } = await startHost(ctx);
	const manyLines = Array.from({ length: 20 }, (_, index) => `line${index + 1}`).join("\n");
	const question = `A\x1b[2J\u202eB\u0085${"\n".repeat(50)}${manyLines}`;
	const callerSession = "sess\u202eion\x1b[2J-1";

	const error = await consultError(
		record,
		token,
		{ question },
		{ from: { agent: "claude-code", sessionId: callerSession } },
	);

	expect(error.code).toBe("denied");
	const title = ctx.selectCalls[0]?.title ?? "";
	expect(title).not.toContain("\x1b");
	expect(title).not.toContain("\u202e");
	expect(title).not.toContain("\u0085");
	expect(title).toContain("AB");
	expect(title).not.toMatch(/\n{3,}/);
	expect(title).toContain("line6");
	expect(title).not.toContain("line7");
	expect(title).toContain("caller session: session-1");
});

test("live widget shows the consult, throttles updates, finishes and clears after the hold", async () => {
	const { root } = setupEnv();
	writeConfig(root, { ui: { widgetHoldMs: 60, widgetLines: 5 } });
	const ctx = makeCtx("omp-widget");
	const gate = Promise.withResolvers<void>();
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.("dòng một\n");
		await options.onTextDelta?.("dòng hai\n");
		await gate.promise;
		return { replyText: "dòng một\ndòng hai\n" };
	};
	const app = await startHost(ctx);
	const pending = consult(app.record, app.token, { question: "Vì sao widget?" });

	await waitFor(
		() => ctx.widgetCalls.some((call) => call.lines?.join("\n").includes("dòng hai")),
		"the throttled widget update",
	);
	const streamingCalls = ctx.widgetCalls.filter((call) => call.lines !== undefined);
	expect(streamingCalls.length).toBe(2);
	const first = streamingCalls[0]?.lines ?? [];
	expect(first[0]).toContain("◆ AgentBridge · Claude đang hỏi");
	expect(first[0]).toContain("caller-session-abcdef");
	expect(first.join("\n")).toContain("Vì sao widget?");
	for (const call of streamingCalls) {
		expect(call.key).toBe("agentbridge");
		expect(call.placement).toBe("aboveEditor");
	}

	gate.resolve();
	await pending;
	const final = ctx.widgetCalls.filter((call) => call.lines !== undefined).at(-1)?.lines ?? [];
	expect(final[0]).toContain("✓ đã trả lời Claude (");
	expect(final.join("\n")).toContain("dòng hai");

	await waitFor(
		() => ctx.widgetCalls.at(-1)?.lines === undefined,
		"the widget to clear after the hold",
	);
});

test("widget fits OMP's 10-line cap and always keeps the newest reply line", async () => {
	const { root } = setupEnv();
	writeConfig(root, { ui: { widgetHoldMs: 5 } });
	const ctx = makeCtx("omp-widget-cap");
	const question = "Câu hỏi rất dài\nchi tiết một\nchi tiết hai\nchi tiết ba\nchi tiết bốn";
	const replyLines = Array.from({ length: 30 }, (_, index) => `reply-${index + 1}`);
	ctx.runHandler = async (options) => {
		for (const [index, line] of replyLines.entries()) {
			// Count before feeding: the fake's snapshot then proves the widget already
			// holds the line whose push triggered the render.
			ctx.fedReplyLines += 1;
			await options.onTextDelta?.(`${line}\n`);
			if (index === 9) {
				// Cross the 200ms throttle while the tail is full.
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
			}
		}
		return { replyText: replyLines.join("\n") };
	};
	const app = await startHost(ctx);

	await consult(app.record, app.token, { question });

	const rendered = ctx.widgetCalls.filter((call) => call.lines !== undefined);
	expect(rendered.length).toBeGreaterThanOrEqual(3);
	for (const call of rendered) {
		const lines = call.lines ?? [];
		expect(call.rawLineCount ?? 0).toBeLessThanOrEqual(10);
		expect(lines.length).toBeLessThanOrEqual(10);
		if (call.fedReplyLines > 0) {
			expect(lines.join("\n")).toContain(`reply-${call.fedReplyLines}`);
		}
	}

	const midStream = rendered.find((call) => call.fedReplyLines >= 10 && call.fedReplyLines < 30);
	expect(midStream).toBeDefined();
	expect(midStream?.lines?.length).toBe(10);
	expect(midStream?.lines?.[0]).toContain("◆ AgentBridge · Claude đang hỏi");
	expect(midStream?.lines?.[1]).toContain("Câu hỏi rất dài");
	expect(midStream?.lines?.[2]).toContain("chi tiết một");
	expect(midStream?.lines?.[3]).toBe("─".repeat(40));
	expect(midStream?.lines?.[4]).toContain("reply-5");

	const last = rendered.at(-1);
	expect(last?.lines?.length).toBeLessThanOrEqual(10);
	expect(last?.lines?.join("\n")).toContain("reply-30");
	expect(last?.lines?.[0]).toContain("✓ đã trả lời Claude (");
});

test("widget streams redacted deltas even when the client did not request streaming", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
	const ctx = makeCtx("omp-widget-secret");
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.("api_key=");
		await options.onTextDelta?.(`${secret}\n`);
		return { replyText: `api_key=${secret}\n` };
	};
	const app = await startHost(ctx);
	const progress: ProgressBody[] = [];

	const result = await consult(
		app.record,
		app.token,
		{ question: "có stream không?" },
		{ onProgress: (value) => progress.push(value) },
	);

	expect(result.replyText).not.toContain(secret);
	expect(progress.every((item) => item.phase !== "delta")).toBe(true);
	const widgetText = ctx.widgetCalls
		.map((call) => call.lines?.join("\n") ?? "")
		.join("\n");
	expect(widgetText).not.toContain(secret);
	expect(widgetText).toContain("[REDACTED:secret]");
});

test("widget sanitizes ANSI, C0/C1 and bidi in question, caller and reply", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-widget-clean");
	const question = "Q\x1b[2J\u202eX\nline2\nline3\nline4\nline5";
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.("A\x1b[31mB\x1b[0m\u202eC\u0085D\n");
		return { replyText: "ok" };
	};
	const app = await startHost(ctx);

	await consult(
		app.record,
		app.token,
		{ question },
		{ from: { agent: "claude-code", sessionId: "sess\x1b[2J\u202e-1" } },
	);

	const widgetText = ctx.widgetCalls
		.map((call) => call.lines?.join("\n") ?? "")
		.join("\n");
	expect(widgetText).not.toContain("\x1b");
	expect(widgetText).not.toContain("\u202e");
	expect(widgetText).not.toContain("\u0085");
	expect(widgetText).not.toContain("[2J");
	expect(widgetText).toContain("QX");
	expect(widgetText).toContain("sess-1");
	expect(widgetText).toContain("ABCD");
	expect(widgetText).not.toContain("line5");
});

test("a throwing setWidget does not fail the consult", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-widget-throw");
	ctx.ui.setWidget = () => {
		throw new Error("ui broke");
	};
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.("vẫn chạy\n");
		return { replyText: "vẫn chạy" };
	};
	const app = await startHost(ctx);

	const result = await consult(app.record, app.token, { question: "throw?" });
	expect(result.replyText).toBe("vẫn chạy");
});

test("a missing setWidget does not fail the consult", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-widget-missing");
	delete ctx.ui.setWidget;
	ctx.runHandler = () => ({ replyText: "không widget" });
	const app = await startHost(ctx);

	const result = await consult(app.record, app.token, { question: "missing?" });
	expect(result.replyText).toBe("không widget");
});

test("liveWidget=false keeps the old behavior and never calls setWidget", async () => {
	const { root } = setupEnv();
	writeConfig(root, { ui: { liveWidget: false } });
	const ctx = makeCtx("omp-widget-off");
	ctx.runHandler = async (options) => {
		await options.onTextDelta?.("không hiện\n");
		return { replyText: "không hiện" };
	};
	const app = await startHost(ctx);

	const result = await consult(app.record, app.token, { question: "off?" });
	expect(result.replyText).toBe("không hiện");
	expect(ctx.widgetCalls.length).toBe(0);
	expect(ctx.runCalls[0]?.onTextDelta).toBeUndefined();
});

test("widget is cleared by shutdown, session switch, /agentbridge off and clear", async () => {
	const { root } = setupEnv();
	writeConfig(root);

	const runConsult = async (sessionId: string) => {
		const ctx = makeCtx(sessionId);
		const app = await startHost(ctx);
		await consult(app.record, app.token, { question: `clear ${sessionId}` });
		expect(ctx.widgetCalls.some((call) => call.lines !== undefined)).toBe(true);
		return { ctx, app };
	};

	const shutdown = await runConsult("omp-widget-shutdown");
	await shutdown.app.fire("session_shutdown", shutdown.ctx);
	expect(shutdown.ctx.widgetCalls.at(-1)?.lines).toBeUndefined();

	const switched = await runConsult("omp-widget-switch");
	await switched.app.fire("session_switch", switched.ctx);
	expect(switched.ctx.widgetCalls.at(-1)?.lines).toBeUndefined();

	const off = await runConsult("omp-widget-off-cmd");
	await off.app.runCommand("off", off.ctx);
	expect(off.ctx.widgetCalls.at(-1)?.lines).toBeUndefined();

	const cleared = await runConsult("omp-widget-clear");
	await cleared.app.runCommand("clear", cleared.ctx);
	expect(cleared.ctx.widgetCalls.at(-1)?.lines).toBeUndefined();
	expect(cleared.ctx.notifications.at(-1)?.[0]).toContain("đã xoá widget");
});

test("a new consult replaces the previous widget", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-widget-replace");
	const app = await startHost(ctx);

	await consult(app.record, app.token, { question: "câu hỏi cũ" });
	await consult(app.record, app.token, { question: "câu hỏi mới" });

	const last = ctx.widgetCalls.filter((call) => call.lines !== undefined).at(-1)?.lines ?? [];
	expect(last.join("\n")).toContain("câu hỏi mới");
	expect(last.join("\n")).not.toContain("câu hỏi cũ");
	expect(ctx.widgetCalls.some((call) => call.lines === undefined)).toBe(true);
});

test("an unavailable model after the turn is reported as unknown, not internal", async () => {
	const { root } = setupEnv();
	writeConfig(root);
	const ctx = makeCtx("omp-unknown-model");
	ctx.model = undefined;
	ctx.runHandler = () => ({ replyText: "vẫn trả lời" });
	const { record, token } = await startHost(ctx);

	const result = await consult(record, token, { question: "model?" });

	expect(result.replyText).toBe("vẫn trả lời");
	expect(result.model).toEqual({ provider: "unknown", id: "unknown" });
});
