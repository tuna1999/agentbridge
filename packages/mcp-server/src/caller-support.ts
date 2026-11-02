/**
 * Startup guard for the MCP server. Spec: 01 §8.1.
 *
 * The server only exposes tools to Claude Code. A pid-verified or env-provided
 * Claude Code session is required, and an `omp` process in the ancestor chain
 * always wins: AgentBridge must never offer its tools back to OMP itself.
 */
import { getParentPid, getProcessName } from "@agentbridge/core";
import { type BridgeIdentity, resolveIdentity } from "./identity";

const MAX_ANCESTOR_DEPTH = 32;

export type UnsupportedCallerReason = "no_claude_session" | "omp_ancestor";

export type CallerSupport =
 | { supported: true; identity: BridgeIdentity }
 | { supported: false; reason: UnsupportedCallerReason };

export interface OmpAncestorDeps {
 /** Parent pid of the MCP server process. */
 ppid: number;
 platform?: NodeJS.Platform;
 readParentPid?: (pid: number) => Promise<number | undefined>;
 readProcessName?: (pid: number) => Promise<string | undefined>;
 maxDepth?: number;
}

export interface CallerSupportDeps extends OmpAncestorDeps {
 resolveIdentity: () => Promise<BridgeIdentity | undefined>;
}

/** Compare the executable name only; `/proc/<pid>/comm` can be a bare name or a path. */
export function isOmpProcessName(name: string | undefined): boolean {
 if (name === undefined) return false;
 const base = name.trim().split(/[\\/]/).pop();
 return base?.toLowerCase() === "omp";
}

/**
 * Walk from the MCP server's parent upwards. Errors, cycles, pid 1 and the
 * depth cap all terminate the walk without claiming an OMP ancestor.
 */
export async function hasOmpAncestor(deps: OmpAncestorDeps): Promise<boolean> {
 const platform = deps.platform ?? process.platform;
 if (platform === "win32" || !Number.isInteger(deps.ppid) || deps.ppid <= 0) return false;

 const readParentPid = deps.readParentPid ?? getParentPid;
 const readProcessName = deps.readProcessName ?? getProcessName;
 const maxDepth = deps.maxDepth ?? MAX_ANCESTOR_DEPTH;
 const visited = new Set<number>();
 let current = deps.ppid;

 for (let depth = 0; depth < maxDepth; depth += 1) {
  if (!Number.isInteger(current) || current <= 0 || current === 1 || visited.has(current)) return false;
  visited.add(current);

  let name: string | undefined;
  try {
   name = await readProcessName(current);
  } catch {
   name = undefined;
  }
  if (isOmpProcessName(name)) return true;

  let parent: number | undefined;
  try {
   parent = await readParentPid(current);
  } catch {
   return false;
  }
  if (parent === undefined) return false;
  current = parent;
 }
 return false;
}

/**
 * `omp` ancestry overrides both pid and env matches. When no Claude Code
 * session can be resolved the caller is unsupported; no identity is invented.
 */
export async function evaluateCallerSupport(deps: CallerSupportDeps): Promise<CallerSupport> {
 if (await hasOmpAncestor(deps)) return { supported: false, reason: "omp_ancestor" };

 let identity: BridgeIdentity | undefined;
 try {
  identity = await deps.resolveIdentity();
 } catch {
  identity = undefined;
 }
 if (identity === undefined || identity.sessionId.trim().length === 0) {
  return { supported: false, reason: "no_claude_session" };
 }
 return { supported: true, identity };
}

export function unsupportedCallerMessage(reason: UnsupportedCallerReason): string {
 return reason === "omp_ancestor"
  ? "[AgentBridge] unsupported_caller: an omp process is in the ancestor chain; no tools registered"
  : "[AgentBridge] unsupported_caller: no Claude Code session; no tools registered";
}

export function defaultCallerSupportDeps(): CallerSupportDeps {
 return {
  ppid: process.ppid,
  platform: process.platform,
  resolveIdentity,
 };
}
