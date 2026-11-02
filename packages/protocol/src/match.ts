/** Deterministic session-target matching. Spec: docs/plan/01-design-spec.md §8.2. Pure, no I/O. */
import type { AgentStatus, GitInfo, ModelRef } from "./envelope";

export type MatchLiveness = "alive" | "unresponsive";

/**
 * Structural subset of the registry's SessionRecord (01 §3.1).
 * Protocol must not depend on core, so matching accepts any record carrying these fields.
 */
export interface MatchableSession {
 sessionId: string;
 sessionName?: string;
 cwd: string;
 git?: GitInfo;
 model?: ModelRef;
 status: AgentStatus;
 startedAt: number;
}

export type MatchCandidate<R extends MatchableSession = MatchableSession> = R & {
 liveness: MatchLiveness;
};

export interface SelectTargetInput<R extends MatchableSession = MatchableSession> {
 callerWorktree?: string;
 callerCommonDir?: string;
 callerRoot: string;
 candidates: MatchCandidate<R>[];
 target?: string;
 allowCrossProject: boolean;
 caseInsensitive: boolean;
}

/** A candidate as offered to the user when selection fails. */
export interface MatchSummary {
 sessionId: string;
 sessionName?: string;
 model?: ModelRef;
 status: AgentStatus;
 liveness: MatchLiveness;
 startedAt: number;
}

export type SelectTargetErrorCode = "no_target" | "ambiguous_target" | "target_not_found" | "cross_project";

export type SelectTargetResult<R extends MatchableSession = MatchableSession> =
 | { kind: "selected"; rec: MatchCandidate<R> }
 | { kind: "error"; code: SelectTargetErrorCode; options: MatchSummary[] };

const MIN_PREFIX_LENGTH = 8;

interface MatchContext {
 callerWorktree?: string;
 callerCommonDir: string | undefined;
 callerRoot: string;
 caseInsensitive: boolean;
}

/** Strip trailing separators; on Windows also fold separators and case. */
function normalizePath(path: string, caseInsensitive: boolean): string {
 const stripped = path.replace(/[\\/]+$/, "");
 const rooted = stripped.length === 0 ? "/" : stripped;
 return caseInsensitive ? rooted.replace(/\\/g, "/").toLowerCase() : rooted;
}

function samePath(a: string | undefined, b: string | undefined, caseInsensitive: boolean): boolean {
 return a !== undefined && b !== undefined && normalizePath(a, caseInsensitive) === normalizePath(b, caseInsensitive);
}

function sameWorktree(rec: MatchableSession, ctx: MatchContext): boolean {
 if (ctx.callerWorktree !== undefined) {
  // A record without git info still lives somewhere; its cwd is its worktree.
  return samePath(rec.git?.worktree ?? rec.cwd, ctx.callerWorktree, ctx.caseInsensitive);
 }
 return samePath(rec.cwd, ctx.callerRoot, ctx.caseInsensitive);
}

function summarize(rec: MatchCandidate<MatchableSession>): MatchSummary {
 const summary: MatchSummary = {
  sessionId: rec.sessionId,
  status: rec.status,
  liveness: rec.liveness,
  startedAt: rec.startedAt,
 };
 if (rec.sessionName !== undefined) summary.sessionName = rec.sessionName;
 if (rec.model !== undefined) summary.model = rec.model;
 return summary;
}

function summarizeAll(recs: MatchCandidate<MatchableSession>[]): MatchSummary[] {
 return recs.map(summarize);
}

function error(code: SelectTargetErrorCode, options: MatchSummary[]): { kind: "error"; code: SelectTargetErrorCode; options: MatchSummary[] } {
 return { kind: "error", code, options };
}

/**
 * Target precedence: exact sessionId, then a unique prefix of at least 8 characters,
 * then an exact unique sessionName. The first stage with any match decides the outcome.
 */
function matchByTarget<R extends MatchableSession>(candidates: MatchCandidate<R>[], target: string): MatchCandidate<R>[] | undefined {
 const exact = candidates.filter((c) => c.sessionId === target);
 if (exact.length > 0) return exact;

 if (target.length >= MIN_PREFIX_LENGTH) {
  const prefixed = candidates.filter((c) => c.sessionId.startsWith(target));
  if (prefixed.length > 0) return prefixed;
 }

 const named = candidates.filter((c) => c.sessionName === target);
 return named.length > 0 ? named : undefined;
}

export function selectTarget<R extends MatchableSession>(input: SelectTargetInput<R>): SelectTargetResult<R> {
 const ctx: MatchContext = {
  callerWorktree: input.callerWorktree,
  callerCommonDir: input.callerCommonDir,
  callerRoot: input.callerRoot,
  caseInsensitive: input.caseInsensitive,
 };
 const candidates = input.candidates as MatchCandidate<MatchableSession>[];
 const target = input.target;

 if (target !== undefined) {
  const matched = matchByTarget(candidates, target);
  if (matched === undefined) return error("target_not_found", []);
  if (matched.length > 1) return error("ambiguous_target", summarizeAll(matched));

  const rec = matched[0] as MatchCandidate<R>;
  const isSameProject =
   sameWorktree(rec, ctx) ||
   (ctx.callerCommonDir !== undefined &&
    samePath(rec.git?.commonDir, ctx.callerCommonDir, ctx.caseInsensitive)) ||
   samePath(rec.cwd, ctx.callerRoot, ctx.caseInsensitive) ||
   samePath(rec.git?.worktree, ctx.callerRoot, ctx.caseInsensitive);
  if (!input.allowCrossProject && !isSameProject) {
   return error("cross_project", [summarize(rec)]);
  }
  // An unresponsive session is never selected; it is only offered as a note.
  if (rec.liveness !== "alive") return error("target_not_found", [summarize(rec)]);
  return { kind: "selected", rec };
 }

 // No target: only alive sessions in the same worktree are eligible. Never pick "newest".
 const worktreeMatches = candidates.filter((c) => sameWorktree(c, ctx));
 const selectable = worktreeMatches.filter((c) => c.liveness === "alive");
 if (selectable.length === 1) return { kind: "selected", rec: selectable[0] as MatchCandidate<R> };
 if (selectable.length > 1) return error("ambiguous_target", summarizeAll(worktreeMatches));

 // Nothing selectable here: offer same-repo worktrees first, then unresponsive same-worktree sessions.
 const repoSiblings = candidates.filter(
  (c) =>
   !sameWorktree(c, ctx) &&
   ctx.callerCommonDir !== undefined &&
   samePath(c.git?.commonDir, ctx.callerCommonDir, ctx.caseInsensitive),
 );
 if (repoSiblings.length > 0) return error("no_target", summarizeAll(repoSiblings));
 return error("no_target", summarizeAll(worktreeMatches));
}
