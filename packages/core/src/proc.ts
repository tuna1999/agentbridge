/** Process inspection helpers. Spec: 01 §3.3, §3.5. */
import { readFile } from "node:fs/promises";

export interface ProcStat {
	name: string;
	parentPid: number;
	startTime: string;
}

/** Parse `/proc/<pid>/stat`, cutting after the last `)` so spaces/parens in comm survive. */
export function parseProcStat(stat: string): ProcStat | undefined {
	const openParen = stat.indexOf("(");
	const closeParen = stat.lastIndexOf(")");
	if (openParen < 0 || closeParen <= openParen) return undefined;
	const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
	const parentPid = Number(fields[1]);
	const startTime = fields[19];
	if (!Number.isInteger(parentPid) || parentPid < 0) return undefined;
	if (startTime === undefined || !/^\d+$/.test(startTime)) return undefined;
	return { name: stat.slice(openParen + 1, closeParen), parentPid, startTime };
}

async function readStat(pid: number): Promise<ProcStat | undefined> {
	if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		return parseProcStat(stat);
	} catch {
		return undefined;
	}
}

/** Linux: `linux:<starttime>`; other platforms or errors: `"unknown"` (TODO(T11): Windows FILETIME). */
export async function getProcStart(pid: number): Promise<string> {
	const parsed = await readStat(pid);
	return parsed === undefined ? "unknown" : `linux:${parsed.startTime}`;
}

export async function getParentPid(pid: number): Promise<number | undefined> {
	return (await readStat(pid))?.parentPid;
}

/** Linux prefers `/proc/<pid>/comm`; falls back to the comm field of `stat`. */
export async function getProcessName(pid: number): Promise<string | undefined> {
	if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const name = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
		if (name.length > 0) return name;
	} catch {
		// fall through to stat
	}
	return (await readStat(pid))?.name;
}

/** `kill(pid, 0)`; `EPERM` still means the process exists. */
export function pidExists(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
