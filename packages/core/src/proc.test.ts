import { expect, test } from "bun:test";
import { getParentPid, getProcStart, getProcessName, parseProcStat, pidExists } from "./index";

function statLine(name: string, parentPid: string, startTime: string): string {
	const fields = ["S", parentPid, ...Array.from({ length: 17 }, () => "0"), startTime];
	return `123 (${name}) ${fields.join(" ")}`;
}

test("parses stat after the last closing parenthesis", () => {
	expect(parseProcStat(statLine("my ) proc", "42", "12345"))).toEqual({
		name: "my ) proc",
		parentPid: 42,
		startTime: "12345",
	});
});

test("rejects malformed stat lines", () => {
	expect(parseProcStat("")).toBeUndefined();
	expect(parseProcStat("no parentheses")).toBeUndefined();
	expect(parseProcStat("1 (x) S 1")).toBeUndefined();
	expect(parseProcStat(statLine("x", "not-a-pid", "1"))).toBeUndefined();
	expect(parseProcStat(statLine("x", "1", "not-a-time"))).toBeUndefined();
});

test("reads the start time of the current process", async () => {
	if (process.platform !== "linux") return;
	expect(await getProcStart(process.pid)).toMatch(/^linux:\d+$/);
});

test("returns unknown for missing or invalid pids", async () => {
	expect(await getProcStart(999_999_999)).toBe("unknown");
	expect(await getProcStart(-1)).toBe("unknown");
	expect(await getProcStart(1.5)).toBe("unknown");
});

test("reads parent pid and process name", async () => {
	if (process.platform !== "linux") return;
	expect(await getParentPid(process.pid)).toBeGreaterThan(0);
	const name = await getProcessName(process.pid);
	expect(typeof name).toBe("string");
	expect((name as string).length).toBeGreaterThan(0);
});

test("pidExists handles live, missing, zero, and EPERM cases", () => {
	expect(pidExists(process.pid)).toBe(true);
	expect(pidExists(999_999_999)).toBe(false);
	expect(pidExists(0)).toBe(false);
	expect(pidExists(-1)).toBe(false);
	if (process.platform === "linux") expect(pidExists(1)).toBe(true);
});
