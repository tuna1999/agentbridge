import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
	assertSecureDir,
	ensureRuntimeDirs,
	ensureSecureDir,
	InsecureDirError,
	resolveDirs,
	writeFileAtomic,
} from "./index";

const cleanup: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ab-core-dirs-"));
	cleanup.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("resolves Linux defaults under ~/.agentbridge", () => {
	const dirs = resolveDirs({}, "linux", "/home/tester");
	expect(dirs.homeDir).toBe("/home/tester/.agentbridge");
	expect(dirs.configFile).toBe("/home/tester/.agentbridge/config.json");
	expect(dirs.stateDir).toBe("/home/tester/.agentbridge/state");
	expect(dirs.runtimeDir).toBe("/home/tester/.agentbridge/run");
	expect(dirs.sessionsDir).toBe("/home/tester/.agentbridge/run/sessions");
	expect(dirs.socketsDir).toBe("/home/tester/.agentbridge/run/s");
});

test("uses HOME for POSIX defaults when no home is supplied", () => {
	const dirs = resolveDirs({ HOME: "/home/env" }, "linux");
	expect(dirs.homeDir).toBe("/home/env/.agentbridge");
	expect(dirs.configFile).toBe("/home/env/.agentbridge/config.json");
	expect(dirs.stateDir).toBe("/home/env/.agentbridge/state");
	expect(dirs.runtimeDir).toBe("/home/env/.agentbridge/run");
});

test("resolves macOS defaults under ~/.agentbridge", () => {
	const dirs = resolveDirs({}, "darwin", "/Users/tester");
	expect(dirs.homeDir).toBe("/Users/tester/.agentbridge");
	expect(dirs.configFile).toBe("/Users/tester/.agentbridge/config.json");
	expect(dirs.stateDir).toBe("/Users/tester/.agentbridge/state");
	expect(dirs.runtimeDir).toBe("/Users/tester/.agentbridge/run");
	expect(dirs.sessionsDir).toBe("/Users/tester/.agentbridge/run/sessions");
	expect(dirs.socketsDir).toBe("/Users/tester/.agentbridge/run/s");
});

test("uses USERPROFILE for Windows defaults when no home is supplied", () => {
	const dirs = resolveDirs({ USERPROFILE: "C:\\Users\\tester" }, "win32");
	expect(dirs.homeDir).toBe(win32.join("C:\\Users\\tester", ".agentbridge"));
	expect(dirs.configFile).toBe(win32.join("C:\\Users\\tester", ".agentbridge", "config.json"));
});

test("resolves Windows defaults under %USERPROFILE%\\.agentbridge", () => {
	const dirs = resolveDirs({}, "win32", "C:\\Users\\tester");
	const home = win32.join("C:\\Users\\tester", ".agentbridge");
	expect(dirs.homeDir).toBe(home);
	expect(dirs.configFile).toBe(win32.join(home, "config.json"));
	expect(dirs.stateDir).toBe(win32.join(home, "state"));
	expect(dirs.runtimeDir).toBe(win32.join(home, "run"));
	expect(dirs.sessionsDir).toBe(win32.join(home, "run", "sessions"));
	expect(dirs.socketsDir).toBe(win32.join(home, "run", "s"));
});

test("ignores the old XDG defaults", () => {
	const dirs = resolveDirs(
		{ XDG_RUNTIME_DIR: "/run/user/1000", XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/cfg" },
		"linux",
		"/home/tester",
	);
	expect(dirs.homeDir).toBe("/home/tester/.agentbridge");
	expect(dirs.runtimeDir).toBe("/home/tester/.agentbridge/run");
	expect(dirs.stateDir).toBe("/home/tester/.agentbridge/state");
	expect(dirs.configFile).toBe("/home/tester/.agentbridge/config.json");
});

test("AGENTBRIDGE_HOME moves every default path", () => {
	const dirs = resolveDirs({ AGENTBRIDGE_HOME: "/custom/home" }, "linux", "/home/tester");
	expect(dirs.homeDir).toBe("/custom/home");
	expect(dirs.runtimeDir).toBe("/custom/home/run");
	expect(dirs.stateDir).toBe("/custom/home/state");
	expect(dirs.configFile).toBe("/custom/home/config.json");
});

test("AGENTBRIDGE_HOME moves Windows default paths", () => {
	const dirs = resolveDirs({ AGENTBRIDGE_HOME: "D:\\agentbridge" }, "win32", "C:\\Users\\tester");
	expect(dirs.homeDir).toBe("D:\\agentbridge");
	expect(dirs.runtimeDir).toBe(win32.join("D:\\agentbridge", "run"));
	expect(dirs.stateDir).toBe(win32.join("D:\\agentbridge", "state"));
	expect(dirs.configFile).toBe(win32.join("D:\\agentbridge", "config.json"));
});

test("each path override beats AGENTBRIDGE_HOME independently", () => {
	const cases = [
		{ env: { AGENTBRIDGE_CONFIG: "/tmp/config.json" }, field: "configFile", expected: "/tmp/config.json" },
		{ env: { AGENTBRIDGE_STATE_DIR: "/tmp/state" }, field: "stateDir", expected: "/tmp/state" },
		{ env: { AGENTBRIDGE_RUNTIME_DIR: "/tmp/run" }, field: "runtimeDir", expected: "/tmp/run" },
	] as const;
	for (const { env, field, expected } of cases) {
		const dirs = resolveDirs({ AGENTBRIDGE_HOME: "/base/home", ...env }, "linux", "/home/tester");
		expect(dirs.homeDir).toBe("/base/home");
		expect(dirs[field]).toBe(expected);
	}
});

test("a runtime override moves sessions and sockets with it", () => {
	const dirs = resolveDirs(
		{ AGENTBRIDGE_HOME: "/base/home", AGENTBRIDGE_RUNTIME_DIR: "/tmp/run" },
		"linux",
		"/home/tester",
	);
	expect(dirs.sessionsDir).toBe("/tmp/run/sessions");
	expect(dirs.socketsDir).toBe("/tmp/run/s");
	expect(dirs.stateDir).toBe("/base/home/state");
});

test("creates a nested 0700 directory", async () => {
	const root = tempDir();
	const nested = join(root, "a", "b");
	await ensureSecureDir(nested);
	expect(statSync(nested).mode & 0o777).toBe(0o700);
});

test("rejects a group/other-accessible directory", async () => {
	const root = tempDir();
	const wide = join(root, "wide");
	mkdirSync(wide, { mode: 0o755 });
	chmodSync(wide, 0o755);
	let error: unknown;
	try {
		await ensureSecureDir(wide);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(InsecureDirError);
	expect((error as InsecureDirError).code).toBe("insecure_runtime_dir");
});

test("rejects symlinked directories", async () => {
	const root = tempDir();
	const target = join(root, "target");
	mkdirSync(target, { mode: 0o700 });
	const link = join(root, "link");
	symlinkSync(target, link);
	let error: unknown;
	try {
		await ensureSecureDir(link);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(InsecureDirError);
});

test("assertSecureDir checks but never creates", async () => {
	const root = tempDir();
	const missing = join(root, "missing");
	await expect(assertSecureDir(missing)).rejects.toThrow();
	expect(() => statSync(missing)).toThrow();

	const secure = join(root, "secure");
	mkdirSync(secure, { mode: 0o700 });
	await assertSecureDir(secure);
});

test("creates the AgentBridge home and runtime layout with 0700", async () => {
	const root = tempDir();
	const home = join(root, "home");
	const dirs = resolveDirs(
		{ AGENTBRIDGE_HOME: home, AGENTBRIDGE_RUNTIME_DIR: join(root, "rt") },
		"linux",
		root,
	);
	await ensureRuntimeDirs(dirs);
	for (const path of [dirs.homeDir, dirs.runtimeDir, dirs.sessionsDir, dirs.socketsDir]) {
		expect(statSync(path).mode & 0o777).toBe(0o700);
	}
});

test("writes files atomically with mode 0600", async () => {
	const root = tempDir();
	const file = join(root, "data.json");
	writeFileSync(file, "old");
	chmodSync(file, 0o644);

	await writeFileAtomic(file, "new");
	expect(readFileSync(file, "utf8")).toBe("new");
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("atomic writes survive a leftover tmp file", async () => {
	const root = tempDir();
	const file = join(root, "data.json");
	writeFileSync(`${file}.deadbeef.tmp`, "partial");
	await writeFileAtomic(file, "complete");
	expect(readFileSync(file, "utf8")).toBe("complete");
});
