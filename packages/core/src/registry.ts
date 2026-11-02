/** Session registry in runtimeDir/sessions. Spec: 01 §3. */
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentStatus,
	type Capability,
	type GitInfo,
	isRecord,
	LIVENESS_HELLO_TIMEOUT_MS,
	type ModelRef,
} from "@agentbridge/protocol";
import { type Dirs, assertSecureDir, ensureSecureDir, resolveDirs, writeFileAtomic } from "./dirs";
import { endpointFor } from "./ipc-server";
import { getProcStart, pidExists } from "./proc";

export interface SessionRecord {
	schema: "agentbridge.session/1";
	agent: "omp";
	agentVersion: string;
	extensionVersion: string;
	instanceId: string;
	sessionId: string;
	sessionName?: string;
	pid: number;
	procStart: string;
	cwd: string;
	git?: GitInfo;
	model?: ModelRef;
	status: AgentStatus;
	capabilities: Capability[];
	endpoint: string;
	tokenFile: string;
	startedAt: number;
	heartbeatAt: number;
}

export type Liveness = "alive" | "dead" | "unresponsive";
export type LivenessProbe = () => Promise<{ instanceId: string }>;

interface SocketStat {
	uid: number;
	isSymbolicLink(): boolean;
	isSocket(): boolean;
}

interface TokenStat {
	uid: number;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface SweepStaleOptions {
	stat?: (file: string) => Promise<{ uid: number }>;
	/** Test seam for socket ownership/symlink checks; defaults to `lstat`. */
	socketStat?: (file: string) => Promise<SocketStat>;
	/** Test seam for token ownership/type checks; defaults to `lstat`. */
	tokenStat?: (file: string) => Promise<TokenStat>;
	uid?: number;
}

export interface RemoveRecordOptions {
	/** Sweep mode: unlink only an exact `omp-<sessionId>.token` regular file owned by `uid`. */
	strictToken?: boolean;
	uid?: number;
	tokenStat?: (file: string) => Promise<TokenStat>;
}

function safeName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function recordPath(dirs: Dirs, sessionId: string): string {
	return join(dirs.sessionsDir, `omp-${sessionId}.json`);
}

function tokenPath(dirs: Dirs, tokenFile: string): string {
	return join(dirs.sessionsDir, tokenFile);
}

const RECORD_CAPABILITIES = ["status", "consult", "chat", "delegate"] as const;

function isRecordCapability(value: unknown): boolean {
	return typeof value === "string" && (RECORD_CAPABILITIES as readonly string[]).includes(value);
}

function isSessionRecord(value: unknown): value is SessionRecord {
	if (!isRecord(value)) return false;
	if (value.schema !== "agentbridge.session/1" || value.agent !== "omp") return false;
	if (typeof value.sessionId !== "string" || !safeName(value.sessionId)) return false;
	if (typeof value.instanceId !== "string" || value.instanceId.length === 0) return false;
	if (typeof value.tokenFile !== "string" || !safeName(value.tokenFile)) return false;
	if (typeof value.endpoint !== "string" || value.endpoint.length === 0) return false;
	if (typeof value.cwd !== "string" || value.cwd.length === 0) return false;
	if (typeof value.agentVersion !== "string" || typeof value.extensionVersion !== "string") return false;
	if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return false;
	if (typeof value.procStart !== "string") return false;
	if (value.status !== "idle" && value.status !== "busy" && value.status !== "waiting") return false;
	if (!Array.isArray(value.capabilities)) return false;
	if (!value.capabilities.every(isRecordCapability)) return false;
	if (typeof value.startedAt !== "number" || typeof value.heartbeatAt !== "number") return false;
	return true;
}

function debugSkip(file: string, reason: string): void {
	if (process.env.AGENTBRIDGE_DEBUG === "1") console.debug(`[agentbridge] skip ${file}: ${reason}`);
}

/** Write token first (0600), then the record (0600). */
export async function writeRecord(rec: SessionRecord, token: string): Promise<void> {
	if (rec.schema !== "agentbridge.session/1" || rec.agent !== "omp") throw new Error("invalid session record");
	if (!safeName(rec.sessionId) || !safeName(rec.tokenFile)) throw new Error("unsafe registry name");

	const dirs = resolveDirs();
	await ensureSecureDir(dirs.runtimeDir);
	await ensureSecureDir(dirs.sessionsDir);
	await writeFileAtomic(tokenPath(dirs, rec.tokenFile), token);
	await writeFileAtomic(recordPath(dirs, rec.sessionId), JSON.stringify(rec));
}

/** Remove both the record and its token, but only when `instanceId` still matches. */
export async function removeRecord(
	sessionId: string,
	instanceId: string,
	options: RemoveRecordOptions = {},
): Promise<void> {
	if (!safeName(sessionId)) return;
	const dirs = resolveDirs();
	const file = recordPath(dirs, sessionId);

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return;
	}
	if (!isSessionRecord(parsed) || parsed.instanceId !== instanceId) return;

	await rm(file, { force: true });

	if (options.strictToken === true) {
		if (parsed.tokenFile !== `omp-${parsed.sessionId}.token`) return;
		const tokenFile = tokenPath(dirs, parsed.tokenFile);
		let info: TokenStat;
		try {
			info = await (options.tokenStat ?? lstat)(tokenFile);
		} catch {
			return;
		}
		if (info.isSymbolicLink() || !info.isFile()) return;
		if (options.uid !== undefined && info.uid !== options.uid) return;
		await rm(tokenFile, { force: true });
		return;
	}

	if (safeName(parsed.tokenFile)) await rm(tokenPath(dirs, parsed.tokenFile), { force: true });
}

/** Read all valid regular-file records; corrupt files and symlinks are skipped. */
export async function listRecords(): Promise<SessionRecord[]> {
	const dirs = resolveDirs();
	try {
		await assertSecureDir(dirs.runtimeDir);
		await assertSecureDir(dirs.sessionsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	let names: string[];
	try {
		names = await readdir(dirs.sessionsDir);
	} catch {
		return [];
	}

	const records: SessionRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = join(dirs.sessionsDir, name);
		try {
			const info = await lstat(file);
			if (!info.isFile()) {
				debugSkip(file, "not a regular file");
				continue;
			}
			const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
			if (!isSessionRecord(parsed)) {
				debugSkip(file, "invalid record");
				continue;
			}
			records.push(parsed);
		} catch (error) {
			debugSkip(file, error instanceof Error ? error.message : "read failed");
		}
	}
	return records;
}

export async function readToken(rec: SessionRecord): Promise<string> {
	if (!safeName(rec.tokenFile)) throw new Error("unsafe token file");
	const file = tokenPath(resolveDirs(), rec.tokenFile);
	const info = await lstat(file);
	if (!info.isFile()) throw new Error("unsafe token file");
	if (process.platform !== "win32") {
		const uid = process.getuid?.();
		if (uid !== undefined && info.uid !== uid) throw new Error("insecure token file");
		if ((info.mode & 0o077) !== 0) throw new Error("insecure token file");
	}
	const token = await readFile(file, "utf8");
	return token.trim();
}

async function looksDead(rec: SessionRecord): Promise<boolean> {
	if (!pidExists(rec.pid)) return true;
	if (rec.procStart === "unknown") return false;
	return (await getProcStart(rec.pid)) !== rec.procStart;
}

/** alive = pid + procStart + hello instanceId match; hello failure/mismatch = unresponsive. */
export async function checkLiveness(rec: SessionRecord, probe: LivenessProbe): Promise<Liveness> {
	if (await looksDead(rec)) return "dead";

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, rejectTimeout) => {
		timer = setTimeout(() => rejectTimeout(new Error("hello timeout")), LIVENESS_HELLO_TIMEOUT_MS);
	});

	try {
		const hello = await Promise.race([probe(), timeout]);
		return hello.instanceId === rec.instanceId ? "alive" : "unresponsive";
	} catch {
		return "unresponsive";
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Remove the socket a dead record advertises, but only when its endpoint is
 * exactly the AgentBridge-derived path for the record's instanceId and the
 * path is a current-uid socket. Symlinks and arbitrary endpoints are skipped.
 */
async function removeRecordSocket(
	dirs: Dirs,
	rec: SessionRecord,
	currentUid: number | undefined,
	statSocket: (file: string) => Promise<SocketStat>,
): Promise<void> {
	let endpoint: string;
	try {
		endpoint = endpointFor(dirs.runtimeDir, rec.instanceId);
	} catch {
		return;
	}
	if (rec.endpoint !== endpoint) return;
	const socketPath = endpoint.slice("unix:".length);

	let info: SocketStat;
	try {
		info = await statSocket(socketPath);
	} catch {
		return;
	}
	if (info.isSymbolicLink() || !info.isSocket()) return;
	if (currentUid !== undefined && info.uid !== currentUid) return;

	try {
		await rm(socketPath, { force: true });
	} catch {
		// Socket cleanup is best-effort; a leftover socket is harmless.
	}
}

/** Delete records whose pid/procStart prove them dead and whose file is owned by the current user. */
export async function sweepStale(options: SweepStaleOptions = {}): Promise<number> {
	const records = await listRecords();
	const dirs = resolveDirs();
	const statFile = options.stat ?? stat;
	const statSocket = options.socketStat ?? lstat;
	const currentUid = options.uid ?? process.getuid?.();

	let removed = 0;
	for (const rec of records) {
		if (!(await looksDead(rec))) continue;

		let info: { uid: number };
		try {
			info = await statFile(recordPath(dirs, rec.sessionId));
		} catch {
			continue;
		}
		if (currentUid !== undefined && info.uid !== currentUid) continue;

		await removeRecordSocket(dirs, rec, currentUid, statSocket);
		await removeRecord(rec.sessionId, rec.instanceId, {
			strictToken: true,
			uid: currentUid,
			tokenStat: options.tokenStat ?? lstat,
		});
		removed += 1;
	}
	return removed;
}
