import { describe, expect, test } from "bun:test";
import type { GitInfo } from "@agentbridge/protocol";
import { createIdentityResolver, type IdentityDeps } from "./identity";

const PROJECT = "/tmp/agentbridge-project";
const GIT: GitInfo = { worktree: PROJECT, commonDir: `${PROJECT}/.git`, branch: "main" };

function baseDeps(overrides: IdentityDeps = {}): IdentityDeps {
	return {
		platform: "linux",
		ppid: 500,
		env: {},
		cwd: () => "/fallback",
		readParentPid: async (pid) => (pid === 500 ? 400 : pid === 400 ? 300 : undefined),
		runClaudeAgents: async () => "[]",
		realpath: async (path) => path,
		gitInfo: async () => GIT,
		now: () => 0,
		...overrides,
	};
}

describe("identity", () => {
	test("matches the direct parent pid (level 1)", async () => {
		const resolver = createIdentityResolver(
			baseDeps({
				runClaudeAgents: async () =>
					JSON.stringify([
						{ pid: 999, sessionId: "other", cwd: "/other" },
						{ pid: 500, sessionId: "claude-level-1", cwd: PROJECT, name: "work" },
					]),
			}),
		);

		const identity = (await resolver.resolve())!;
		expect(identity.confidence).toBe("pid");
		expect(identity.sessionId).toBe("claude-level-1");
		expect(identity.pid).toBe(500);
		expect(identity.cwd).toBe(PROJECT);
		expect(identity.projectRoot).toBe(PROJECT);
		expect(identity.git).toEqual(GIT);
	});

	test("matches a grandparent pid (level 2)", async () => {
		const resolver = createIdentityResolver(
			baseDeps({
				runClaudeAgents: async () => JSON.stringify([{ pid: 400, sessionId: "claude-level-2", cwd: PROJECT }]),
			}),
		);

		const identity = (await resolver.resolve())!;
		expect(identity.confidence).toBe("pid");
		expect(identity.sessionId).toBe("claude-level-2");
		expect(identity.pid).toBe(400);
	});

	test("falls back to environment when no pid matches", async () => {
		const resolver = createIdentityResolver(
			baseDeps({
				env: { CLAUDE_CODE_SESSION_ID: "env-session", CLAUDE_PROJECT_DIR: "/env-project" },
				runClaudeAgents: async () => JSON.stringify([{ pid: 111, sessionId: "other", cwd: "/other" }]),
			}),
		);

		const identity = (await resolver.resolve())!;
		expect(identity.confidence).toBe("env");
		expect(identity.sessionId).toBe("env-session");
		expect(identity.pid).toBe(500);
		expect(identity.cwd).toBe("/env-project");
		expect(identity.projectRoot).toBe("/env-project");
	});

	test("falls back to env when claude is missing from PATH", async () => {
		const resolver = createIdentityResolver(
			baseDeps({
				env: { CLAUDE_CODE_SESSION_ID: "env-only" },
				runClaudeAgents: async () => {
					throw new Error("ENOENT: claude not found");
				},
			}),
		);

		const identity = (await resolver.resolve())!;
		expect(identity.confidence).toBe("env");
		expect(identity.sessionId).toBe("env-only");
		expect(identity.pid).toBe(500);
		expect(identity.cwd).toBe("/fallback");
	});

	test("env CLAUDE_PROJECT_DIR wins over the matched agent cwd", async () => {
		const resolver = createIdentityResolver(
			baseDeps({
				env: { CLAUDE_PROJECT_DIR: "/env-project" },
				runClaudeAgents: async () => JSON.stringify([{ pid: 500, sessionId: "from-pid", cwd: "/omp-cwd" }]),
			}),
		);

		const identity = (await resolver.resolve())!;
		expect(identity.sessionId).toBe("from-pid");
		expect(identity.cwd).toBe("/omp-cwd");
		expect(identity.projectRoot).toBe("/env-project");
	});

	test("caches claude agents output for 5 seconds", async () => {
		let calls = 0;
		let now = 0;
		const resolver = createIdentityResolver(
			baseDeps({
				now: () => now,
				runClaudeAgents: async () => {
					calls += 1;
					return "[]";
				},
			}),
		);

		await resolver.resolve();
		await resolver.resolve();
		expect(calls).toBe(1);

		now = 6_000;
		await resolver.resolve();
		expect(calls).toBe(2);
	});

	test("rejects malformed claude agents output and falls back", async () => {
		const resolver = createIdentityResolver(
			baseDeps({
				env: { CLAUDE_CODE_SESSION_ID: "fallback" },
				runClaudeAgents: async () => "not json",
			}),
		);

		const identity = (await resolver.resolve())!;
		expect(identity?.confidence).toBe("env");
		expect(identity?.sessionId).toBe("fallback");
	});

	test("returns undefined when neither pid nor env identifies a session", async () => {
		const resolver = createIdentityResolver(
			baseDeps({
				env: {},
				runClaudeAgents: async () => JSON.stringify([{ pid: 111, sessionId: "other", cwd: "/other" }]),
			}),
		);

		expect(await resolver.resolve()).toBeUndefined();
	});

	test("treats an empty or whitespace CLAUDE_CODE_SESSION_ID as missing", async () => {
		for (const value of ["", "   "]) {
			const resolver = createIdentityResolver(
				baseDeps({
					env: { CLAUDE_CODE_SESSION_ID: value },
					runClaudeAgents: async () => "[]",
				}),
			);

			expect(await resolver.resolve()).toBeUndefined();
		}
	});
});
