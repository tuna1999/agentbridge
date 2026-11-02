/** Resolve which Claude Code session this MCP server belongs to. Spec: 01 §8.1. */
import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { getParentPid, gitInfo } from "@agentbridge/core";
import { type GitInfo, isRecord } from "@agentbridge/protocol";

const AGENTS_TIMEOUT_MS = 5_000;
const AGENTS_CACHE_MS = 5_000;
const MAX_PID_DEPTH = 4;

export interface ClaudeAgentInfo {
	pid: number;
	sessionId: string;
	cwd: string;
}

export type ClaudeAgentsRunner = () => Promise<string>;

export interface IdentityDeps {
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	ppid?: number;
	cwd?: () => string;
	readParentPid?: (pid: number) => Promise<number | undefined>;
	runClaudeAgents?: ClaudeAgentsRunner;
	realpath?: (path: string) => Promise<string>;
	gitInfo?: (dir: string) => Promise<GitInfo | undefined>;
	now?: () => number;
}

export interface BridgeIdentity {
	sessionId: string;
	pid: number;
	cwd: string;
	confidence: "pid" | "env";
	projectRoot: string;
	git?: GitInfo;
}

export interface IdentityResolver {
	/** `undefined` means no Claude Code session was found; callers must not invent one. */
	resolve(): Promise<BridgeIdentity | undefined>;
}

async function defaultRunClaudeAgents(): Promise<string> {
	const proc = Bun.spawn(["claude", "agents", "--json"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		env: process.env,
	});
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already exited
		}
	}, AGENTS_TIMEOUT_MS);
	try {
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) throw new Error(`claude agents --json exited with ${exitCode}`);
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}

function parseAgents(raw: string): ClaudeAgentInfo[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;

	const agents: ClaudeAgentInfo[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) continue;
		const { pid, sessionId, cwd } = item;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
		if (typeof sessionId !== "string" || sessionId.length === 0) continue;
		if (typeof cwd !== "string" || cwd.length === 0) continue;
		agents.push({ pid, sessionId, cwd });
	}
	return agents;
}

async function collectPids(
	ppid: number,
	platform: NodeJS.Platform,
	readParentPid: (pid: number) => Promise<number | undefined>,
): Promise<number[]> {
	const pids = [ppid];
	if (platform === "win32") return pids; // TODO(T11): Windows has no /proc chain here.
	let current = ppid;
	for (let depth = 1; depth < MAX_PID_DEPTH; depth += 1) {
		let parent: number | undefined;
		try {
			parent = await readParentPid(current);
		} catch {
			parent = undefined;
		}
		if (parent === undefined || parent <= 0 || pids.includes(parent)) break;
		pids.push(parent);
		current = parent;
	}
	return pids;
}

/**
 * A resolver owns the 5-second `claude agents --json` cache. The MCP server calls
 * `resolve()` on every tool call so `/clear` (which changes sessionId) is picked up.
 */
export function createIdentityResolver(deps: IdentityDeps = {}): IdentityResolver {
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const ppid = deps.ppid ?? process.ppid;
	const cwd = deps.cwd ?? (() => process.cwd());
	const readParentPid = deps.readParentPid ?? getParentPid;
	const runAgents = deps.runClaudeAgents ?? defaultRunClaudeAgents;
	const realpathFn = deps.realpath ?? realpath;
	const gitInfoFn = deps.gitInfo ?? gitInfo;
	const now = deps.now ?? Date.now;

	let cache: { at: number; agents: ClaudeAgentInfo[] | undefined } | undefined;

	async function agents(): Promise<ClaudeAgentInfo[] | undefined> {
		const at = now();
		if (cache !== undefined && at - cache.at < AGENTS_CACHE_MS) return cache.agents;
		let parsed: ClaudeAgentInfo[] | undefined;
		try {
			parsed = parseAgents(await runAgents());
		} catch {
			parsed = undefined;
		}
		cache = { at, agents: parsed };
		return parsed;
	}

	async function resolve(): Promise<BridgeIdentity | undefined> {
		const pids = await collectPids(ppid, platform, readParentPid);
		const list = await agents();
		const me = list?.find((agent) => pids.includes(agent.pid));
		const envSessionId = env.CLAUDE_CODE_SESSION_ID;

		// No pid match and no usable environment identity: unsupported caller.
		// There is deliberately no "unknown" fallback that would expose tools.
		if (me === undefined && (envSessionId === undefined || envSessionId.trim().length === 0)) {
			return undefined;
		}

		const rootCandidate = env.CLAUDE_PROJECT_DIR ?? me?.cwd ?? cwd();
		let projectRoot: string;
		try {
			projectRoot = await realpathFn(rootCandidate);
		} catch {
			projectRoot = resolvePath(rootCandidate);
		}

		let git: GitInfo | undefined;
		try {
			git = await gitInfoFn(projectRoot);
		} catch {
			git = undefined;
		}

		let identity: BridgeIdentity;
		if (me !== undefined) {
			identity = {
				sessionId: me.sessionId,
				pid: me.pid,
				cwd: me.cwd,
				confidence: "pid",
				projectRoot,
			};
		} else if (envSessionId !== undefined) {
			identity = {
				sessionId: envSessionId,
				pid: ppid,
				cwd: env.CLAUDE_PROJECT_DIR ?? cwd(),
				confidence: "env",
				projectRoot,
			};
		} else {
			return undefined;
		}
		if (git !== undefined) identity.git = git;
		return identity;
	}

	return { resolve };
}

let defaultResolver: IdentityResolver | undefined;

/** Process-wide resolver with the 5-second agent cache. */
export function resolveIdentity(): Promise<BridgeIdentity | undefined> {
	defaultResolver ??= createIdentityResolver();
	return defaultResolver.resolve();
}
