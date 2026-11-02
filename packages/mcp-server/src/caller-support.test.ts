import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	type CallerSupportDeps,
	evaluateCallerSupport,
	hasOmpAncestor,
	isOmpProcessName,
	unsupportedCallerMessage,
} from "./caller-support";
import type { BridgeIdentity } from "./identity";
import { createGuardedAgentBridgeServer } from "./index";
import { createToolHandlers } from "./tools";

const PROJECT = "/tmp/agentbridge-project";

function identity(confidence: "pid" | "env"): BridgeIdentity {
	return {
		sessionId: `${confidence}-session`,
		pid: 500,
		cwd: PROJECT,
		confidence,
		projectRoot: PROJECT,
	};
}

function deps(overrides: Partial<CallerSupportDeps> = {}): CallerSupportDeps {
	return {
		ppid: 500,
		platform: "linux",
		readParentPid: async (pid) => (pid === 500 ? 400 : pid === 400 ? 300 : undefined),
		readProcessName: async () => "bash",
		resolveIdentity: async () => identity("pid"),
		...overrides,
	};
}

describe("isOmpProcessName", () => {
	test("matches the bare executable and a path, case-insensitively", () => {
		expect(isOmpProcessName("omp")).toBe(true);
		expect(isOmpProcessName(" OMP ")).toBe(true);
		expect(isOmpProcessName("/usr/local/bin/omp")).toBe(true);
	});

	test("does not match other processes", () => {
		for (const name of [undefined, "", "node", "omp-something", "bun"]) {
			expect(isOmpProcessName(name)).toBe(false);
		}
	});
});

describe("hasOmpAncestor", () => {
	test("detects omp as the direct parent", async () => {
		expect(await hasOmpAncestor(deps({ readProcessName: async () => "omp" }))).toBe(true);
	});

	test("detects omp higher in the chain and stops after it", async () => {
		const names: number[] = [];
		const found = await hasOmpAncestor(
			deps({
				readProcessName: async (pid) => {
					names.push(pid);
					return pid === 400 ? "omp" : "bash";
				},
			}),
		);
		expect(found).toBe(true);
		expect(names).toEqual([500, 400]);
	});

	test("returns false for an unrelated chain", async () => {
		expect(await hasOmpAncestor(deps())).toBe(false);
	});

	test("stops on pid 1, cycles, and reader errors", async () => {
		expect(await hasOmpAncestor(deps({ ppid: 1 }))).toBe(false);
		expect(
			await hasOmpAncestor(
				deps({
					readParentPid: async (pid) => (pid === 500 ? 400 : pid === 400 ? 500 : undefined),
				}),
			),
		).toBe(false);
		expect(
			await hasOmpAncestor(
				deps({
					readProcessName: async () => {
						throw new Error("permission denied");
					},
				}),
			),
		).toBe(false);
		expect(
			await hasOmpAncestor(
				deps({
					readParentPid: async () => {
						throw new Error("permission denied");
					},
				}),
			),
		).toBe(false);
	});

	test("honors the depth cap", async () => {
		expect(
			await hasOmpAncestor(
				deps({
					ppid: 500,
					maxDepth: 1,
					readProcessName: async (pid) => (pid === 400 ? "omp" : "bash"),
				}),
			),
		).toBe(false);
	});
});

describe("evaluateCallerSupport", () => {
	test("supports a pid-matched Claude Code session", async () => {
		const support = await evaluateCallerSupport(deps({ resolveIdentity: async () => identity("pid") }));
		expect(support).toEqual({ supported: true, identity: identity("pid") });
	});

	test("supports an env-only Claude Code session", async () => {
		const support = await evaluateCallerSupport(deps({ resolveIdentity: async () => identity("env") }));
		expect(support.supported).toBe(true);
		if (support.supported) expect(support.identity.confidence).toBe("env");
	});

	test("rejects a caller with neither pid nor env identity", async () => {
		const support = await evaluateCallerSupport(deps({ resolveIdentity: async () => undefined }));
		expect(support).toEqual({ supported: false, reason: "no_claude_session" });
	});

	test("rejects an empty session id", async () => {
		const support = await evaluateCallerSupport(
			deps({ resolveIdentity: async () => ({ ...identity("env"), sessionId: "   " }) }),
		);
		expect(support).toEqual({ supported: false, reason: "no_claude_session" });
	});

	test("an omp ancestor overrides an env identity", async () => {
		const support = await evaluateCallerSupport(
			deps({
				readProcessName: async (pid) => (pid === 500 ? "omp" : "bash"),
				resolveIdentity: async () => identity("env"),
			}),
		);
		expect(support).toEqual({ supported: false, reason: "omp_ancestor" });
	});

	test("an omp ancestor overrides a pid identity", async () => {
		const support = await evaluateCallerSupport(
			deps({
				readProcessName: async (pid) => (pid === 400 ? "omp" : "bash"),
				resolveIdentity: async () => identity("pid"),
			}),
		);
		expect(support).toEqual({ supported: false, reason: "omp_ancestor" });
	});

	test("a throwing identity resolver is unsupported, not an exception", async () => {
		const support = await evaluateCallerSupport(
			deps({
				resolveIdentity: async () => {
					throw new Error("claude agents failed");
				},
			}),
		);
		expect(support).toEqual({ supported: false, reason: "no_claude_session" });
	});
});

describe("unsupported caller behavior", () => {
	test("logs one clear line per reason", () => {
		for (const reason of ["no_claude_session", "omp_ancestor"] as const) {
			const message = unsupportedCallerMessage(reason);
			expect(message).toContain("[AgentBridge] unsupported_caller");
			expect(message).not.toContain("\n");
		}
	});

	test("registers and serves no tools for an unsupported caller", async () => {
		const lines: string[] = [];
		const { server, support } = await createGuardedAgentBridgeServer(
			{},
			deps({ resolveIdentity: async () => undefined }),
			{ onUnsupported: (message) => lines.push(message) },
		);
		expect(support).toEqual({ supported: false, reason: "no_claude_session" });
		expect(lines).toHaveLength(1);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);

			expect(client.getServerCapabilities()?.tools).toBeDefined();
			const listed = await client.listTools();
			expect(listed.tools).toEqual([]);
			const called = await client.callTool({ name: "agent_status", arguments: {} });
			expect(called.isError).toBe(true);
			expect(JSON.stringify(called.content)).toContain("unsupported_caller");
		} finally {
			await client.close();
			await server.close();
		}
	});

	test("tool handlers fail closed if a caller bypasses registration", async () => {
		const handlers = createToolHandlers({ resolveIdentity: async () => undefined });
		const result = await handlers.status({});
		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("[AgentBridge] unsupported_caller");
	});
});
