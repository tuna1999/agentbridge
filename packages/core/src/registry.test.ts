import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkLiveness,
	endpointFor,
	getProcStart,
	InsecureDirError,
	listRecords,
	readToken,
	removeRecord,
	type SessionRecord,
	sweepStale,
	writeRecord,
} from "./index";

let runtimeDir: string;
const sockets: Server[] = [];
const savedRuntime = process.env.AGENTBRIDGE_RUNTIME_DIR;

beforeEach(() => {
	runtimeDir = mkdtempSync(join(tmpdir(), "ab-core-reg-"));
	process.env.AGENTBRIDGE_RUNTIME_DIR = runtimeDir;
});

afterEach(() => {
	for (const server of sockets.splice(0)) {
		try {
			server.close();
		} catch {
			// best-effort test cleanup
		}
	}
	if (savedRuntime === undefined) delete process.env.AGENTBRIDGE_RUNTIME_DIR;
	else process.env.AGENTBRIDGE_RUNTIME_DIR = savedRuntime;
	rmSync(runtimeDir, { recursive: true, force: true });
});

function sessionsDir(): string {
	return join(runtimeDir, "sessions");
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
	const sessionId = overrides.sessionId ?? "01a18dd3-7bdd-71ef-9ea9-1312bd62b611";
	return {
		schema: "agentbridge.session/1",
		agent: "omp",
		agentVersion: "18.14.0",
		extensionVersion: "0.0.0",
		instanceId: "instance-1",
		sessionId,
		pid: process.pid,
		procStart: "unknown",
		cwd: "/tmp/project",
		status: "idle",
		capabilities: ["status", "consult"],
		endpoint: "unix:/tmp/poc.sock",
		tokenFile: `omp-${sessionId}.token`,
		startedAt: 1_700_000_000_000,
		heartbeatAt: 1_700_000_001_000,
		...overrides,
	};
}

function recordFile(rec: SessionRecord): string {
	return join(sessionsDir(), `omp-${rec.sessionId}.json`);
}

function socketsDir(): string {
	return join(runtimeDir, "s");
}

async function listenSocket(path: string): Promise<void> {
	mkdirSync(socketsDir(), { recursive: true, mode: 0o700 });
	const server = createServer();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(path, () => {
		sockets.push(server);
		resolve();
	});
	await promise;
}

function deadRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return makeRecord({ pid: 999_999_999, procStart: "linux:1", ...overrides });
}

test("writes token then record with mode 0600", async () => {
	const rec = makeRecord();
	await writeRecord(rec, "secret-token");

	const tokenFile = join(sessionsDir(), rec.tokenFile);
	expect(readFileSync(tokenFile, "utf8")).toBe("secret-token");
	expect(JSON.parse(readFileSync(recordFile(rec), "utf8"))).toEqual(rec);
	expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
	expect(statSync(recordFile(rec)).mode & 0o777).toBe(0o600);
});

test("lists valid records and ignores partial, corrupt, and symlinked files", async () => {
	const rec = makeRecord();
	await writeRecord(rec, "token");
	writeFileSync(join(sessionsDir(), "omp-bad.json"), "{");
	writeFileSync(join(sessionsDir(), "omp-other.json"), JSON.stringify({ schema: "other" }));
	writeFileSync(join(sessionsDir(), `${rec.tokenFile}.deadbeef.tmp`), "partial");
	symlinkSync(recordFile(rec), join(sessionsDir(), "omp-link.json"));

	const records = await listRecords();
	expect(records).toEqual([rec]);
});

test("returns no records when sessions is missing", async () => {
	rmSync(sessionsDir(), { recursive: true, force: true });
	expect(await listRecords()).toEqual([]);
});

test("returns no records when runtimeDir is missing", async () => {
	rmSync(runtimeDir, { recursive: true, force: true });
	expect(await listRecords()).toEqual([]);
});

test("refuses to list records when sessions is insecure", async () => {
	await writeRecord(makeRecord(), "token");
	chmodSync(sessionsDir(), 0o755);
	await expect(listRecords()).rejects.toThrow(InsecureDirError);
});

test("refuses to list records when runtimeDir is insecure", async () => {
	await writeRecord(makeRecord(), "token");
	chmodSync(runtimeDir, 0o755);
	await expect(listRecords()).rejects.toThrow(InsecureDirError);
});

test("removes a record only when instanceId matches", async () => {
	const rec = makeRecord();
	await writeRecord(rec, "token");

	await removeRecord(rec.sessionId, "other-instance");
	expect((await listRecords()).length).toBe(1);

	await removeRecord(rec.sessionId, rec.instanceId);
	expect(await listRecords()).toEqual([]);
});

test("removeRecord deletes the record and token", async () => {
	const rec = makeRecord();
	await writeRecord(rec, "token");
	await removeRecord(rec.sessionId, rec.instanceId);
	expect(await listRecords()).toEqual([]);
	let missing = false;
	try {
		readFileSync(join(sessionsDir(), rec.tokenFile));
	} catch {
		missing = true;
	}
	expect(missing).toBe(true);
});

test("reads the token for a record", async () => {
	const rec = makeRecord();
	await writeRecord(rec, "token-value");
	expect(await readToken(rec)).toBe("token-value");
});

test("rejects reading a missing token", async () => {
	await expect(readToken(makeRecord())).rejects.toThrow();
});

test("refuses a symlinked token file", async () => {
	const rec = makeRecord();
	await writeRecord(rec, "token");
	const tokenFile = join(sessionsDir(), rec.tokenFile);
	const real = join(sessionsDir(), "real.token");
	writeFileSync(real, "stolen");
	rmSync(tokenFile, { force: true });
	symlinkSync(real, tokenFile);
	await expect(readToken(rec)).rejects.toThrow();
});

test("refuses a token readable by others", async () => {
	const rec = makeRecord();
	await writeRecord(rec, "token");
	chmodSync(join(sessionsDir(), rec.tokenFile), 0o644);
	await expect(readToken(rec)).rejects.toThrow();
});

test("marks a missing pid as dead without probing", async () => {
	let probed = false;
	const rec = makeRecord({ pid: 999_999_999, procStart: "linux:1" });
	const result = await checkLiveness(rec, async () => {
		probed = true;
		return { instanceId: rec.instanceId };
	});
	expect(result).toBe("dead");
	expect(probed).toBe(false);
});

test("marks a mismatched procStart as dead", async () => {
	if (process.platform !== "linux") return;
	const actual = await getProcStart(process.pid);
	if (actual === "unknown") return;
	const rec = makeRecord({ procStart: "linux:1" });
	expect(await checkLiveness(rec, async () => ({ instanceId: rec.instanceId }))).toBe("dead");
});

test("marks a matching hello as alive", async () => {
	if (process.platform === "linux") {
		const actual = await getProcStart(process.pid);
		if (actual !== "unknown") {
			const rec = makeRecord({ procStart: actual });
			expect(await checkLiveness(rec, async () => ({ instanceId: rec.instanceId }))).toBe("alive");
		}
	}
	const rec = makeRecord({ procStart: "unknown" });
	expect(await checkLiveness(rec, async () => ({ instanceId: rec.instanceId }))).toBe("alive");
});

test("marks hello failures and instance mismatches as unresponsive", async () => {
	const rec = makeRecord();
	expect(await checkLiveness(rec, async () => Promise.reject(new Error("down")))).toBe("unresponsive");
	expect(await checkLiveness(rec, async () => ({ instanceId: "other" }))).toBe("unresponsive");
	expect(
		await checkLiveness(rec, () => {
			throw new Error("sync failure");
		}),
	).toBe("unresponsive");
});

test("sweeps a dead record, its token, and its Unix socket", async () => {
	const instanceId = "dead-instance";
	const endpoint = endpointFor(runtimeDir, instanceId);
	const socketPath = endpoint.slice("unix:".length);
	await listenSocket(socketPath);
	const rec = deadRecord({ sessionId: "dead-session", instanceId, endpoint });
	await writeRecord(rec, "token");

	expect(await sweepStale()).toBe(1);
	expect(existsSync(recordFile(rec))).toBe(false);
	expect(existsSync(join(sessionsDir(), rec.tokenFile))).toBe(false);
	expect(existsSync(socketPath)).toBe(false);
	expect(await listRecords()).toEqual([]);
});

test("leaves a live record, token, and socket untouched", async () => {
	const instanceId = "alive-instance";
	const endpoint = endpointFor(runtimeDir, instanceId);
	const socketPath = endpoint.slice("unix:".length);
	await listenSocket(socketPath);
	const rec = makeRecord({ sessionId: "alive-socket", instanceId, endpoint });
	await writeRecord(rec, "token");

	expect(await sweepStale()).toBe(0);
	expect(existsSync(recordFile(rec))).toBe(true);
	expect(existsSync(join(sessionsDir(), rec.tokenFile))).toBe(true);
	expect(existsSync(socketPath)).toBe(true);
});

test("does not sweep records or sockets owned by another uid", async () => {
	const instanceId = "foreign-instance";
	const endpoint = endpointFor(runtimeDir, instanceId);
	const socketPath = endpoint.slice("unix:".length);
	await listenSocket(socketPath);
	const rec = deadRecord({ sessionId: "foreign-session", instanceId, endpoint });
	await writeRecord(rec, "token");

	expect(await sweepStale({ stat: async () => ({ uid: 0 }), uid: 1000 })).toBe(0);
	expect(existsSync(recordFile(rec))).toBe(true);
	expect(existsSync(join(sessionsDir(), rec.tokenFile))).toBe(true);
	expect(existsSync(socketPath)).toBe(true);
});

test("does not delete a socket owned by another uid", async () => {
	const instanceId = "foreign-socket-instance";
	const endpoint = endpointFor(runtimeDir, instanceId);
	const socketPath = endpoint.slice("unix:".length);
	await listenSocket(socketPath);
	const rec = deadRecord({ sessionId: "foreign-socket", instanceId, endpoint });
	await writeRecord(rec, "token");

	const removed = await sweepStale({
		stat: async () => ({ uid: 1000 }),
		socketStat: async () => ({ uid: 0, isSymbolicLink: () => false, isSocket: () => true }),
		uid: 1000,
	});
	expect(removed).toBe(1);
	expect(existsSync(recordFile(rec))).toBe(false);
	expect(existsSync(socketPath)).toBe(true);
});

test("does not delete a token owned by another uid", async () => {
	const rec = deadRecord({ sessionId: "foreign-token" });
	await writeRecord(rec, "token");
	const tokenFile = join(sessionsDir(), rec.tokenFile);

	const removed = await sweepStale({
		stat: async () => ({ uid: 1000 }),
		tokenStat: async () => ({ uid: 0, isFile: () => true, isSymbolicLink: () => false }),
		uid: 1000,
	});
	expect(removed).toBe(1);
	expect(existsSync(recordFile(rec))).toBe(false);
	expect(existsSync(tokenFile)).toBe(true);
});

test("does not delete a token with a non-AgentBridge token name", async () => {
	const rec = deadRecord({ sessionId: "wrong-token", tokenFile: "omp-other.token" });
	await writeRecord(rec, "token");
	const tokenFile = join(sessionsDir(), rec.tokenFile);

	expect(await sweepStale()).toBe(1);
	expect(existsSync(recordFile(rec))).toBe(false);
	expect(existsSync(tokenFile)).toBe(true);
});

test("does not delete a symlinked token", async () => {
	const rec = deadRecord({ sessionId: "symlink-token" });
	await writeRecord(rec, "token");
	const tokenFile = join(sessionsDir(), rec.tokenFile);
	const target = join(sessionsDir(), "token-target.txt");
	writeFileSync(target, "keep");
	rmSync(tokenFile, { force: true });
	symlinkSync(target, tokenFile);

	expect(await sweepStale()).toBe(1);
	expect(lstatSync(tokenFile).isSymbolicLink()).toBe(true);
	expect(readFileSync(target, "utf8")).toBe("keep");
});

test("does not follow a symlinked socket path", async () => {
	const instanceId = "symlink-instance";
	const endpoint = endpointFor(runtimeDir, instanceId);
	const socketPath = endpoint.slice("unix:".length);
	mkdirSync(socketsDir(), { recursive: true, mode: 0o700 });
	const victim = join(runtimeDir, "victim.txt");
	writeFileSync(victim, "keep");
	symlinkSync(victim, socketPath);

	const rec = deadRecord({ sessionId: "symlink-session", instanceId, endpoint });
	await writeRecord(rec, "token");

	expect(await sweepStale()).toBe(1);
	expect(lstatSync(socketPath).isSymbolicLink()).toBe(true);
	expect(readFileSync(victim, "utf8")).toBe("keep");
	expect(existsSync(recordFile(rec))).toBe(false);
});

test("does not delete an endpoint outside the AgentBridge socket pattern", async () => {
	const foreignSocket = join(socketsDir(), "foreign.sock");
	await listenSocket(foreignSocket);
	const rec = deadRecord({ sessionId: "arbitrary-endpoint", endpoint: `unix:${foreignSocket}` });
	await writeRecord(rec, "token");

	expect(await sweepStale()).toBe(1);
	expect(existsSync(foreignSocket)).toBe(true);
	expect(existsSync(recordFile(rec))).toBe(false);
});

test("does not sweep records that look alive", async () => {
	const rec = makeRecord({ sessionId: "alive-session", procStart: "unknown" });
	await writeRecord(rec, "token");
	expect(await sweepStale()).toBe(0);
	expect((await listRecords()).length).toBe(1);
});
