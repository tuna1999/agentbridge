import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliIO, parseCommand, parseFileSpec, parseInstalledPluginsJson, parseOmpPluginPackage, parsePluginListJson, runCli } from "./cli";
import { createFakeHost, DEFAULT_REPLY, type FakeHost, type FakeHostOptions } from "./test-helpers";

const SESSION_ID = "0199ab12-0000-7000-8000-000000000021";
const INSTANCE_ID = "0199ab12-1111-7000-8000-000000000021";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"PATH",
	"AGENTBRIDGE_HOME",
	"AGENTBRIDGE_RUNTIME_DIR",
	"AGENTBRIDGE_STATE_DIR",
	"AGENTBRIDGE_CONFIG",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
] as const;

let root: string;
let runtimeDir: string;
let projectDir: string;
let homeDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ab-cli-test-"));
	runtimeDir = join(root, "run");
	projectDir = join(root, "project");
	homeDir = join(root, "home");
	await mkdir(projectDir, { recursive: true });
	await mkdir(homeDir, { recursive: true });

	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.HOME = homeDir;
	delete process.env.USERPROFILE;
	delete process.env.AGENTBRIDGE_HOME;
	process.env.AGENTBRIDGE_RUNTIME_DIR = runtimeDir;
	delete process.env.AGENTBRIDGE_STATE_DIR;
	delete process.env.AGENTBRIDGE_CONFIG;
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.XDG_STATE_HOME;
	delete process.env.XDG_RUNTIME_DIR;

	// Never invoke the real Claude CLI from tests: it can write migration
	// backups under the temp HOME while listing plugins.
	const fakeBin = join(root, "fake-bin");
	await mkdir(fakeBin, { recursive: true });
	const fakeClaude = join(fakeBin, "claude");
	await writeFile(
		fakeClaude,
		`#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
exit 1
`,
		{ mode: 0o755 },
	);
	await chmod(fakeClaude, 0o755);
	process.env.PATH = `${fakeBin}:${savedEnv.PATH ?? process.env.PATH ?? ""}`;
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

interface Capture {
	io: CliIO;
	stdout(): string;
	stderr(): string;
}

function capture(cwd: string): Capture {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: {
			stdout: (text) => out.push(text),
			stderr: (text) => err.push(text),
			cwd,
		},
		stdout: () => out.join(""),
		stderr: () => err.join(""),
	};
}

function host(options: Partial<FakeHostOptions> = {}): Promise<FakeHost> {
	return createFakeHost({
		runtimeDir,
		sessionId: SESSION_ID,
		instanceId: INSTANCE_ID,
		cwd: projectDir,
		sessionName: "omp-cli",
		...options,
	});
}

async function tree(dir: string, prefix = ""): Promise<string[]> {
	const entries: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
		entries.push(`${relative}${entry.isDirectory() ? "/" : ""}`);
		if (entry.isDirectory()) entries.push(...(await tree(join(dir, entry.name), relative)));
	}
	return entries.sort();
}

/** Mimic ~/.claude/plugins/installed_plugins.json + the cached plugin's .mcp.json. */
async function addClaudePlugin(options: { mcp?: boolean } = {}): Promise<string> {
	const pluginDir = join(homeDir, ".claude", "plugins", "cache", "agentbridge", "agentbridge", "1.0.0");
	await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
	await writeFile(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agentbridge" }));
	if (options.mcp !== false) {
		await writeFile(
			join(pluginDir, ".mcp.json"),
			JSON.stringify({ agentbridge: { command: "bun", args: ["mcp-server.js"] } }),
		);
	}
	await writeFile(
		join(homeDir, ".claude", "plugins", "installed_plugins.json"),
		JSON.stringify({
			version: 2,
			plugins: {
				"agentbridge@agentbridge": [{ scope: "user", installPath: pluginDir, version: "1.0.0" }],
			},
		}),
	);
	return pluginDir;
}

/** Mimic ~/.omp/plugins/node_modules/<pkg>/package.json + omp-plugins.lock.json. */
async function addOmpPlugin(options: { enabled?: boolean; extensions?: string[] } = {}): Promise<string> {
	const pluginsRoot = join(homeDir, ".omp", "plugins");
	const pluginDir = join(pluginsRoot, "node_modules", "agentbridge");
	await mkdir(pluginDir, { recursive: true });
	await writeFile(
		join(pluginDir, "package.json"),
		JSON.stringify({
			name: "agentbridge",
			version: "0.1.0",
			omp: { extensions: options.extensions ?? ["./dist/agentbridge.js"] },
		}),
	);
	await writeFile(
		join(pluginsRoot, "omp-plugins.lock.json"),
		JSON.stringify({
			plugins: { agentbridge: { version: "0.1.0", enabledFeatures: null, enabled: options.enabled !== false } },
			settings: {},
		}),
	);
	return pluginDir;
}

async function addDevExtension(): Promise<string> {
	const extension = join(homeDir, ".omp", "agent", "extensions", "agentbridge.js");
	await mkdir(join(homeDir, ".omp", "agent", "extensions"), { recursive: true });
	await writeFile(extension, "export default () => {};\n");
	return extension;
}

describe("parseCommand", () => {
	test("parses list flags", () => {
		const parsed = parseCommand(["--scope", "worktree", "--json"]);
		expect(parsed.flags.get("--scope")).toEqual(["worktree"]);
		expect(parsed.json).toBe(true);
		expect(parsed.positional).toEqual([]);
	});

	test("parses a status target", () => {
		const parsed = parseCommand([SESSION_ID]);
		expect(parsed.positional).toEqual([SESSION_ID]);
		expect(parsed.noStream).toBe(false);
	});

	test("parses consult flags and file ranges", () => {
		const parsed = parseCommand([
			"--target",
			"omp-cli",
			"--file",
			"src/a.ts:2-9",
			"--file",
			"README.md",
			"--no-stream",
			"hello",
			"world",
		]);

		expect(parsed.positional).toEqual(["hello", "world"]);
		expect(parsed.noStream).toBe(true);
		expect(parsed.flags.get("--target")).toEqual(["omp-cli"]);
		expect((parsed.flags.get("--file") ?? []).map(parseFileSpec)).toEqual([
			{ path: "src/a.ts", startLine: 2, endLine: 9 },
			{ path: "README.md" },
		]);
	});

	test("rejects unknown flags and missing values", () => {
		expect(() => parseCommand(["--bogus"])).toThrow("Tham số không hỗ trợ: --bogus");
		expect(() => parseCommand(["--file"])).toThrow("Thiếu giá trị cho --file");
		expect(() => parseCommand(["--target"])).toThrow("Thiếu giá trị cho --target");
	});
});

describe("runCli argument errors", () => {
	test("unknown flags exit 2 before touching IPC", async () => {
		const captured = capture(projectDir);
		const code = await runCli(["list", "--bogus"], captured.io);

		expect(code).toBe(2);
		expect(captured.stderr()).toContain("Tham số không hỗ trợ: --bogus");
	});

	test("invalid command arguments fail without IPC", async () => {
		const cases: Array<{ argv: string[]; expected: string }> = [
			{ argv: ["list", "extra"], expected: "ab list không nhận tham số vị trí" },
			{ argv: ["status", "one", "two"], expected: "ab status nhận tối đa một target" },
			{ argv: ["consult"], expected: "ab consult cần câu hỏi" },
			{ argv: ["chat"], expected: "ab chat cần tin nhắn" },
			{ argv: ["consult", "q", "--target", "a", "--target", "b"], expected: "--target chỉ được dùng một lần" },
			{ argv: ["list", "--scope", "galaxy"], expected: "--scope phải là worktree, repo hoặc all" },
		];

		for (const item of cases) {
			const captured = capture(projectDir);
			const code = await runCli(item.argv, captured.io);
			expect(code).toBe(1);
			expect(captured.stderr()).toContain(item.expected);
		}
	});
});

describe("runCli with a fake host", () => {
	test("ab list emits JSON for the requested scope", async () => {
		const fake = await host();
		try {
			const captured = capture(projectDir);
			const code = await runCli(["list", "--scope", "worktree", "--json"], captured.io);

			expect(code).toBe(0);
			const sessions = JSON.parse(captured.stdout()) as Array<{ sessionId: string; name: string }>;
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.sessionId).toBe(SESSION_ID);
			expect(sessions[0]?.name).toBe("omp-cli");
		} finally {
			await fake.close();
		}
	});

	test("ab status prints the target status", async () => {
		const fake = await host();
		try {
			const captured = capture(projectDir);
			const code = await runCli(["status", SESSION_ID], captured.io);

			expect(code).toBe(0);
			expect(captured.stdout()).toContain("Trạng thái phiên OMP");
			expect(captured.stdout()).toContain(`- Session: ${SESSION_ID}`);
			expect(captured.stdout()).toContain("- Consent: ask");
		} finally {
			await fake.close();
		}
	});

	test("ab consult prints the reply and sends the ranged file", async () => {
		const fake = await host();
		try {
			await writeFile(join(projectDir, "note.txt"), "one\ntwo\nthree\n");
			const captured = capture(projectDir);
			const code = await runCli(
				[
					"consult",
					"Kiến trúc này ổn không?",
					"--target",
					SESSION_ID,
					"--file",
					"note.txt:2-2",
					"--no-stream",
				],
				captured.io,
			);

			expect(code).toBe(0);
			expect(captured.stderr()).toBe("");
			expect(captured.stdout()).toContain("[AgentBridge] Phản hồi từ OMP");
			expect(captured.stdout()).toContain("<<<OMP_REPLY");
			expect(captured.stdout()).toContain(DEFAULT_REPLY);

			expect(fake.consultBodies).toHaveLength(1);
			const body = fake.consultBodies[0];
			expect(body?.question).toBe("Kiến trúc này ổn không?");
			expect(body?.stream).toBe(false);
			expect(body?.attachments).toEqual([{ path: "note.txt", text: "two", startLine: 2, endLine: 2 }]);
		} finally {
			await fake.close();
		}
	});

	test("ab chat prints the framed reply and sends the message", async () => {
		const fake = await host();
		try {
			const captured = capture(projectDir);
			const code = await runCli(["chat", "Chạy test giúp tôi", "--target", SESSION_ID], captured.io);

			expect(code).toBe(0);
			expect(captured.stderr()).toBe("");
			expect(captured.stdout()).toContain("[AgentBridge] OMP đã trả lời trong phiên chat");
			expect(captured.stdout()).toContain("<<<OMP_REPLY");
			expect(captured.stdout()).toContain(DEFAULT_REPLY);
			expect(fake.chatBodies).toHaveLength(1);
			expect(fake.chatBodies[0]?.message).toBe("Chạy test giúp tôi");
			expect(fake.chatBodies[0]?.timeoutMs).toBe(600_000);
		} finally {
			await fake.close();
		}
	});
});

describe("plugin state parsers", () => {
	test("parses installed_plugins.json entries with array and object shapes", () => {
		const records = parseInstalledPluginsJson(
			JSON.stringify({
				version: 2,
				plugins: {
					"agentbridge@agentbridge": [{ scope: "user", installPath: "/cache/plugin", version: "1.0.0" }],
					"@scope/agentbridge@marketplace": { scope: "project", installPath: "/project/plugin" },
					"other@marketplace": [{ scope: "user", enabled: false }],
				},
			}),
		);
		expect(records).toHaveLength(3);
		expect(records?.[0]).toMatchObject({
			id: "agentbridge@agentbridge",
			name: "agentbridge",
			marketplace: "agentbridge",
			scope: "user",
			installPath: "/cache/plugin",
			version: "1.0.0",
			enabled: true,
		});
		expect(records?.[1]).toMatchObject({
			name: "@scope/agentbridge",
			marketplace: "marketplace",
			enabled: true,
		});
		expect(records?.[2]?.enabled).toBe(false);
		expect(parseInstalledPluginsJson("not json")).toBeUndefined();
		expect(parseInstalledPluginsJson(JSON.stringify({ plugins: {} }))).toBeUndefined();
	});

	test("parses claude plugin list JSON including inline MCP server names", () => {
		const records = parsePluginListJson(
			JSON.stringify([
				{
					id: "agentbridge@agentbridge",
					version: "1.0.0",
					scope: "user",
					enabled: true,
					installPath: "/cache/plugin",
					mcpServers: { agentbridge: { type: "stdio", command: "bun" } },
				},
			]),
		);
		expect(records).toHaveLength(1);
		expect(records?.[0]).toMatchObject({
			id: "agentbridge@agentbridge",
			name: "agentbridge",
			mcpServers: ["agentbridge"],
			enabled: true,
		});
		expect(parsePluginListJson("{}")).toBeUndefined();
	});

	test("parses OMP package.json omp/pi manifests", () => {
		expect(
			parseOmpPluginPackage(
				JSON.stringify({
					name: "agentbridge",
					version: "0.1.0",
					omp: { name: "agentbridge", extensions: ["./dist/agentbridge.js"] },
				}),
			),
		).toEqual({
			name: "agentbridge",
			version: "0.1.0",
			manifestName: "agentbridge",
			extensions: ["./dist/agentbridge.js"],
		});
		expect(
			parseOmpPluginPackage(JSON.stringify({ name: "legacy", pi: { extensions: ["./index.ts", 42] } })),
		).toEqual({ name: "legacy", extensions: ["./index.ts"] });
		expect(parseOmpPluginPackage(JSON.stringify({ name: "not-a-plugin" }))).toBeUndefined();
	});
});

describe("ab doctor", () => {
	test("prints the three AGENTBRIDGE_HOME paths without creating files or directories", async () => {
		const abHome = join(root, "ab-home");
		process.env.AGENTBRIDGE_HOME = abHome;
		delete process.env.AGENTBRIDGE_RUNTIME_DIR;
		const before = await tree(root);
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("Đường dẫn đang dùng:");
		expect(captured.stdout()).toContain(`config file: ${join(abHome, "config.json")}`);
		expect(captured.stdout()).toContain(`state dir:   ${join(abHome, "state")}`);
		expect(captured.stdout()).toContain(`runtime dir: ${join(abHome, "run")}`);
		expect(captured.stdout()).toContain("[ok] bun");
		expect(captured.stdout()).toContain(join(homeDir, ".omp", "agent", "extensions", "agentbridge.js"));
		expect(captured.stdout()).toContain("[warn] MCP agentbridge");
		expect(captured.stdout()).not.toContain("thư mục legacy XDG");
		expect(await tree(root)).toEqual(before);
	});

	test("individual AGENTBRIDGE_* paths win over AGENTBRIDGE_HOME", async () => {
		const abHome = join(root, "ab-home");
		const configFile = join(root, "custom.json");
		const stateDir = join(root, "custom-state");
		process.env.AGENTBRIDGE_HOME = abHome;
		process.env.AGENTBRIDGE_CONFIG = configFile;
		process.env.AGENTBRIDGE_STATE_DIR = stateDir;
		process.env.AGENTBRIDGE_RUNTIME_DIR = runtimeDir;
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain(`config file: ${configFile}`);
		expect(captured.stdout()).toContain(`state dir:   ${stateDir}`);
		expect(captured.stdout()).toContain(`runtime dir: ${runtimeDir}`);
		expect(captured.stdout()).not.toContain(`config file: ${join(abHome, "config.json")}`);
	});

	test("warns about legacy XDG dirs without migrating or deleting them", async () => {
		const xdgConfig = join(root, "xdg-config");
		const xdgState = join(root, "xdg-state");
		const xdgRuntime = join(root, "xdg-runtime");
		const customHome = join(root, "custom-home");
		const legacyConfig = join(xdgConfig, "agentbridge");
		const legacyState = join(xdgState, "agentbridge");
		const legacyRuntime = join(xdgRuntime, "agentbridge");
		for (const dir of [legacyConfig, legacyState, legacyRuntime]) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
		}
		process.env.AGENTBRIDGE_HOME = customHome;
		process.env.XDG_CONFIG_HOME = xdgConfig;
		process.env.XDG_STATE_HOME = xdgState;
		process.env.XDG_RUNTIME_DIR = xdgRuntime;

		const before = await tree(root);
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[warn] thư mục legacy XDG");
		expect(captured.stdout()).toContain(`${legacyConfig} (config)`);
		expect(captured.stdout()).toContain(`${legacyState} (state)`);
		expect(captured.stdout()).toContain(`${legacyRuntime} (runtime)`);
		expect(captured.stdout()).toContain("đường dẫn legacy");
		expect(captured.stdout()).toContain("AGENTBRIDGE_HOME");
		expect(captured.stdout()).toContain(`chuyển config/state vào ${customHome}`);
		expect(captured.stdout()).not.toContain(join(homeDir, ".agentbridge"));
		expect(captured.stdout()).toContain("không được tự di chuyển");
		expect(await tree(root)).toEqual(before);
		expect(existsSync(legacyConfig)).toBe(true);
		expect(existsSync(legacyState)).toBe(true);
		expect(existsSync(legacyRuntime)).toBe(true);
	});

	test("warns when the project contains an agentbridge extension", async () => {
		const extensionsDir = join(projectDir, ".omp", "extensions");
		const fakeExtension = join(extensionsDir, "agentbridge-project.ts");
		await mkdir(extensionsDir, { recursive: true });
		await writeFile(fakeExtension, "export default () => {};\n");

		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[warn] extension cấp project");
		expect(captured.stdout()).toContain(fakeExtension);
		expect(captured.stdout()).toContain("không hỏi");
	});

	test("detects local-scope MCP registration without printing file contents", async () => {
		await writeFile(
			join(homeDir, ".claude.json"),
			JSON.stringify({
				projects: {
					[projectDir]: {
						mcpServers: { agentbridge: { command: "bun", args: ["/secret/agentbridge.ts"] } },
						history: "SHOULD_NOT_BE_PRINTED",
					},
				},
				other: "SHOULD_NOT_BE_PRINTED",
			}),
		);

		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[ok] MCP agentbridge");
		expect(captured.stdout()).toContain("local:");
		expect(captured.stdout()).not.toContain("SHOULD_NOT_BE_PRINTED");
		expect(captured.stdout()).not.toContain("/secret/agentbridge.ts");
	});

	test("detects a Claude plugin and the MCP server it ships", async () => {
		const pluginDir = await addClaudePlugin();
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[ok] Claude plugin AgentBridge");
		expect(captured.stdout()).toContain("agentbridge@agentbridge");
		expect(captured.stdout()).toContain(pluginDir);
		expect(captured.stdout()).toContain("MCP: agentbridge");
		expect(captured.stdout()).toContain("claude plugin update agentbridge@agentbridge");
		expect(captured.stdout()).toContain("claude plugin uninstall agentbridge@agentbridge");
		expect(captured.stdout()).toContain("[ok] MCP agentbridge");
		expect(captured.stdout()).toContain("do Claude plugin");
		expect(captured.stdout()).not.toContain("trùng cách cài");
	});

	test("detects an OMP plugin under ~/.omp/plugins", async () => {
		const pluginDir = await addOmpPlugin();
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[ok] OMP plugin AgentBridge");
		expect(captured.stdout()).toContain("[ok] extension OMP");
		expect(captured.stdout()).toContain("do OMP plugin agentbridge cung cấp");
		expect(captured.stdout()).not.toContain("chưa cài tại");
		expect(captured.stdout()).toContain("agentbridge 0.1.0");
		expect(captured.stdout()).toContain(pluginDir);
		expect(captured.stdout()).toContain("omp plugin upgrade agentbridge");
		expect(captured.stdout()).toContain("omp plugin uninstall agentbridge");
		expect(captured.stdout()).not.toContain("trùng cách cài");
	});

	test("does not warn when one Claude plugin and one OMP plugin are installed", async () => {
		await addClaudePlugin();
		await addOmpPlugin();
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[ok] Claude plugin AgentBridge");
		expect(captured.stdout()).toContain("[ok] OMP plugin AgentBridge");
		expect(captured.stdout()).not.toContain("trùng cách cài");
	});

	test("warns about a dev extension plus an OMP plugin", async () => {
		await addDevExtension();
		await addOmpPlugin();
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[warn] trùng cách cài AgentBridge");
		expect(captured.stdout()).toContain("extension dev");
		expect(captured.stdout()).toContain("bun scripts/install.ts --uninstall");
		expect(captured.stdout()).toContain("omp plugin uninstall agentbridge");
	});

	test("warns about a manual MCP registration plus a Claude plugin", async () => {
		await addClaudePlugin();
		await writeFile(
			join(homeDir, ".claude.json"),
			JSON.stringify({ mcpServers: { agentbridge: { command: "bun", args: ["mcp-server.js"] } } }),
		);
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[warn] trùng cách cài AgentBridge");
		expect(captured.stdout()).toContain("MCP agentbridge đăng ký thủ công");
		expect(captured.stdout()).toContain("claude mcp remove -s <scope> agentbridge");
		expect(captured.stdout()).toContain("claude plugin uninstall agentbridge@agentbridge");
	});

	test("falls back to claude plugin list --json when the registry is absent", async () => {
		const fakeClaude = join(root, "fake-bin", "claude");
		await writeFile(
			fakeClaude,
			`#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  printf '%s\\n' '[{"id":"agentbridge@agentbridge","version":"1.0.0","scope":"user","enabled":true,"installPath":"/fake/cache","mcpServers":{"agentbridge":{"command":"bun"}}}]'
  exit 0
fi
exit 1
`,
			{ mode: 0o755 },
		);
		await chmod(fakeClaude, 0o755);

		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[ok] Claude plugin AgentBridge");
		expect(captured.stdout()).toContain("agentbridge@agentbridge");
		expect(captured.stdout()).toContain("[ok] MCP agentbridge");
	});

	test("warns when an OMP plugin is disabled", async () => {
		await addOmpPlugin({ enabled: false });
		const captured = capture(projectDir);
		const code = await runCli(["doctor"], captured.io);

		expect(code).toBe(0);
		expect(captured.stdout()).toContain("[warn] OMP plugin AgentBridge");
		expect(captured.stdout()).toContain("đang tắt");
		expect(captured.stdout()).toContain("omp plugin enable agentbridge");
	});
});
