import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfo } from "./index";

const cleanup: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ab-core-git-"));
	cleanup.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitEnv: Record<string, string | undefined> = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "AgentBridge Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "AgentBridge Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", env: gitEnv });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function initRepo(dir: string): Promise<void> {
	await git(dir, ["init", "-b", "main"]);
	writeFileSync(join(dir, "a.txt"), "a");
	await git(dir, ["add", "-A"]);
	await git(dir, ["commit", "-m", "init"]);
}

test("returns worktree, commonDir, and branch for a repository", async () => {
	const repo = tempDir();
	await initRepo(repo);

	const info = await gitInfo(repo);
	expect(info).toBeDefined();
	expect(info?.worktree).toBe(realpathSync(repo));
	expect(info?.commonDir).toBe(realpathSync(join(repo, ".git")));
	expect(info?.branch).toBe("main");
});

test("resolves a linked worktree to the shared commonDir", async () => {
	const repo = tempDir();
	await initRepo(repo);
	const worktree = join(tempDir(), "wt");
	await git(repo, ["worktree", "add", "-b", "wt-branch", worktree]);

	const info = await gitInfo(worktree);
	expect(info).toBeDefined();
	expect(info?.worktree).toBe(realpathSync(worktree));
	expect(info?.commonDir).toBe(realpathSync(join(repo, ".git")));
	expect(info?.branch).toBe("wt-branch");
});

test("returns undefined outside a repository", async () => {
	expect(await gitInfo(tempDir())).toBeUndefined();
});

test("resolves a symlink to a repository", async () => {
	const repo = tempDir();
	await initRepo(repo);
	const link = join(tempDir(), "link");
	symlinkSync(repo, link);

	const info = await gitInfo(link);
	expect(info).toBeDefined();
	expect(info?.worktree).toBe(realpathSync(repo));
	expect(info?.branch).toBe("main");
});
