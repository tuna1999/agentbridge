import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, resolveDirs } from "@agentbridge/core";
import type { ChatResult } from "@agentbridge/protocol";
import {
	AUTOCHAT_FLAG,
	AutoChatSession,
	autoConsentReason,
	clampAutoChatLimits,
	type OmpContextLike,
	type OmpSelectItem,
	type OmpTimer,
	readAutoApproveFlag,
	Host,
	createOmpLike,
} from "./index";

interface SelectCall {
	title: string;
	options: OmpSelectItem[];
}

interface Ctx extends OmpContextLike {
	selections: SelectCall[];
	notifications: Array<[string, string | undefined]>;
	statuses: Array<[string, string | undefined]>;
	timers: Set<OmpTimer>;
	timeouts: Array<{ timer: OmpTimer; callback: () => void; ms: number }>;
}

interface Fixture {
	root: string;
	base: string;
	configPath: string;
	stateDir: string;
	ctx: Ctx;
	host: Host;
	sent: string[];
}

const roots: string[] = [];
const savedEnv = {
	runtime: process.env.AGENTBRIDGE_RUNTIME_DIR,
	state: process.env.AGENTBRIDGE_STATE_DIR,
	config: process.env.AGENTBRIDGE_CONFIG,
	home: process.env.AGENTBRIDGE_HOME,
};

function makeCtx(root: string, sessionId = "omp-auto-test"): Ctx {
	const timers = new Set<OmpTimer>();
	const ctx: Ctx = {
		ui: {
			setStatus(key, text) {
				ctx.statuses.push([key, text]);
			},
			notify(message, type) {
				ctx.notifications.push([message, type]);
			},
			async select(title, options) {
				// Act like an operator who reads every page and then sends. Only the
				// first dialog of a request is recorded, so `selections` counts the
				// requests that fell back to manual consent.
				const labels = options.map((option) => (typeof option === "string" ? option : option.label));
				if (!/^Trang \d+\/\d+$/m.test(title)) ctx.selections.push({ title, options });
				if (labels.includes("Gửi")) return "Gửi";
				if (labels.includes("Xem toàn văn")) return "Xem toàn văn";
				return "Trang sau";
			},
		},
		mode: "tui",
		hasUI: true,
		cwd: root,
		agent: { kind: "main" },
		model: { provider: "openai", id: "gpt-test" },
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => true,
		setInterval: () => {
			const timer = { kind: "interval" };
			timers.add(timer);
			return timer;
		},
		setTimeout: (callback, ms) => {
			const delay = ms ?? 0;
			if (delay <= 0) {
				const timer = setTimeout(callback, 0);
				timer.unref?.();
				timers.add(timer);
				return timer;
			}
			const timer = { kind: "timeout", ms };
			timers.add(timer);
			ctx.timeouts.push({ timer, callback: callback as () => void, ms: delay });
			return timer;
		},
		clearTimer: (timer) => {
			timers.delete(timer);
			ctx.timeouts = ctx.timeouts.filter((entry) => entry.timer !== timer);
			if (typeof timer === "object" && timer !== null && "hasRef" in timer) {
				clearTimeout(timer as ReturnType<typeof setTimeout>);
			}
		},
		selections: [],
		notifications: [],
		statuses: [],
		timers,
		timeouts: [],
	};
	return ctx;
}

function writeConfigFile(
	path: string,
	root: string,
	chat: Record<string, unknown>,
	projects: string[] = [root],
): void {
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			projects,
			allowFrom: ["claude-code"],
			chat: {
				enabled: true,
				queueWhenBusy: false,
				consentTimeoutMs: 5_000,
				...chat,
			},
			audit: { content: false, maxBytes: 5_242_880 },
		}),
		{ mode: 0o600 },
	);
	chmodSync(path, 0o600);
}

function setup(options: {
	chat: Record<string, unknown>;
	configInsideProject?: boolean;
	flag?: string;
	sessionId?: string;
}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agentbridge-auto-project-")));
	const base = realpathSync(mkdtempSync(join(tmpdir(), "agentbridge-auto-config-")));
	roots.push(root, base);
	process.env.AGENTBRIDGE_HOME = join(base, "home");
	process.env.AGENTBRIDGE_RUNTIME_DIR = join(base, "run");
	process.env.AGENTBRIDGE_STATE_DIR = join(base, "state");
	const configPath = options.configInsideProject === true
		? join(root, "config.json")
		: join(base, "config.json");
	process.env.AGENTBRIDGE_CONFIG = configPath;
	writeConfigFile(configPath, root, options.chat);

	const ctx = makeCtx(root, options.sessionId ?? "omp-auto-test");
	const sent: string[] = [];
	let hostRef: Host | undefined;
	const pi = {
		on() {
			// Host is driven directly.
		},
		registerCommand() {
			// Not needed.
		},
		registerFlag() {
			// Registration is tested by index.test.ts.
		},
		getFlag(name: string): string | undefined {
			return name === AUTOCHAT_FLAG ? options.flag : undefined;
		},
		sendUserMessage(content: string) {
			sent.push(content);
			queueMicrotask(() => {
				if (hostRef === undefined) return;
				hostRef.messageStart(ctx, { message: { role: "user", content } });
				hostRef.agentEnd(ctx, {
					willContinue: false,
					messages: [
						{ role: "user", content },
						{
							role: "assistant",
							content: [{ type: "text", text: "đã làm" }],
							stopReason: "stop",
						},
					],
				});
			});
		},
	};
	const host = new Host(createOmpLike(pi, "test"));
	hostRef = host;
	return { root, base, configPath, stateDir: process.env.AGENTBRIDGE_STATE_DIR, ctx, host, sent };
}

async function recordOf(sessionId: string): Promise<Record<string, unknown>> {
	const dirs = resolveDirs();
	return JSON.parse(
		readFileSync(join(dirs.sessionsDir, `omp-${sessionId}.json`), "utf8"),
	) as Record<string, unknown>;
}

async function chat(fixture: Fixture, message = "Tin nhắn kiểm tra"): Promise<ChatResult> {
	const record = await recordOf(fixture.ctx.sessionManager.getSessionId());
	const token = readFileSync(join(resolveDirs().sessionsDir, String(record.tokenFile)), "utf8").trim();
	const result = await request({
		endpoint: String(record.endpoint),
		token,
		from: { agent: "claude-code", sessionId: "caller-session" },
		to: {
			agent: "omp",
			sessionId: String(record.sessionId),
			instanceId: String(record.instanceId),
		},
		type: "chat",
		body: { message, timeoutMs: 5_000 },
		timeoutMs: 5_000,
	});
	return result.result as ChatResult;
}

function audit(fixture: Fixture): Array<Record<string, unknown>> {
	try {
		return readFileSync(join(fixture.stateDir, "audit.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function fireTimeout(fixture: Fixture, ms: number): void {
	const index = fixture.ctx.timeouts.findIndex((entry) => entry.ms === ms);
	if (index < 0) throw new Error(`no ${ms}ms timeout`);
	const [entry] = fixture.ctx.timeouts.splice(index, 1);
	entry?.callback();
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	const values = [savedEnv.runtime, savedEnv.state, savedEnv.config, savedEnv.home];
	const names = [
		"AGENTBRIDGE_RUNTIME_DIR",
		"AGENTBRIDGE_STATE_DIR",
		"AGENTBRIDGE_CONFIG",
		"AGENTBRIDGE_HOME",
	] as const;
	for (let index = 0; index < names.length; index += 1) {
		const name = names[index];
		if (name === undefined) continue;
		const value = values[index];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

test("config outside the project enables autochat and audits auto-config-unlimited", async () => {
	const fixture = setup({ chat: { autoApprove: "unlimited" } });
	try {
		await fixture.host.publish(fixture.ctx);
		const realConfig = realpathSync(fixture.configPath);
		expect(fixture.ctx.notifications).toContainEqual([
			`AgentBridge: autochat unlimited bật từ config ${realConfig}`,
			"info",
		]);
		expect(fixture.ctx.notifications).toContainEqual([
			"Claude có thể gửi tin và khiến OMP chạy tool không cần duyệt; quyền tool của OMP vẫn áp dụng",
			"warning",
		]);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("🔗 bridge · autochat ∞ · 0 tin");

		const result = await chat(fixture);
		expect(result.replyText).toBe("đã làm");
		expect(fixture.sent).toHaveLength(1);
		expect(fixture.ctx.selections).toHaveLength(0);
		expect(fixture.ctx.notifications).toContainEqual([
			"AgentBridge: tự gửi tin từ Claude (1)",
			"info",
		]);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("🔗 bridge · autochat ∞ · 1 tin");
		expect(audit(fixture).at(-1)).toMatchObject({
			event: "chat",
			outcome: "ok",
			consent: "auto-config-unlimited",
		});
	} finally {
		fixture.host.shutdownSync();
	}
});

test("limited config uses auto-config and falls back to manual consent at limits", async () => {
	const fixture = setup({
		chat: {
			autoApprove: "limited",
			autoMaxChars: 100,
			autoMaxMessages: 1,
			autoMinIntervalMs: 2_000,
		},
	});
	try {
		await fixture.host.publish(fixture.ctx);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("🔗 bridge · autochat 0/1");
		await chat(fixture, "tin thứ nhất");
		expect(fixture.ctx.selections).toHaveLength(0);
		expect(fixture.ctx.notifications).toContainEqual([
			"AgentBridge: tự gửi tin từ Claude (1/1)",
			"info",
		]);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("🔗 bridge · autochat 1/1");
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "auto-config" });

		await chat(fixture, "tin thứ hai");
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });
	} finally {
		fixture.host.shutdownSync();
	}
});

test("config inside the project is rejected with the required warning", async () => {
	const fixture = setup({
		chat: { autoApprove: "unlimited" },
		configInsideProject: true,
	});
	try {
		await fixture.host.publish(fixture.ctx);
		const warning = fixture.ctx.notifications.find(([message, type]) =>
			type === "warning" && message.includes("bỏ qua chat.autoApprove")
		);
		expect(warning?.[0]).toContain("config nằm trong project");
		expect(warning?.[0]).toContain("chuyển config ra ngoài project");
		expect(fixture.ctx.statuses.at(-1)?.[1]).not.toContain("autochat");

		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });
	} finally {
		fixture.host.shutdownSync();
	}
});

test("a config under any projects entry is rejected even outside cwd", async () => {
	const fixture = setup({ chat: { autoApprove: "off" } });
	try {
		// The config file is outside cwd but inside the second projects entry.
		writeConfigFile(
			fixture.configPath,
			fixture.root,
			{ autoApprove: "unlimited" },
			[fixture.root, fixture.base],
		);
		utimesSync(fixture.configPath, new Date(), new Date(Date.now() + 1_000));
		await fixture.host.publish(fixture.ctx);
		const warning = fixture.ctx.notifications.find(([message]) =>
			message.includes("bỏ qua chat.autoApprove")
		);
		expect(warning?.[0]).toContain("config nằm trong project");

		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(1);
	} finally {
		fixture.host.shutdownSync();
	}
});

test("a config file without 0600 is rejected and falls back to manual consent", async () => {
	const fixture = setup({ chat: { autoApprove: "unlimited" } });
	try {
		chmodSync(fixture.configPath, 0o644);
		await fixture.host.publish(fixture.ctx);
		const warning = fixture.ctx.notifications.find(([message]) =>
			message.includes("bỏ qua chat.autoApprove")
		);
		expect(warning?.[0]).toContain("0600");
		expect(warning?.[0]).toContain("cùng uid");

		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(1);
	} finally {
		fixture.host.shutdownSync();
	}
});

test("editing autoApprove mid-session does not change the snapshot", async () => {
	const fixture = setup({ chat: { autoApprove: "off" } });
	try {
		await fixture.host.publish(fixture.ctx);
		// Even a republish for a session switch must not re-read autoApprove.
		writeConfigFile(fixture.configPath, fixture.root, { autoApprove: "unlimited" });
		utimesSync(fixture.configPath, new Date(), new Date(Date.now() + 1_000));
		await fixture.host.publish(fixture.ctx, { snapshotAuto: false });

		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });
	} finally {
		fixture.host.shutdownSync();
	}
});

test("editing autoApprove to off mid-session does not disable the snapshot", async () => {
	const fixture = setup({ chat: { autoApprove: "unlimited" } });
	try {
		await fixture.host.publish(fixture.ctx);
		writeConfigFile(fixture.configPath, fixture.root, { autoApprove: "off" });
		utimesSync(fixture.configPath, new Date(), new Date(Date.now() + 1_000));

		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(0);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "auto-config-unlimited" });
	} finally {
		fixture.host.shutdownSync();
	}
});

test("TUI off overrides a CLI flag, and the CLI flag overrides config", async () => {
	const fixture = setup({ chat: { autoApprove: "off" }, flag: "unlimited" });
	try {
		await fixture.host.publish(fixture.ctx);
		expect(fixture.ctx.notifications).toContainEqual([
			"Claude có thể gửi tin và khiến OMP chạy tool không cần duyệt; quyền tool của OMP vẫn áp dụng",
			"warning",
		]);
		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(0);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "auto-cli-unlimited" });

		await fixture.host.command("autochat off", fixture.ctx);
		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });
		expect(fixture.ctx.notifications.at(-1)?.[0]).toContain("autochat đã tắt");
	} finally {
		fixture.host.shutdownSync();
	}
});

test("TUI limited overrides CLI unlimited at the configured limit", async () => {
	const fixture = setup({
		chat: { autoApprove: "off", autoMaxChars: 3, autoMaxMessages: 10 },
		flag: "unlimited",
	});
	try {
		await fixture.host.publish(fixture.ctx);
		await fixture.host.command("autochat limited", fixture.ctx);
		await chat(fixture, "1234");
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });

		await chat(fixture, "123");
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "auto-tui" });
	} finally {
		fixture.host.shutdownSync();
	}
});

test("CLI off overrides a config that says unlimited", async () => {
	const fixture = setup({ chat: { autoApprove: "unlimited" }, flag: "off" });
	try {
		await fixture.host.publish(fixture.ctx);
		await chat(fixture);
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });
	} finally {
		fixture.host.shutdownSync();
	}
});

test("out-of-range limits clamp once and the status uses the clamped quota", async () => {
	const fixture = setup({
		chat: {
			autoApprove: "limited",
			autoMaxChars: 9_000,
			autoMaxMessages: 60,
			autoMinIntervalMs: 1_000,
		},
	});
	try {
		await fixture.host.publish(fixture.ctx);
		const clampWarnings = fixture.ctx.notifications.filter(([message]) =>
			message.includes("giới hạn autochat vượt mức")
		);
		expect(clampWarnings).toHaveLength(1);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("🔗 bridge · autochat 0/50");

		// 9,000 chars exceeds the clamped 8,000 cap, so it falls back to manual.
		await chat(fixture, "x".repeat(9_000));
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });
		expect(fixture.ctx.notifications.filter(([message]) =>
			message.includes("giới hạn autochat vượt mức")
		)).toHaveLength(1);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("autochat 0/50");
	} finally {
		fixture.host.shutdownSync();
	}
});

test("editing config limits mid-session cannot loosen the snapshot", async () => {
	const fixture = setup({
		chat: {
			autoApprove: "limited",
			autoMaxChars: 100,
			autoMaxMessages: 5,
			autoMinIntervalMs: 2_000,
		},
	});
	try {
		await fixture.host.publish(fixture.ctx);
		await chat(fixture, "x".repeat(500));
		expect(fixture.ctx.selections).toHaveLength(1);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });

		writeConfigFile(fixture.configPath, fixture.root, {
			autoApprove: "limited",
			autoMaxChars: 8_000,
			autoMaxMessages: 50,
			autoMinIntervalMs: 2_000,
		});
		utimesSync(fixture.configPath, new Date(), new Date(Date.now() + 1_000));
		await chat(fixture, "x".repeat(500));
		expect(fixture.ctx.selections).toHaveLength(2);
		expect(audit(fixture).at(-1)).toMatchObject({ consent: "manual" });
	} finally {
		fixture.host.shutdownSync();
	}
});

test("TUI limited resets the quota, while other toggles preserve the count", async () => {
	const fixture = setup({
		chat: {
			autoApprove: "limited",
			autoMaxChars: 1_000,
			autoMaxMessages: 5,
			autoMinIntervalMs: 2_000,
		},
	});
	try {
		await fixture.host.publish(fixture.ctx);
		await chat(fixture, "một");
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("autochat 1/5");

		await fixture.host.command("autochat limited", fixture.ctx);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("autochat 0/5");
		await chat(fixture, "hai");
		expect(fixture.ctx.selections).toHaveLength(0);
		expect(fixture.ctx.notifications).toContainEqual([
			"AgentBridge: tự gửi tin từ Claude (1/5)",
			"info",
		]);

		await fixture.host.command("autochat unlimited", fixture.ctx);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("autochat ∞ · 1 tin");
		expect(fixture.ctx.notifications).toContainEqual([
			"Claude có thể gửi tin và khiến OMP chạy tool không cần duyệt; quyền tool của OMP vẫn áp dụng",
			"warning",
		]);
		await fixture.host.command("autochat off", fixture.ctx);
		await fixture.host.command("autochat unlimited", fixture.ctx);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("autochat ∞ · 1 tin");
	} finally {
		fixture.host.shutdownSync();
	}
});

test("TUI limited duration uses a timer and expires back to manual", async () => {
	const fixture = setup({
		chat: {
			autoApprove: "off",
			autoMaxChars: 1_000,
			autoMaxMessages: 5,
			autoMinIntervalMs: 2_000,
		},
	});
	try {
		await fixture.host.publish(fixture.ctx);
		await fixture.host.command("autochat limited 1", fixture.ctx);
		expect(fixture.ctx.statuses.at(-1)?.[1]).toContain("autochat 0/5");
		expect(fixture.ctx.timeouts.some((entry) => entry.ms === 60_000)).toBe(true);

		await chat(fixture, "trong hạn");
		expect(fixture.ctx.selections).toHaveLength(0);
		fireTimeout(fixture, 60_000);
		expect(fixture.ctx.notifications.at(-1)?.[0]).toContain("autochat limited đã hết hạn");
		expect(fixture.ctx.statuses.at(-1)?.[1]).not.toContain("autochat");

		await chat(fixture, "sau hạn");
		expect(fixture.ctx.selections).toHaveLength(1);
	} finally {
		fixture.host.shutdownSync();
	}
});

test("TUI limited duration clamps above 480 minutes", async () => {
	const fixture = setup({ chat: { autoApprove: "off" } });
	try {
		await fixture.host.publish(fixture.ctx);
		await fixture.host.command("autochat limited 999", fixture.ctx);
		expect(fixture.ctx.notifications).toContainEqual([
			"AgentBridge: thời hạn autochat tối đa 480 phút; đã kẹp về 480.",
			"warning",
		]);
		expect(fixture.ctx.timeouts.some((entry) => entry.ms === 480 * 60_000)).toBe(true);
	} finally {
		fixture.host.shutdownSync();
	}
});

test("limited mode counts characters, spacing, and messages across the session", () => {
	const session = new AutoChatSession();
	session.configure("limited", "config", {
		limits: { maxChars: 5, maxMessages: 2, minIntervalMs: 1_000 },
	});

	expect(session.decide("123456", 1_000)).toBeUndefined();
	expect(session.decide("12345", 1_000)).toEqual({ consent: "auto-config" });
	expect(session.decide("12345", 1_500)).toBeUndefined();
	expect(session.decide("12345", 2_000)).toEqual({ consent: "auto-config" });
	expect(session.decide("12345", 3_000)).toBeUndefined();
	expect(session.autoMessages).toBe(2);
	expect(session.used).toBe(2);
	expect(session.quota).toBe(2);

	session.configure("unlimited", "config");
	expect(session.decide("x".repeat(10_000), 3_001)).toEqual({
		consent: "auto-config-unlimited",
	});
	expect(session.used).toBe(3);
	expect(session.quota).toBeUndefined();
});

test("clamp helper caps looser values and preserves stricter ones", () => {
	const looser = clampAutoChatLimits({
		autoMaxChars: 9_000,
		autoMaxMessages: 60,
		autoMinIntervalMs: 1_000,
	});
	expect(looser).toEqual({
		limits: { maxChars: 8_000, maxMessages: 50, minIntervalMs: 2_000 },
		clamped: true,
	});

	const stricter = clampAutoChatLimits({
		autoMaxChars: 1_500,
		autoMaxMessages: 10,
		autoMinIntervalMs: 12_000,
	});
	expect(stricter).toEqual({
		limits: { maxChars: 1_500, maxMessages: 10, minIntervalMs: 12_000 },
		clamped: false,
	});
});

test("CLI flag parsing distinguishes absent, explicit, and invalid values", () => {
	expect(readAutoApproveFlag(undefined)).toEqual({ present: false });
	expect(readAutoApproveFlag("")).toEqual({ present: false });
	expect(readAutoApproveFlag("  ")).toEqual({ present: false });
	expect(readAutoApproveFlag("unlimited")).toEqual({ present: true, mode: "unlimited" });
	expect(readAutoApproveFlag(" OFF ")).toEqual({ present: true, mode: "off" });
	expect(readAutoApproveFlag("typo")).toMatchObject({ present: true, invalid: "typo" });
	expect(readAutoApproveFlag(true)).toEqual({ present: true, mode: "unlimited" });
	expect(readAutoApproveFlag(false)).toEqual({ present: true, mode: "off" });
});

test("audit consent reasons distinguish every source", () => {
	expect(autoConsentReason("limited", "config")).toBe("auto-config");
	expect(autoConsentReason("unlimited", "config")).toBe("auto-config-unlimited");
	expect(autoConsentReason("limited", "cli")).toBe("auto-cli");
	expect(autoConsentReason("unlimited", "cli")).toBe("auto-cli-unlimited");
	expect(autoConsentReason("limited", "tui")).toBe("auto-tui");
	expect(autoConsentReason("unlimited", "tui")).toBe("auto-tui-unlimited");
	expect(autoConsentReason("off", "tui")).toBe("manual");
});

test("only TUI limited resets the quota; other toggles preserve the used count", () => {
	const limits = { maxChars: 100, maxMessages: 1, minIntervalMs: 0 };
	const session = new AutoChatSession();
	session.configure("limited", "tui", { limits, resetQuota: true });
	expect(session.decide("ok", 0)).toEqual({ consent: "auto-tui" });
	expect(session.used).toBe(1);

	session.configure("unlimited", "tui");
	expect(session.decide("ok", 1)).toEqual({ consent: "auto-tui-unlimited" });
	expect(session.used).toBe(2);
	session.configure("off", "tui");
	session.configure("unlimited", "tui");
	expect(session.used).toBe(2);

	session.configure("limited", "tui", { limits, resetQuota: true });
	expect(session.used).toBe(0);
	expect(session.decide("ok", 2)).toEqual({ consent: "auto-tui" });
	session.configure("limited", "tui");
	expect(session.decide("ok", 3)).toBeUndefined();
});
