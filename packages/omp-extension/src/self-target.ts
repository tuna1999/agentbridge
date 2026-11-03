/**
 * Self-target detection for consult/chat. Spec: 01 §7.8.
 *
 * A caller is a self-target when its pid is OMP's pid, an ancestor of OMP, or
 * a descendant of OMP. The walk is bounded and tolerant of process races.
 */
const MAX_SELF_TARGET_DEPTH = 64;

export interface SelfTargetDeps {
 selfPid: number;
 readParentPid: (pid: number) => Promise<number | undefined>;
 maxDepth?: number;
}

async function chainContains(start: number, target: number, deps: SelfTargetDeps): Promise<boolean> {
 const maxDepth = deps.maxDepth ?? MAX_SELF_TARGET_DEPTH;
 const visited = new Set<number>([start]);
 let current = start;

 for (let depth = 0; depth < maxDepth; depth += 1) {
  let parent: number | undefined;
  try {
   parent = await deps.readParentPid(current);
  } catch {
   return false;
  }
  // pid 1 is the terminal ancestor, never a caller identity.
  if (parent === undefined || !Number.isInteger(parent) || parent <= 1) return false;
  if (parent === target) return true;
  if (visited.has(parent)) return false;
  visited.add(parent);
  current = parent;
 }
 return false;
}

export async function isSelfTarget(callerPid: number | undefined, deps: SelfTargetDeps): Promise<boolean> {
 if (callerPid === undefined) return false;
 if (!Number.isInteger(callerPid) || callerPid <= 1) return false;
 if (!Number.isInteger(deps.selfPid) || deps.selfPid <= 1) return false;
 if (callerPid === deps.selfPid) return true;

 // Caller descendant of OMP, or caller ancestor of OMP.
 return (
  (await chainContains(callerPid, deps.selfPid, deps)) ||
  (await chainContains(deps.selfPid, callerPid, deps))
 );
}
