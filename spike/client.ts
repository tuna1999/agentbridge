#!/usr/bin/env bun
/**
 * AgentBridge — T0 spike client.
 *
 *   bun spike/client.ts status
 *   bun spike/client.ts consult "Phiên này đang thảo luận gì?"
 *   bun spike/client.ts consult --session <sessionId-prefix> "…"
 *
 * Discovers the newest live PoC record in $AGENTBRIDGE_RUNTIME_DIR (default
 * /tmp/ab-poc), authenticates with the token file, performs exactly one request
 * (01 §4.1), prints streamed deltas and the final result.
 *
 * Exit codes: 0 ok, 2 server error, 3 socket closed before result, 4 no usable
 * record, 5 usage, 6 timeout, 7 unauthorized, 8 connect error.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const RUNTIME_DIR = path.resolve(process.env.AGENTBRIDGE_RUNTIME_DIR?.trim() || "/tmp/ab-poc");
const RECORD_SCHEMA = "agentbridge.poc/1";
const STATUS_TIMEOUT_MS = 10_000;
const CONSULT_TIMEOUT_MS = (() => {
	const value = Number(process.env.AB_POC_CLIENT_TIMEOUT_MS ?? "");
	return Number.isFinite(value) && value > 0 ? value : 180_000;
})();

/** Raw JSON shape; `LiveRecord` is the validated subset this client can use. */
interface SessionRecord {
	schema?: string;
	instanceId?: string;
	sessionId?: string;
	pid?: number;
	cwd?: string;
	endpoint?: string;
	tokenFile?: string;
	model?: { provider?: string; id?: string } | null;
	heartbeatAt?: number;
}

interface LiveRecord extends SessionRecord {
	schema: string;
	sessionId: string;
	pid: number;
	endpoint: string;
	tokenFile: string;
}

interface Frame {
	v?: number;
	id?: string;
	type?: string;
	replyTo?: string;
	body?: Record<string, unknown>;
}

function fail(message: string, code: number): never {
	console.error(`\n[error] ${message}`);
	process.exit(code);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function warnIfLoose(file: string, label: string): void {
	try {
		const stat = fs.statSync(file);
		if ((stat.mode & 0o077) !== 0) {
			console.error(`[warn] ${label} ${file} has mode ${(stat.mode & 0o777).toString(8)} (expected 600)`);
		}
	} catch {
		// mode check is advisory only
	}
}

function modelLabel(value: unknown): string {
	if (value === null || typeof value !== "object") return "?";
	const provider = "provider" in value && typeof value.provider === "string" ? value.provider : "?";
	const id = "id" in value && typeof value.id === "string" ? value.id : "?";
	return `${provider}/${id}`;
}

function isLiveRecord(value: unknown): value is LiveRecord {
	return (
		value !== null &&
		typeof value === "object" &&
		"schema" in value &&
		value.schema === RECORD_SCHEMA &&
		"endpoint" in value &&
		typeof value.endpoint === "string" &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"tokenFile" in value &&
		typeof value.tokenFile === "string" &&
		"pid" in value &&
		typeof value.pid === "number"
	);
}

function readRecords(): Array<{ file: string; record: LiveRecord }> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(RUNTIME_DIR, { withFileTypes: true });
	} catch (error) {
		fail(
			`không đọc được runtime dir ${RUNTIME_DIR} (${(error as Error).message}).\nĐã chạy omp với AGENTBRIDGE_RUNTIME_DIR=${RUNTIME_DIR} chưa?`,
			4,
		);
	}
	const records: Array<{ file: string; record: LiveRecord }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = path.join(RUNTIME_DIR, entry.name);
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			console.error(`[skip] không parse được ${file}`);
			continue;
		}
		if (!isLiveRecord(parsed)) {
			console.error(`[skip] không phải record của PoC: ${file}`);
			continue;
		}
		records.push({ file, record: parsed });
	}
	return records;
}

function describe(record: SessionRecord): string {
	const model = record.model ? `${record.model.provider}/${record.model.id}` : "model?";
	const beat = record.heartbeatAt ? new Date(record.heartbeatAt).toISOString() : "?";
	return `session=${record.sessionId} pid=${record.pid} model=${model} heartbeat=${beat}`;
}

function pickRecord(wantedSession: string | undefined): LiveRecord {
	const all = readRecords();
	if (all.length === 0) fail(`không thấy record .json nào trong ${RUNTIME_DIR}.`, 4);
	const matching = wantedSession
		? all.filter(
				(entry) =>
					entry.record.sessionId.startsWith(wantedSession) || entry.record.instanceId?.startsWith(wantedSession),
			)
		: all;
	if (matching.length === 0) {
		fail(
			`không có phiên khớp "${wantedSession}". Hiện có:\n${all.map((entry) => `  - ${describe(entry.record)}`).join("\n")}`,
			4,
		);
	}
	const live = matching.filter((entry) => pidAlive(entry.record.pid));
	if (live.length === 0) {
		fail(
			`record tồn tại nhưng tiến trình OMP đã chết (stale):\n${matching
				.map((entry) => `  - ${describe(entry.record)}`)
				.join("\n")}\nHãy mở lại omp với extension PoC.`,
			4,
		);
	}
	if (live.length > 1) {
		console.error(`[info] ${live.length} phiên còn sống, chọn phiên heartbeat mới nhất:`);
		for (const entry of live) console.error(`  - ${describe(entry.record)}  (${entry.file})`);
	}
	live.sort((a, b) => (b.record.heartbeatAt ?? 0) - (a.record.heartbeatAt ?? 0));
	const chosen = live[0];
	if (!chosen) fail("không chọn được record (unreachable)", 4);
	console.error(`[pick] ${describe(chosen.record)}`);
	return chosen.record;
}

function resolveTargets(record: LiveRecord): { socketPath: string; token: string } {
	if (!record.endpoint.startsWith("unix:")) {
		fail(`endpoint không phải unix socket: ${record.endpoint} (T0 chỉ hỗ trợ Unix, xem W1)`, 4);
	}
	const socketPath = path.resolve(record.endpoint.slice("unix:".length));
	if (path.dirname(socketPath) !== RUNTIME_DIR) {
		fail(`endpoint ${socketPath} nằm ngoài runtime dir ${RUNTIME_DIR}`, 4);
	}
	if (path.basename(record.tokenFile) !== record.tokenFile) {
		fail(`tokenFile phải là tên file trong runtime dir, nhận: ${record.tokenFile}`, 4);
	}
	const tokenPath = path.join(RUNTIME_DIR, record.tokenFile);
	warnIfLoose(tokenPath, "token file");
	let token: string;
	try {
		token = fs.readFileSync(tokenPath, "utf8").trim();
	} catch (error) {
		fail(`không đọc được token ${tokenPath} (${(error as Error).message})`, 4);
	}
	return { socketPath, token };
}

function pretty(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? String(value);
}

function clientPeer(): { agent: string; sessionId: string; pid: number } {
	return { agent: "claude-code", sessionId: "poc-client", pid: process.pid };
}

async function main(mode: "status" | "consult", question: string, wantedSession: string | undefined): Promise<number> {
	const record = pickRecord(wantedSession);
	const { socketPath, token } = resolveTargets(record);
	console.error(`[connect] ${socketPath}`);

	const { promise, resolve } = Promise.withResolvers<number>();
	let socket: net.Socket | undefined;
	let timer: NodeJS.Timeout | undefined;
	let settled = false;
	let buffer = "";
	let phase: "hello" | "request" = "hello";
	const helloId = crypto.randomUUID();
	const requestId = crypto.randomUUID();
	const timeoutMs = mode === "consult" ? CONSULT_TIMEOUT_MS : STATUS_TIMEOUT_MS;

	const finish = (code: number, note?: string): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (note) console.error(`\n[error] ${note}`);
		try {
			socket?.end();
		} catch {
			// ignore
		}
		resolve(code);
	};

	const send = (frame: Record<string, unknown>): void => {
		try {
			socket?.write(`${JSON.stringify(frame)}\n`);
		} catch (error) {
			finish(8, `ghi socket thất bại: ${(error as Error).message}`);
		}
	};

	const onFrame = (frame: Frame): void => {
		if (frame.type === "progress") {
			const body = frame.body ?? {};
			if (body.phase === "delta" && typeof body.delta === "string") {
				process.stdout.write(body.delta);
			} else {
				console.error(`\n[phase] ${String(body.phase)}`);
			}
			return;
		}
		if (frame.type === "error") {
			const body = frame.body ?? {};
			const code = typeof body.code === "string" ? body.code : "internal";
			const message = typeof body.message === "string" ? body.message : "";
			console.error(`\n[server:${code}] ${message}`);
			finish(code === "unauthorized" ? 7 : 2);
			return;
		}
		if (frame.type !== "result") {
			console.error(`[warn] frame không mong đợi: ${String(frame.type)}`);
			return;
		}
		if (phase === "hello") {
			phase = "request";
			const body = frame.body ?? {};
			console.error(
				`[hello] sessionId=${String(body.sessionId)} idle=${String(body.idle)} model=${modelLabel(body.model)} sessionFile=${String(body.sessionFile)} capabilities=${JSON.stringify(body.capabilities)}`,
			);
			if (mode === "status") {
				send({ v: 1, id: requestId, type: "status", from: clientPeer(), ts: Date.now(), hop: 0, body: {} });
			} else {
				send({ v: 1, id: requestId, type: "consult", from: clientPeer(), ts: Date.now(), hop: 0, body: { question } });
			}
			return;
		}
		if (mode === "status") {
			console.log(pretty(frame.body));
		} else {
			process.stdout.write("\n");
			console.log(pretty(frame.body));
		}
		finish(0);
	};

	socket = net.createConnection({ path: socketPath });
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim() !== "") {
				try {
					onFrame(JSON.parse(line) as Frame);
				} catch (error) {
					console.error(`\n[warn] frame hỏng: ${(error as Error).message}`);
				}
			}
			if (settled) return;
			index = buffer.indexOf("\n");
		}
	});
	socket.on("error", (error: Error) => {
		finish(8, `socket error: ${error.message}`);
	});
	socket.on("close", () => {
		if (!settled) finish(3, "server đóng kết nối trước khi có result (target_exited)");
	});
	socket.on("connect", () => {
		send({
			v: 1,
			id: helloId,
			type: "hello",
			from: clientPeer(),
			ts: Date.now(),
			hop: 0,
			body: { token, clientNonce: crypto.randomUUID(), protocol: [1] },
		});
	});
	timer = setTimeout(() => {
		finish(6, `hết thời gian chờ ${timeoutMs} ms`);
	}, timeoutMs);
	process.on("SIGINT", () => finish(130, "bị ngắt bởi người dùng"));

	return await promise;
}

const argv = process.argv.slice(2);
const sessionFlag = argv.indexOf("--session");
let wantedSession: string | undefined;
if (sessionFlag >= 0) {
	wantedSession = argv[sessionFlag + 1];
	argv.splice(sessionFlag, 2);
}
const mode = argv[0];
if (mode !== "status" && mode !== "consult") {
	console.error('usage: bun spike/client.ts status | consult ["<question>"] [--session <prefix>]');
	process.exit(5);
}
const question = argv.slice(1).join(" ").trim();
if (mode === "consult" && question === "") {
	console.error('cần câu hỏi: bun spike/client.ts consult "…"');
	process.exit(5);
}

process.exitCode = await main(mode, question, wantedSession);
