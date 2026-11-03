import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	compareBundles,
	displayCommand,
	type InstallerIO,
	mcpAddCommand,
	mcpRemoveCommand,
	resolveInstallPaths,
	runInstaller,
	SAMPLE_CONFIG,
	sha256File,
	StdinClosedError,
} from "./install";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "install.ts");

let root: string;
let home: string;
let binDir: string;
let marker: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ab-install-test-"));
	home = join(root, "home");
	binDir = join(root, "bin");
	marker = join(root, "claude-invoked");
	await mkdir(home, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(
		join(binDir, "claude"),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "$AB_CLAUDE_MARKER"\nexit 0\n`,
		{ mode: 0o755 },
	);
	await chmod(join(binDir, "claude"), 0o755);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function tree(dir: string, prefix = ""): Promise<string[]> {
	const entries: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
		entries.push(`${relative}${entry.isDirectory() ? "/" : ""}`);
		if (entry.isDirectory()) entries.push(...(await tree(join(dir, entry.name), relative)));
	}
	return entries.sort();
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function installerEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.HOME = home;
	delete env.USERPROFILE;
	env.BUN_INSTALL = join(root, "bun-install");
	env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
	// Point the legacy XDG variables elsewhere; they must not influence defaults.
	env.XDG_CONFIG_HOME = join(root, "xdg-config");
	env.XDG_STATE_HOME = join(root, "xdg-state");
	env.XDG_RUNTIME_DIR = join(root, "xdg-runtime");
	delete env.AGENTBRIDGE_HOME;
	delete env.AGENTBRIDGE_CONFIG;
	delete env.AGENTBRIDGE_STATE_DIR;
	delete env.AGENTBRIDGE_RUNTIME_DIR;
	// OMP agent-dir overrides on the developer machine must not move the extension.
	delete env.PI_CODING_AGENT_DIR;
	delete env.PI_CONFIG_DIR;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
	env.AB_CLAUDE_MARKER = marker;
	return env;
}

async function runInstallerScript(args: string[]): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
		cwd: REPO_ROOT,
		env: installerEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

interface FakeIO {
	io: InstallerIO;
	output(): string;
	questions: string[];
	commands: string[][];
}

/** Confirm every step; `answer` can decline selected titles. */
function fakeIO(answer: (question: string) => boolean = () => true): FakeIO {
	const chunks: string[] = [];
	const questions: string[] = [];
	const commands: string[][] = [];
	return {
		io: {
			out: (text) => chunks.push(text),
			err: (text) => chunks.push(text),
			confirm: async (question) => {
				questions.push(question);
				return answer(question);
			},
			run: async (argv) => {
				commands.push(argv);
				return { exitCode: 0, stderr: "" };
			},
		},
		output: () => chunks.join(""),
		questions,
		commands,
	};
}

describe("installer dry-run", () => {
	test("prints every install step without writing anything or running claude", async () => {
		const before = await tree(home);
		const result = await runInstallerScript([]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("CÀI ĐẶT — DRY RUN");
		expect(result.stdout).toContain("dev-mode installer");
		expect(result.stdout).toContain("Cài extension OMP (dev)");
		expect(result.stdout).toContain("dev mode: bundle từ plugins/omp/dist");
		expect(result.stdout).toContain("Đăng ký MCP thủ công ở scope user (dev)");
		expect(result.stdout).toContain(join(home, ".omp", "agent", "extensions", "agentbridge.js"));
		expect(result.stdout).toContain("claude mcp add -s user agentbridge --");
		expect(result.stdout).toContain(join(REPO_ROOT, "plugins", "claude", "dist", "mcp-server.js"));
		expect(result.stdout).toContain(join(home, ".agentbridge", "config.json"));
		expect(result.stdout).not.toContain(join(root, "xdg-config"));
		expect(result.stdout).toContain("Dry-run: không ghi file nào");

		expect(await tree(home)).toEqual(before);
		expect(existsSync(marker)).toBe(false);
	});

	test("--uninstall is a dry-run that keeps home, config and audit by default", async () => {
		const abHome = join(home, ".agentbridge");
		const configFile = join(abHome, "config.json");
		const auditFile = join(abHome, "state", "audit.jsonl");
		await mkdir(join(abHome, "state"), { recursive: true });
		await writeFile(configFile, '{"version":1,"projects":[]}\n');
		await writeFile(auditFile, '{"event":"consult"}\n');

		const before = await tree(home);
		const result = await runInstallerScript(["--uninstall"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("GỠ CÀI ĐẶT — DRY RUN");
		expect(result.stdout).toContain("claude mcp remove -s user agentbridge");
		expect(result.stdout).toContain("Xóa thư mục AgentBridge home");
		expect(result.stdout).toContain(abHome);
		expect(result.stdout).toContain("hỏi khi --apply, mặc định giữ");
		expect(result.stdout).not.toContain("Xóa config");
		expect(result.stdout).not.toContain("Xóa audit log");
		expect(result.stdout).toContain("Dry-run: không ghi file nào");

		expect(await tree(home)).toEqual(before);
		expect(await readFile(configFile, "utf8")).toContain('"projects":[]');
		expect(await readFile(auditFile, "utf8")).toContain("consult");
		expect(existsSync(marker)).toBe(false);
	});
});

describe("bundle comparison", () => {
	test("detects matching, stale, missing and absent dist bundles", async () => {
		const dist = join(root, "dist.js");
		const installed = join(root, "installed.js");
		await writeFile(dist, "same-content");
		await writeFile(installed, "same-content");
		expect(await compareBundles(installed, dist)).toEqual({
			state: "same",
			installedSha: await sha256File(installed),
			distSha: await sha256File(dist),
		});

		await writeFile(installed, "old-content");
		const stale = await compareBundles(installed, dist);
		expect(stale.state).toBe("different");
		expect(stale.installedSha).not.toBe(stale.distSha);

		await rm(installed);
		expect((await compareBundles(installed, dist)).state).toBe("missing");

		await rm(dist);
		expect((await compareBundles(installed, dist)).state).toBe("no-dist");
	});
});

describe("path and command building", () => {
	test("uses the new ~/.agentbridge defaults and ignores XDG", () => {
		const env = {
			HOME: home,
			XDG_CONFIG_HOME: join(home, "xdg-config"),
			XDG_STATE_HOME: join(home, "xdg-state"),
			XDG_RUNTIME_DIR: join(home, "xdg-runtime"),
		};
		const paths = resolveInstallPaths(env, REPO_ROOT);
		const abHome = join(home, ".agentbridge");
		expect(paths.home).toBe(home);
		expect(paths.agentbridgeHome).toBe(abHome);
		expect(paths.extensionFile).toBe(join(home, ".omp", "agent", "extensions", "agentbridge.js"));
		expect(paths.configFile).toBe(join(abHome, "config.json"));
		expect(paths.stateDir).toBe(join(abHome, "state"));
		expect(paths.runtimeDir).toBe(join(abHome, "run"));
		expect(paths.auditFile).toBe(join(abHome, "state", "audit.jsonl"));
		expect(paths.distFile).toBe(join(REPO_ROOT, "plugins", "omp", "dist", "agentbridge.js"));
		expect(paths.mcpEntry).toBe(join(REPO_ROOT, "plugins", "claude", "dist", "mcp-server.js"));
	});

	test("AGENTBRIDGE_HOME moves every default path", () => {
		const customHome = join(root, "custom-home");
		const paths = resolveInstallPaths(
			{
				HOME: home,
				AGENTBRIDGE_HOME: customHome,
				XDG_CONFIG_HOME: join(home, "xdg-config"),
				XDG_STATE_HOME: join(home, "xdg-state"),
			},
			REPO_ROOT,
		);
		expect(paths.agentbridgeHome).toBe(customHome);
		expect(paths.configFile).toBe(join(customHome, "config.json"));
		expect(paths.stateDir).toBe(join(customHome, "state"));
		expect(paths.runtimeDir).toBe(join(customHome, "run"));
		expect(paths.auditFile).toBe(join(customHome, "state", "audit.jsonl"));
		// The OMP extension stays under the OS home.
		expect(paths.extensionFile).toBe(join(home, ".omp", "agent", "extensions", "agentbridge.js"));
	});

	test("individual overrides take precedence over AGENTBRIDGE_HOME", () => {
		const customHome = join(root, "custom-home");
		const overridden = resolveInstallPaths(
			{
				HOME: home,
				AGENTBRIDGE_HOME: customHome,
				AGENTBRIDGE_CONFIG: join(root, "custom.json"),
				AGENTBRIDGE_STATE_DIR: join(root, "state"),
				AGENTBRIDGE_RUNTIME_DIR: join(root, "run"),
			},
			REPO_ROOT,
		);
		expect(overridden.agentbridgeHome).toBe(customHome);
		expect(overridden.configFile).toBe(join(root, "custom.json"));
		expect(overridden.stateDir).toBe(join(root, "state"));
		expect(overridden.runtimeDir).toBe(join(root, "run"));
		expect(overridden.auditFile).toBe(join(root, "state", "audit.jsonl"));
	});

	test("mcp add uses the absolute Bun.which path", async () => {
		const fakeBun = join(binDir, "bun");
		await writeFile(fakeBun, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await chmod(fakeBun, 0o755);

		const paths = resolveInstallPaths({ HOME: home }, REPO_ROOT);
		const argv = mcpAddCommand(paths, { PATH: binDir });
		expect(argv[0]).toBe(join(binDir, "claude"));
		expect(argv.slice(0, 6)).toEqual([
			join(binDir, "claude"),
			"mcp",
			"add",
			"-s",
			"user",
			"agentbridge",
		]);
		expect(argv[6]).toBe("--");
		expect(argv[7]).toBe(fakeBun);
		expect(isAbsolute(argv[7] ?? "")).toBe(true);
		expect(argv[8]).toBe(paths.mcpEntry);
		expect(displayCommand(argv)).toContain(`${fakeBun} ${paths.mcpEntry}`);

		expect(mcpRemoveCommand({ PATH: binDir })).toEqual([
			join(binDir, "claude"),
			"mcp",
			"remove",
			"-s",
			"user",
			"agentbridge",
		]);
	});

	test("sample config is valid JSON with projects = []", () => {
		const parsed = JSON.parse(JSON.stringify(SAMPLE_CONFIG)) as { version: number; projects: unknown };
		expect(parsed.version).toBe(1);
		expect(parsed.projects).toEqual([]);
	});
});

describe("installer --apply", () => {
	async function fakeRepo(): Promise<string> {
		const repo = join(root, "repo");
		await mkdir(join(repo, "plugins", "omp", "dist"), { recursive: true });
		await writeFile(join(repo, "plugins", "omp", "dist", "agentbridge.js"), "bundle\n");
		return repo;
	}

	test("creates ~/.agentbridge/config.json with 0700/0600 and never overwrites it", async () => {
		const repo = await fakeRepo();
		const configFile = join(home, ".agentbridge", "config.json");
		const fake = fakeIO();
		const code = await runInstaller({ apply: true, uninstall: false, repoRoot: repo, env: installerEnv(), io: fake.io });

		expect(code).toBe(0);
		expect(fake.questions.length).toBe(3);
		expect(await readFile(configFile, "utf8")).toBe(`${JSON.stringify(SAMPLE_CONFIG, null, 2)}\n`);
		expect((await stat(join(home, ".agentbridge"))).mode & 0o777).toBe(0o700);
		expect((await stat(configFile)).mode & 0o777).toBe(0o600);
		expect(existsSync(join(home, ".omp", "agent", "extensions", "agentbridge.js"))).toBe(true);

		await writeFile(configFile, '{"version":1,"projects":["/keep/me"]}\n');
		const second = fakeIO();
		const secondCode = await runInstaller({
			apply: true,
			uninstall: false,
			repoRoot: repo,
			env: installerEnv(),
			io: second.io,
		});
		expect(secondCode).toBe(0);
		expect(second.questions.length).toBe(2);
		expect(second.output()).toContain("config đã tồn tại, giữ nguyên");
		expect(await readFile(configFile, "utf8")).toContain("/keep/me");
	});

	test("uninstall asks before deleting the AgentBridge home and removes it", async () => {
		const abHome = join(home, ".agentbridge");
		const configFile = join(abHome, "config.json");
		const extensionFile = join(home, ".omp", "agent", "extensions", "agentbridge.js");
		await mkdir(join(abHome, "state"), { recursive: true });
		await mkdir(join(abHome, "run"), { recursive: true });
		await mkdir(join(home, ".omp", "agent", "extensions"), { recursive: true });
		await writeFile(configFile, '{"version":1,"projects":[]}\n');
		await writeFile(join(abHome, "state", "audit.jsonl"), '{"event":"consult"}\n');
		await writeFile(extensionFile, "bundle\n");

		const fake = fakeIO();
		const code = await runInstaller({
			apply: true,
			uninstall: true,
			repoRoot: REPO_ROOT,
			env: installerEnv(),
			io: fake.io,
		});

		expect(code).toBe(0);
		expect(fake.questions.some((question) => question.includes("Xóa thư mục AgentBridge home"))).toBe(true);
		expect(fake.questions.filter((question) => question.includes("Xóa config"))).toHaveLength(0);
		expect(fake.questions.filter((question) => question.includes("Xóa audit log"))).toHaveLength(0);
		expect(fake.commands).toHaveLength(1);
		expect(fake.commands[0]?.slice(0, 5)).toEqual([join(binDir, "claude"), "mcp", "remove", "-s", "user"]);
		expect(existsSync(abHome)).toBe(false);
		expect(existsSync(extensionFile)).toBe(false);
	});

	test("declining the home step keeps config and audit", async () => {
		const abHome = join(home, ".agentbridge");
		const configFile = join(abHome, "config.json");
		const auditFile = join(abHome, "state", "audit.jsonl");
		await mkdir(join(abHome, "state"), { recursive: true });
		await writeFile(configFile, '{"version":1,"projects":[]}\n');
		await writeFile(auditFile, '{"event":"consult"}\n');

		const fake = fakeIO((question) => !question.includes("Xóa thư mục AgentBridge home"));
		const code = await runInstaller({
			apply: true,
			uninstall: true,
			repoRoot: REPO_ROOT,
			env: installerEnv(),
			io: fake.io,
		});

		expect(code).toBe(0);
		expect(fake.output()).toContain("[giữ nguyên]");
		expect(existsSync(configFile)).toBe(true);
		expect(existsSync(auditFile)).toBe(true);
	});

	test("refuses to delete the OS home when AGENTBRIDGE_HOME points at it", async () => {
		const configFile = join(home, "config.json");
		await writeFile(configFile, '{"version":1,"projects":[]}\n');
		const env = { ...installerEnv(), AGENTBRIDGE_HOME: home };
		const fake = fakeIO();
		const code = await runInstaller({
			apply: true,
			uninstall: true,
			repoRoot: REPO_ROOT,
			env,
			io: fake.io,
		});

		expect(code).toBe(0);
		expect(fake.output()).toContain("[bỏ qua]");
		expect(fake.output()).toContain("AGENTBRIDGE_HOME trùng thư mục home");
		expect(existsSync(configFile)).toBe(true);
		expect(existsSync(home)).toBe(true);
	});
});

describe("installer safety", () => {
	test("refuses an AGENTBRIDGE_HOME that is the real path behind a symlinked HOME", async () => {
		const realHome = join(root, "real-home");
		await mkdir(join(realHome, ".ssh"), { recursive: true });
		await writeFile(join(realHome, ".ssh", "id_ed25519"), "key\n");
		await writeFile(join(realHome, "config.json"), '{"version":1,"projects":[]}\n');
		const aliasHome = join(root, "alias-home");
		await symlink(realHome, aliasHome);
		const env = { ...installerEnv(), HOME: aliasHome, AGENTBRIDGE_HOME: realHome };

		const fake = fakeIO();
		const code = await runInstaller({ apply: true, uninstall: true, repoRoot: REPO_ROOT, env, io: fake.io });

		expect(code).toBe(0);
		expect(fake.output()).toContain("AGENTBRIDGE_HOME trùng thư mục home");
		expect(existsSync(join(realHome, ".ssh", "id_ed25519"))).toBe(true);
		expect(existsSync(join(realHome, "config.json"))).toBe(true);
	});

	test("a mistaken AGENTBRIDGE_HOME keeps every file that AgentBridge did not write", async () => {
		const foreign = join(root, "dot-claude");
		await mkdir(join(foreign, "state"), { recursive: true });
		await writeFile(join(foreign, "settings.json"), '{"theme":"dark"}\n');
		await writeFile(join(foreign, "config.json"), '{"theme":"dark"}\n');
		await writeFile(join(foreign, "state", "other.txt"), "keep\n");
		const env = { ...installerEnv(), AGENTBRIDGE_HOME: foreign };

		const fake = fakeIO();
		const code = await runInstaller({ apply: true, uninstall: true, repoRoot: REPO_ROOT, env, io: fake.io });

		expect(code).toBe(0);
		expect(await tree(foreign)).toEqual(["config.json", "settings.json", "state/", "state/other.txt"]);
		expect(fake.output()).toContain("còn file không phải của AgentBridge");
	});

	test("a foreign config.json that merely has a projects field is kept", async () => {
		const foreign = join(root, "other-app");
		await mkdir(foreign, { recursive: true });
		await writeFile(join(foreign, "config.json"), '{"projects":["a"],"theme":"dark"}\n');
		const env = { ...installerEnv(), AGENTBRIDGE_HOME: foreign };

		const code = await runInstaller({ apply: true, uninstall: true, repoRoot: REPO_ROOT, env, io: fakeIO().io });

		expect(code).toBe(0);
		expect(existsSync(join(foreign, "config.json"))).toBe(true);
	});

	test("install never re-modes the user's HOME used as AGENTBRIDGE_HOME", async () => {
		await chmod(home, 0o755);
		const env = { ...installerEnv(), AGENTBRIDGE_HOME: home };
		const fake = fakeIO((question) => question.includes("Tạo config mẫu"));

		const code = await runInstaller({ apply: true, uninstall: false, repoRoot: REPO_ROOT, env, io: fake.io });

		expect(code).toBe(0);
		expect((await stat(home)).mode & 0o777).toBe(0o755);
		expect(fake.output()).toContain("không tự đổi quyền");
		expect(existsSync(join(home, "config.json"))).toBe(true);
	});

	test("an empty or chat-only config is recognized as AgentBridge's own", async () => {
		const abHome = join(home, ".agentbridge");
		await mkdir(abHome, { recursive: true, mode: 0o700 });
		await writeFile(join(abHome, "config.json"), '{"chat":{"enabled":true}}\n');

		const fake = fakeIO();
		const code = await runInstaller({ apply: true, uninstall: true, repoRoot: REPO_ROOT, env: installerEnv(), io: fake.io });

		expect(code).toBe(0);
		expect(existsSync(abHome)).toBe(false);
	});

	test("uninstall removes a complete AgentBridge home including registry files", async () => {
		const abHome = join(home, ".agentbridge");
		await mkdir(join(abHome, "state"), { recursive: true, mode: 0o700 });
		await mkdir(join(abHome, "run", "sessions"), { recursive: true, mode: 0o700 });
		await mkdir(join(abHome, "run", "s"), { recursive: true, mode: 0o700 });
		await writeFile(join(abHome, "config.json"), '{"version":1,"projects":["/x"]}\n');
		await writeFile(join(abHome, "state", "audit.jsonl"), "{}\n");
		await writeFile(join(abHome, "state", "audit.jsonl.1"), "{}\n");
		await writeFile(join(abHome, "run", "sessions", "omp-abc.json"), "{}");
		await writeFile(join(abHome, "run", "sessions", "omp-abc.token"), "t");

		const fake = fakeIO();
		const code = await runInstaller({ apply: true, uninstall: true, repoRoot: REPO_ROOT, env: installerEnv(), io: fake.io });

		expect(code).toBe(0);
		expect(existsSync(abHome)).toBe(false);
	});

	test("install replaces a symlinked extension path instead of writing through it", async () => {
		const extensionsDir = join(home, ".omp", "agent", "extensions");
		await mkdir(extensionsDir, { recursive: true });
		const other = join(root, "other-checkout.js");
		await writeFile(other, "other\n");
		await chmod(other, 0o644);
		await symlink(other, join(extensionsDir, "agentbridge.js"));

		const fake = fakeIO((question) => question.includes("Cài extension OMP"));
		const code = await runInstaller({ apply: true, uninstall: false, repoRoot: REPO_ROOT, env: installerEnv(), io: fake.io });

		expect(code).toBe(0);
		expect(await readFile(other, "utf8")).toBe("other\n");
		expect((await stat(other)).mode & 0o777).toBe(0o644);
		const installed = await lstat(join(extensionsDir, "agentbridge.js"));
		expect(installed.isSymbolicLink()).toBe(false);
		expect(installed.mode & 0o777).toBe(0o600);
	});

	test("stdin closing mid-plan stops with a non-zero exit instead of a silent success", async () => {
		const fake = fakeIO();
		let asked = 0;
		fake.io.confirm = async () => {
			asked += 1;
			if (asked > 1) throw new StdinClosedError();
			return false;
		};
		const code = await runInstaller({ apply: true, uninstall: false, repoRoot: REPO_ROOT, env: installerEnv(), io: fake.io });

		expect(code).toBe(1);
		expect(fake.output()).toContain("[dừng] stdin đã đóng");
		expect(fake.output()).not.toContain("Hoàn tất.");
		expect(asked).toBe(2);
	});

	test("re-running the installer replaces an existing MCP registration", async () => {
		const fake = fakeIO((question) => question.includes("Đăng ký MCP"));
		let adds = 0;
		fake.io.run = async (argv) => {
			fake.commands.push(argv);
			if (argv[1] === "mcp" && argv[2] === "add") {
				adds += 1;
				if (adds === 1) return { exitCode: 1, stderr: "MCP server agentbridge already exists in user config" };
			}
			return { exitCode: 0, stderr: "" };
		};
		const code = await runInstaller({ apply: true, uninstall: false, repoRoot: REPO_ROOT, env: installerEnv(), io: fake.io });

		expect(code).toBe(0);
		expect(fake.commands.map((argv) => argv[2])).toEqual(["add", "remove", "add"]);
		expect(fake.output()).toContain("đã thay đăng ký agentbridge cũ");
	});

	test("the extension path follows OMP's agent-directory rules", () => {
		const extension = (extra: Record<string, string>) =>
			resolveInstallPaths({ ...installerEnv(), ...extra }, REPO_ROOT).extensionFile;
		const agentDir = join(root, "custom-agent");
		expect(extension({ PI_CODING_AGENT_DIR: agentDir })).toBe(join(agentDir, "extensions", "agentbridge.js"));
		// OMP joins PI_CONFIG_DIR onto the home directory.
		expect(extension({ PI_CONFIG_DIR: ".omp-dev" })).toBe(join(home, ".omp-dev", "agent", "extensions", "agentbridge.js"));
		// A profile wins and ignores PI_CODING_AGENT_DIR.
		expect(extension({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: agentDir })).toBe(
			join(home, ".omp", "profiles", "work", "agent", "extensions", "agentbridge.js"),
		);
		expect(extension({ PI_PROFILE: "lab", PI_CONFIG_DIR: ".omp-dev" })).toBe(
			join(home, ".omp-dev", "profiles", "lab", "agent", "extensions", "agentbridge.js"),
		);
	});
});
