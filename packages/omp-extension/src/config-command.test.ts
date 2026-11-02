import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	Host,
	type OmpContextLike,
	type OmpDialogOptions,
	type OmpSelectItem,
	type PiLike,
	createOmpLike,
} from "./index";

interface SelectionCall {
	title: string;
	options: OmpSelectItem[];
	dialogOptions?: OmpDialogOptions;
}

interface Ctx extends OmpContextLike {
	notifications: Array<[string, string | undefined]>;
	selections: SelectionCall[];
}

interface Env {
	root: string;
	home: string;
	config: string;
}

const roots: string[] = [];
const savedEnv = {
	home: process.env.AGENTBRIDGE_HOME,
	runtime: process.env.AGENTBRIDGE_RUNTIME_DIR,
	state: process.env.AGENTBRIDGE_STATE_DIR,
	config: process.env.AGENTBRIDGE_CONFIG,
};

function restoreEnv(): void {
	const names = {
		home: "AGENTBRIDGE_HOME",
		runtime: "AGENTBRIDGE_RUNTIME_DIR",
		state: "AGENTBRIDGE_STATE_DIR",
		config: "AGENTBRIDGE_CONFIG",
	} as const;
	for (const key of Object.keys(names) as Array<keyof typeof names>) {
		const value = savedEnv[key];
		const name = names[key];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

afterEach(() => {
	restoreEnv();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setupEnv(): Env {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agentbridge-cfgcmd-")));
	roots.push(root);
	const home = join(root, "home");
	process.env.AGENTBRIDGE_HOME = home;
	process.env.AGENTBRIDGE_RUNTIME_DIR = join(root, "run");
	process.env.AGENTBRIDGE_STATE_DIR = join(root, "state");
	process.env.AGENTBRIDGE_CONFIG = join(home, "config.json");
	return { root, home, config: join(home, "config.json") };
}

function makeProject(): string {
	const project = realpathSync(mkdtempSync(join(tmpdir(), "agentbridge-cfgcmd-project-")));
	roots.push(project);
	return project;
}

function makeCtx(
	cwd: string,
	options: { kind?: string; select?: "yes" | "deny" | "cancel" | "unavailable" } = {},
): Ctx {
	const selectMode = options.select ?? "yes";
	const ui: OmpContextLike["ui"] = {
		setStatus() {
			// Status text is not asserted.
		},
		notify(message, type) {
			ctx.notifications.push([message, type]);
		},
	};
	if (selectMode !== "unavailable") {
		ui.select = async (title, options, dialogOptions) => {
			ctx.selections.push({ title, options, dialogOptions });
			if (selectMode === "deny") return "Từ chối";
			if (selectMode === "cancel") return undefined;
			return "Đồng ý";
		};
	}
	const ctx: Ctx = {
		ui,
		mode: "tui",
		hasUI: true,
		cwd,
		agent: { kind: options.kind ?? "main" },
		model: { provider: "openai", id: "gpt-test" },
		sessionManager: { getSessionId: () => "cfg-cmd-test" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		setInterval: () => 1,
		clearTimer: () => undefined,
		notifications: [],
		selections: [],
	};
	return ctx;
}

function makeHost(): Host {
	const pi: PiLike = {
		on() {
			// Host is driven directly by these tests.
		},
		registerCommand() {
			// Command registration is covered by index.test.ts.
		},
	};
	return new Host(createOmpLike(pi, "test"));
}

function writeConfig(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function writeRawConfig(path: string, text: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, text, { mode });
	chmodSync(path, mode);
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}

function lastMessage(ctx: Ctx): string {
	return ctx.notifications.at(-1)?.[0] ?? "";
}

test("allow adds the canonical project and creates secure home/config", async () => {
	const env = setupEnv();
	const project = makeProject();
	const alias = join(env.root, "project-link");
	symlinkSync(project, alias);
	const ctx = makeCtx(alias);
	const host = makeHost();

	await host.command("allow", ctx);

	expect(ctx.selections).toHaveLength(1);
	expect(ctx.selections[0]?.title).toContain("/agentbridge allow");
	expect(ctx.selections[0]?.title).toContain("Cho phép");
	expect(ctx.selections[0]?.title).toContain(project);
	expect(readJson(env.config).projects).toEqual([project]);
	expect(modeOf(env.home)).toBe(0o700);
	expect(modeOf(env.config)).toBe(0o600);
	expect(lastMessage(ctx)).toContain("đã cho phép");
});

test("disallow removes the canonical project and preserves unrelated fields", async () => {
	const env = setupEnv();
	const project = makeProject();
	const original = {
		version: 1,
		projects: [project],
		allowFrom: ["claude-code", "omp"],
		consult: { consent: "always", maxTokens: 1_234 },
		chat: { enabled: true, autoApprove: "limited", queueWhenBusy: true },
		audit: { content: true, maxBytes: 999 },
		ui: { liveWidget: false, widgetLines: 3, widgetHoldMs: 5 },
		unknownField: { keep: [1, 2, 3] },
	};
	writeConfig(env.config, original);
	const ctx = makeCtx(project);
	const host = makeHost();

	await host.command("disallow", ctx);

	expect(ctx.selections[0]?.title).toContain("/agentbridge disallow");
	expect(ctx.selections[0]?.title).toContain("Bỏ cho phép");
	const updated = readJson(env.config);
	expect(updated.projects).toEqual([]);
	const { projects: updatedProjects, ...updatedRest } = updated;
	const { projects: originalProjects, ...originalRest } = original;
	expect(updatedProjects).toEqual([]);
	expect(originalProjects).toEqual([project]);
	expect(updatedRest).toEqual(originalRest);
});

test("duplicate allow and absent disallow do not rewrite the config", async () => {
	const env = setupEnv();
	const project = makeProject();
	const ctx = makeCtx(project);
	const host = makeHost();

	await host.command("allow", ctx);
	const afterAllow = readFileSync(env.config, "utf8");
	await host.command("allow", ctx);
	expect(readFileSync(env.config, "utf8")).toBe(afterAllow);
	expect(lastMessage(ctx)).toContain("đã có trong danh sách");

	await host.command("disallow", ctx);
	const afterDisallow = readFileSync(env.config, "utf8");
	await host.command("disallow", ctx);
	expect(readFileSync(env.config, "utf8")).toBe(afterDisallow);
	expect(lastMessage(ctx)).toContain("không có trong danh sách");
});

test("denied or cancelled confirmation never writes", async () => {
	for (const select of ["deny", "cancel"] as const) {
		const env = setupEnv();
		const project = makeProject();
		const ctx = makeCtx(project, { select });
		const host = makeHost();

		await host.command("allow", ctx);

		expect(ctx.selections).toHaveLength(1);
		expect(existsSync(env.config)).toBe(false);
		expect(lastMessage(ctx)).toContain("đã huỷ");
	}
});

test("unavailable select refuses with a warning and no write", async () => {
	const env = setupEnv();
	const project = makeProject();
	const ctx = makeCtx(project, { select: "unavailable" });

	await makeHost().command("allow", ctx);

	expect(existsSync(env.config)).toBe(false);
	expect(lastMessage(ctx)).toContain("không mở được hộp thoại xác nhận");
});

test("non-main TUI refuses allow, disallow and config without writing", async () => {
	const env = setupEnv();
	const project = makeProject();
	writeConfig(env.config, { version: 1, projects: [project] });
	const before = readFileSync(env.config, "utf8");
	const ctx = makeCtx(project, { kind: "sub" });
	const host = makeHost();

	for (const command of ["allow", "disallow", "config"]) {
		await host.command(command, ctx);
		expect(lastMessage(ctx)).toContain("TUI chính");
	}

	expect(ctx.selections).toEqual([]);
	expect(readFileSync(env.config, "utf8")).toBe(before);
});

test("invalid config is reported and never overwritten", async () => {
	const env = setupEnv();
	const project = makeProject();
	const invalid = "{ not json\n";
	writeRawConfig(env.config, invalid);
	const ctx = makeCtx(project);
	const host = makeHost();

	await host.command("allow", ctx);
	expect(readFileSync(env.config, "utf8")).toBe(invalid);
	expect(lastMessage(ctx)).toContain("không hợp lệ");
	expect(lastMessage(ctx)).toContain("không ghi đè");

	await host.command("config", ctx);
	expect(lastMessage(ctx)).toContain(env.config);
	expect(lastMessage(ctx)).toContain("không hợp lệ");
	expect(readFileSync(env.config, "utf8")).toBe(invalid);
});

test("config prints path, projects, chat.enabled and autoApprove without writing", async () => {
	const env = setupEnv();
	const project = makeProject();
	writeConfig(env.config, {
		version: 1,
		projects: [project],
		chat: { enabled: true, autoApprove: "limited" },
	});
	const before = readFileSync(env.config, "utf8");
	const ctx = makeCtx(project);

	await makeHost().command("config", ctx);

	const message = lastMessage(ctx);
	expect(message).toContain(env.config);
	expect(message).toContain(project);
	expect(message).toContain("chat.enabled: true");
	expect(message).toContain("chat.autoApprove: limited");
	expect(readFileSync(env.config, "utf8")).toBe(before);
	expect(ctx.selections).toEqual([]);
});

test("missing config prints the safe-default summary without creating anything", async () => {
	const env = setupEnv();
	const project = makeProject();
	const ctx = makeCtx(project);

	await makeHost().command("config", ctx);

	const message = lastMessage(ctx);
	expect(message).toContain("config chưa có (dùng mặc định an toàn)");
	expect(message).toContain(env.config);
	expect(message).toContain("projects: (trống)");
	expect(message).toContain("chat.enabled: false");
	expect(message).toContain("chat.autoApprove: off");
	expect(existsSync(env.config)).toBe(false);
	expect(existsSync(env.home)).toBe(false);
});

test("allow refuses when the config file is inside a would-be allowed project", async () => {
	setupEnv();
	const project = makeProject();
	const configPath = join(project, "config.json");
	process.env.AGENTBRIDGE_CONFIG = configPath;
	writeConfig(configPath, { version: 1, projects: [] });
	const before = readFileSync(configPath, "utf8");
	const ctx = makeCtx(project);

	await makeHost().command("allow", ctx);

	expect(readFileSync(configPath, "utf8")).toBe(before);
	expect(readJson(configPath).projects).toEqual([]);
	expect(lastMessage(ctx)).toContain("từ chối ghi config");
	expect(lastMessage(ctx)).toContain("project được phép");
});

test("disallow can remove the only project containing the config", async () => {
	setupEnv();
	const project = makeProject();
	const configPath = join(project, "config.json");
	process.env.AGENTBRIDGE_CONFIG = configPath;
	writeConfig(configPath, { version: 1, projects: [project] });
	const ctx = makeCtx(project);

	await makeHost().command("disallow", ctx);

	expect(readJson(configPath).projects).toEqual([]);
});

test("disallow refuses while another allowed project contains the config", async () => {
	const env = setupEnv();
	const outer = env.root;
	const inner = join(outer, "inner");
	mkdirSync(inner, { recursive: true, mode: 0o700 });
	const configPath = join(inner, "config.json");
	process.env.AGENTBRIDGE_CONFIG = configPath;
	writeConfig(configPath, { version: 1, projects: [inner, outer] });
	const before = readFileSync(configPath, "utf8");
	const ctx = makeCtx(inner);

	await makeHost().command("disallow", ctx);

	expect(readFileSync(configPath, "utf8")).toBe(before);
	expect(readJson(configPath).projects).toEqual([inner, outer]);
	expect(lastMessage(ctx)).toContain("từ chối ghi config");
});

test("config display reads a non-0600 config but refuses a symlink", async () => {
	const env = setupEnv();
	const project = makeProject();
	const text = JSON.stringify({
		version: 1,
		projects: [project],
		chat: { enabled: false, autoApprove: "off" },
	});
	writeRawConfig(env.config, text, 0o644);
	const ctx = makeCtx(project);
	const host = makeHost();

	await host.command("config", ctx);
	expect(lastMessage(ctx)).toContain("chat.enabled: false");
	expect(lastMessage(ctx)).toContain("chat.autoApprove: off");
	expect(readFileSync(env.config, "utf8")).toBe(text);

	const target = join(env.root, "target.json");
	writeConfig(target, { version: 1, projects: [] });
	rmSync(env.config);
	mkdirSync(env.home, { recursive: true, mode: 0o700 });
	symlinkSync(target, env.config);
	const symlinkCtx = makeCtx(project);
	await host.command("config", symlinkCtx);
	expect(lastMessage(symlinkCtx)).toContain("không an toàn");
});

test("symlinked config and insecure file modes fail closed", async () => {
	const env = setupEnv();
	const project = makeProject();
	const target = join(env.root, "target.json");
	writeConfig(target, { version: 1, projects: [] });
	mkdirSync(env.home, { recursive: true, mode: 0o700 });
	symlinkSync(target, env.config);
	const before = readFileSync(target, "utf8");
	const ctx = makeCtx(project);
	const host = makeHost();

	await host.command("allow", ctx);
	expect(readFileSync(target, "utf8")).toBe(before);
	expect(lstatSync(env.config).isSymbolicLink()).toBe(true);
	expect(lastMessage(ctx)).toContain("không an toàn");

	rmSync(env.config);
	writeRawConfig(env.config, before, 0o644);
	await host.command("allow", ctx);
	expect(readFileSync(env.config, "utf8")).toBe(before);
	expect(lastMessage(ctx)).toContain("0600");
});
