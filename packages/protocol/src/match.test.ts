import { expect, test } from "bun:test";
import {
	type MatchCandidate,
	type MatchSummary,
	type SelectTargetErrorCode,
	type SelectTargetInput,
	type SelectTargetResult,
	selectTarget,
} from "./index";

const A = "0199aaaa-0000-7000-8000-000000000001";
const B = "0199bbbb-0000-7000-8000-000000000002";
const C = "0199cccc-0000-7000-8000-000000000003";
const D = "0199aaaa-1111-7000-8000-000000000004";
const REPO = "/work/repo";
const COMMON = `${REPO}/.git`;

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
	return {
		sessionId: A,
		cwd: REPO,
		git: { worktree: REPO, commonDir: COMMON },
		model: { provider: "openai", id: "gpt-5" },
		status: "idle",
		startedAt: 1_700_000_000_000,
		liveness: "alive",
		...overrides,
	};
}

function match(overrides: Partial<SelectTargetInput> = {}): SelectTargetResult {
	return selectTarget({
		callerWorktree: REPO,
		callerCommonDir: COMMON,
		callerRoot: REPO,
		candidates: [],
		allowCrossProject: false,
		caseInsensitive: false,
		...overrides,
	});
}

function expectError(result: SelectTargetResult, code: SelectTargetErrorCode): MatchSummary[] {
	expect(result.kind).toBe("error");
	if (result.kind !== "error") throw new Error("expected an error result");
	expect(result.code).toBe(code);
	return result.options;
}

function expectSelected(result: SelectTargetResult): MatchCandidate {
	expect(result.kind).toBe("selected");
	if (result.kind !== "selected") throw new Error("expected a selected result");
	return result.rec;
}

const summary = (rec: MatchCandidate): MatchSummary => ({
	sessionId: rec.sessionId,
	status: rec.status,
	liveness: rec.liveness,
	startedAt: rec.startedAt,
	...(rec.sessionName === undefined ? {} : { sessionName: rec.sessionName }),
	...(rec.model === undefined ? {} : { model: rec.model }),
});

test("0 candidates -> no_target with no options", () => {
	expect(match()).toEqual({ kind: "error", code: "no_target", options: [] });
});

test("1 alive candidate in the same worktree -> selected", () => {
	const rec = candidate();
	expect(expectSelected(match({ candidates: [rec] }))).toBe(rec);
});

test("2 alive candidates in the same worktree -> ambiguous_target with both options", () => {
	const a = candidate();
	const b = candidate({ sessionId: B, sessionName: "reviewer", status: "busy" });
	const options = expectError(match({ candidates: [a, b] }), "ambiguous_target");
	expect(options).toEqual([summary(a), summary(b)]);
});

test("unresponsive candidate is never auto-selected; the single alive one wins", () => {
	const alive = candidate();
	const dead = candidate({ sessionId: B, liveness: "unresponsive" });
	expect(expectSelected(match({ candidates: [alive, dead] }))).toBe(alive);
});

test("only unresponsive candidates in the same worktree -> no_target with notes", () => {
	const dead = candidate({ liveness: "unresponsive" });
	const options = expectError(match({ candidates: [dead] }), "no_target");
	expect(options).toEqual([summary(dead)]);
	expect(options[0]?.liveness).toBe("unresponsive");
});

test("two unresponsive candidates are not ambiguous; both are offered as options", () => {
	const first = candidate({ liveness: "unresponsive" });
	const second = candidate({ sessionId: B, liveness: "unresponsive" });
	const options = expectError(match({ candidates: [first, second] }), "no_target");
	expect(options.map((o) => o.sessionId)).toEqual([A, B]);
});

test("same repo but a different worktree -> no_target with that worktree in options", () => {
	const sibling = candidate({
		cwd: "/work/repo-feature",
		git: { worktree: "/work/repo-feature", commonDir: COMMON },
	});
	const options = expectError(match({ candidates: [sibling] }), "no_target");
	expect(options).toEqual([summary(sibling)]);
});

test("nested repositories (parent/child) do not match", () => {
	const child = candidate({
		cwd: `${REPO}/packages/child`,
		git: { worktree: `${REPO}/packages/child`, commonDir: `${REPO}/packages/child/.git` },
	});
	expect(expectError(match({ candidates: [child] }), "no_target")).toEqual([]);
});

test("no git: compares cwd with callerRoot", () => {
	const rec = candidate({ git: undefined });
	const result = match({ callerWorktree: undefined, callerCommonDir: undefined, candidates: [rec] });
	expect(expectSelected(result)).toBe(rec);
});

test("trailing slash on the caller worktree still matches", () => {
	const rec = candidate();
	expect(expectSelected(match({ callerWorktree: `${REPO}/`, candidates: [rec] }))).toBe(rec);
});

test("caseInsensitive folds Windows case and separators", () => {
	const rec = candidate({
		cwd: "c:/work/repo",
		git: { worktree: "c:/work/repo", commonDir: "c:/work/repo/.git" },
	});
	const result = match({
		callerWorktree: "C:\\Work\\Repo\\",
		callerCommonDir: "C:\\Work\\Repo\\.git",
		callerRoot: "C:\\Work\\Repo\\",
		caseInsensitive: true,
		candidates: [rec],
	});
	expect(expectSelected(result)).toBe(rec);
});

test("case-sensitive paths reject a different case", () => {
	const rec = candidate({
		cwd: "/WORK/repo",
		git: { worktree: "/WORK/repo", commonDir: "/WORK/repo/.git" },
	});
	expect(expectError(match({ candidates: [rec] }), "no_target")).toEqual([]);
});

test("target: full sessionId selects exactly that session", () => {
	const a = candidate();
	const b = candidate({ sessionId: B });
	expect(expectSelected(match({ candidates: [a, b], target: B }))).toBe(b);
});

test("target: 7-character prefix is rejected", () => {
	const a = candidate();
	const d = candidate({ sessionId: D });
	expect(expectError(match({ candidates: [a, d], target: A.slice(0, 7) }), "target_not_found")).toEqual([]);
});

test("target: unique 8-character prefix selects", () => {
	const a = candidate();
	const b = candidate({ sessionId: B });
	expect(expectSelected(match({ candidates: [a, b], target: B.slice(0, 8) }))).toBe(b);
});

test("target: 8-character prefix shared by two sessions is ambiguous", () => {
	const a = candidate();
	const d = candidate({ sessionId: D });
	const options = expectError(match({ candidates: [a, d], target: A.slice(0, 8) }), "ambiguous_target");
	expect(options.map((o) => o.sessionId)).toEqual([A, D]);
});

test("target: unique sessionName selects", () => {
	const rec = candidate({ sessionName: "reviewer" });
	expect(expectSelected(match({ candidates: [rec], target: "reviewer" }))).toBe(rec);
});

test("target: duplicate sessionName is ambiguous", () => {
	const first = candidate({ sessionName: "reviewer" });
	const second = candidate({ sessionId: B, sessionName: "reviewer" });
	const options = expectError(match({ candidates: [first, second], target: "reviewer" }), "ambiguous_target");
	expect(options.map((o) => o.sessionId)).toEqual([A, B]);
});

test("target: prefix stage runs before the sessionName stage", () => {
	const b = candidate({ sessionId: B });
	const named = candidate({ sessionId: C, sessionName: B.slice(0, 8) });
	expect(expectSelected(match({ candidates: [b, named], target: B.slice(0, 8) }))).toBe(b);
});

test("target in another project -> cross_project unless allowed", () => {
	const other = candidate({
		cwd: "/work/other",
		git: { worktree: "/work/other", commonDir: "/work/other/.git" },
	});
	const denied = expectError(match({ candidates: [other], target: A }), "cross_project");
	expect(denied).toEqual([summary(other)]);
	expect(expectSelected(match({ candidates: [other], target: A, allowCrossProject: true }))).toBe(other);
});

test("target in the same repo but another worktree is not cross-project", () => {
	const sibling = candidate({
		cwd: "/work/repo-feature",
		git: { worktree: "/work/repo-feature", commonDir: COMMON },
	});
	expect(expectSelected(match({ candidates: [sibling], target: A }))).toBe(sibling);
});

test("target in the caller root without git is not cross-project", () => {
	const rec = candidate({ git: undefined });
	const result = match({ callerWorktree: undefined, callerCommonDir: undefined, candidates: [rec], target: A });
	expect(expectSelected(result)).toBe(rec);
});

test("target on an unresponsive session -> target_not_found with a note", () => {
	const dead = candidate({ liveness: "unresponsive" });
	const options = expectError(match({ candidates: [dead], target: A }), "target_not_found");
	expect(options).toEqual([summary(dead)]);
	expect(options[0]?.liveness).toBe("unresponsive");
});

test("target that matches nothing -> target_not_found", () => {
	expect(expectError(match({ candidates: [candidate()], target: "nope" }), "target_not_found")).toEqual([]);
});
