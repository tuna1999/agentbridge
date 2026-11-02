import { describe, expect, test } from "bun:test";
import { isSelfTarget, type SelfTargetDeps } from "./self-target";

function deps(overrides: Partial<SelfTargetDeps> = {}): SelfTargetDeps {
	return {
		selfPid: 300,
		readParentPid: async (pid) => {
			if (pid === 300) return 200;
			if (pid === 200) return 100;
			if (pid === 100) return 1;
			return undefined;
		},
		...overrides,
	};
}

describe("isSelfTarget", () => {
	test("direct equality", async () => {
		expect(await isSelfTarget(300, deps())).toBe(true);
	});

	test("caller is an ancestor of OMP", async () => {
		expect(await isSelfTarget(100, deps())).toBe(true);
		expect(await isSelfTarget(200, deps())).toBe(true);
	});

	test("caller is a descendant of OMP", async () => {
		const descendant = deps({
			readParentPid: async (pid) => {
				if (pid === 700) return 600;
				if (pid === 600) return 300;
				if (pid === 300) return 200;
				if (pid === 200) return 100;
				return 1;
			},
		});
		expect(await isSelfTarget(700, descendant)).toBe(true);
		expect(await isSelfTarget(600, descendant)).toBe(true);
	});

	test("unrelated pid", async () => {
		const unrelated = deps({
			readParentPid: async (pid) => {
				if (pid === 700) return 500;
				if (pid === 500) return 100;
				return 1;
			},
		});
		expect(await isSelfTarget(700, unrelated)).toBe(false);
	});

	test("absent or invalid pid", async () => {
		expect(await isSelfTarget(undefined, deps())).toBe(false);
		expect(await isSelfTarget(0, deps())).toBe(false);
		expect(await isSelfTarget(-1, deps())).toBe(false);
		expect(await isSelfTarget(1.5, deps())).toBe(false);
	});

	test("stops on pid 1", async () => {
		const toInit = deps({
			readParentPid: async (pid) => {
				if (pid === 700) return 1;
				return undefined;
			},
		});
		expect(await isSelfTarget(700, toInit)).toBe(false);
	});

	test("stops on cycles", async () => {
		const cyclic = deps({
			readParentPid: async (pid) => {
				if (pid === 700) return 600;
				if (pid === 600) return 700;
				return undefined;
			},
		});
		expect(await isSelfTarget(700, cyclic)).toBe(false);
	});

	test("reader errors mean not a self target", async () => {
		const broken = deps({
			readParentPid: async () => {
				throw new Error("permission denied");
			},
		});
		expect(await isSelfTarget(700, broken)).toBe(false);
	});

	test("honors the depth cap", async () => {
		const deep = deps({
			maxDepth: 1,
			readParentPid: async (pid) => {
				if (pid === 700) return 600;
				if (pid === 600) return 300;
				if (pid === 300) return 200;
				return 1;
			},
		});
		expect(await isSelfTarget(700, deep)).toBe(false);
	});

	test("invalid self pid is never a match", async () => {
		expect(await isSelfTarget(300, deps({ selfPid: 0 }))).toBe(false);
		expect(await isSelfTarget(1, deps({ selfPid: 1 }))).toBe(false);
	});
});
