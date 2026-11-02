/** Git metadata. Spec: 01 §3.4. */
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { GitInfo } from "@agentbridge/protocol";

const GIT_TIMEOUT_MS = 2_000;

function spawnGit(dir: string): Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined {
	try {
		return Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], {
			stdout: "pipe",
			stderr: "ignore",
			env: process.env,
		});
	} catch {
		return undefined;
	}
}

/** Resolve worktree/commonDir/branch; `undefined` outside a repo or on error. */
export async function gitInfo(dir: string): Promise<GitInfo | undefined> {
	const proc = spawnGit(dir);
	if (proc === undefined) return undefined;

	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// already exited
		}
	}, GIT_TIMEOUT_MS);

	let exitCode: number;
	try {
		exitCode = await proc.exited;
	} finally {
		clearTimeout(timer);
	}
	if (exitCode !== 0) return undefined;

	const lines = (await new Response(proc.stdout).text()).trimEnd().split("\n");
	if (lines.length < 3) return undefined;
	const [worktreeRaw, commonRaw, branch] = lines;
	if (worktreeRaw === undefined || commonRaw === undefined || worktreeRaw === "" || commonRaw === "") return undefined;

	try {
		const worktree = await realpath(worktreeRaw);
		const commonDir = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(dir, commonRaw));
		const info: GitInfo = { worktree, commonDir };
		if (branch !== undefined && branch.length > 0) info.branch = branch;
		return info;
	} catch {
		return undefined;
	}
}
