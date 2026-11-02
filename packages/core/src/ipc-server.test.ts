import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Envelope,
	HELLO_TIMEOUT_MS,
	type HelloResult,
	LineReader,
	MAX_FRAME_BYTES,
	newId,
	parseEnvelope,
	PROTOCOL_VERSION,
	ProtocolError,
	REQUEST_TIMEOUT_MS,
} from "@agentbridge/protocol";
import {
	endpointFor,
	type HelloResultProvider,
	hello,
	type RequestIO,
	request,
	type ServerHandle,
	startServer,
	type StartServerOptions,
} from "./index";

const TOKEN = "test-token-0123456789";
const SESSION_ID = "session-1";
const INSTANCE_ID = "instance-1";
const TARGET = { agent: "omp" as const, sessionId: SESSION_ID, instanceId: INSTANCE_ID };
const CALLER = { agent: "claude-code" as const, sessionId: "caller" };

interface ScheduledTimer {
	ms: number | undefined;
	run: () => void;
}

interface TimerCapture {
	next(ms: number): Promise<ScheduledTimer>;
	restore(): void;
}

/** Captures setTimeout calls so deadline tests never wait the real 5 s / 10 s. */
function captureTimers(): TimerCapture {
	const original = globalThis.setTimeout;
	const timers: ScheduledTimer[] = [];
	const waiters: Array<{ ms: number; resolve: (timer: ScheduledTimer) => void }> = [];

	const fake = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
		if (typeof handler !== "function") return 0 as unknown as ReturnType<typeof setTimeout>;
		const timer: ScheduledTimer = { ms: timeout, run: () => handler(...args) };
		timers.push(timer);
		for (let index = waiters.length - 1; index >= 0; index -= 1) {
			const waiter = waiters[index];
			if (waiter !== undefined && waiter.ms === timeout) {
				waiters.splice(index, 1);
				waiter.resolve(timer);
			}
		}
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;

	globalThis.setTimeout = fake;
	return {
		next(ms: number) {
			const existing = timers.find((timer) => timer.ms === ms);
			if (existing !== undefined) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<ScheduledTimer>();
			waiters.push({ ms, resolve });
			return promise;
		},
		restore() {
			globalThis.setTimeout = original;
		},
	};
}

let dir: string;
const servers: ServerHandle[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ab-core-ipc-srv-"));
	mkdirSync(join(dir, "s"), { mode: 0o700 });
});

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	rmSync(dir, { recursive: true, force: true });
});

function endpoint(): string {
	return endpointFor(dir, INSTANCE_ID);
}

function socketFile(): string {
	return endpoint().slice("unix:".length);
}

function identity(overrides: Partial<HelloResult> = {}): HelloResultProvider {
	return (serverNonce) => ({
		sessionId: SESSION_ID,
		instanceId: INSTANCE_ID,
		agentVersion: "18.14.0",
		extensionVersion: "0.1.0",
		protocol: 1,
		capabilities: ["status", "consult"],
		status: "idle",
		serverNonce,
		...overrides,
	});
}

function statusBody(): Record<string, unknown> {
	return {
		sessionId: SESSION_ID,
		instanceId: INSTANCE_ID,
		agentVersion: "18.14.0",
		extensionVersion: "0.1.0",
		capabilities: ["status", "consult"],
		status: "idle",
		cwd: "/tmp/project",
		pendingMessages: false,
		policy: { projectAllowed: true, consultConsent: "ask" },
	};
}

function resultFrame(requestFrame: Envelope, body: unknown): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id: newId(),
		type: "result",
		replyTo: requestFrame.id,
		from: { agent: "omp", sessionId: SESSION_ID },
		ts: Date.now(),
		hop: 0,
		body,
	};
}

const statusHandler = async (env: Envelope, io: RequestIO): Promise<void> => {
	if (env.type === "status") io.send(resultFrame(env, statusBody()));
};

async function start(overrides: Partial<StartServerOptions> = {}): Promise<ServerHandle> {
	const server = await startServer({
		endpoint: endpoint(),
		token: TOKEN,
		identity: identity(),
		onRequest: statusHandler,
		...overrides,
	});
	servers.push(server);
	return server;
}

class RawClient {
	readonly socket: Socket;
	#reader = new LineReader();
	#queue: Envelope[] = [];
	#waiter: { resolve: (frame: Envelope) => void; reject: (error: unknown) => void } | undefined;
	#dead: unknown;
	#closed = Promise.withResolvers<void>();

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const line of this.#reader.push(chunk)) {
					const parsed = parseEnvelope(line);
					if (parsed instanceof ProtocolError) {
						this.#fail(parsed);
						return;
					}
					if (this.#waiter !== undefined) {
						const waiter = this.#waiter;
						this.#waiter = undefined;
						waiter.resolve(parsed);
					} else {
						this.#queue.push(parsed);
					}
				}
			} catch (error) {
				this.#fail(error);
			}
		});
		socket.on("error", (error) => {
			this.#fail(error);
		});
		socket.on("close", () => {
			this.#closed.resolve();
			this.#fail(new Error("connection closed"));
		});
	}

	static connect(path: string): Promise<RawClient> {
		const result = Promise.withResolvers<RawClient>();
		const socket = createConnection(path);
		socket.once("connect", () => {
			try {
				result.resolve(new RawClient(socket));
			} catch (error) {
				result.reject(error);
			}
		});
		socket.once("error", (error) => {
			result.reject(error);
		});
		return result.promise;
	}

	next(): Promise<Envelope> {
		if (this.#dead !== undefined) return Promise.reject(this.#dead);
		const frame = this.#queue.shift();
		if (frame !== undefined) return Promise.resolve(frame);
		const result = Promise.withResolvers<Envelope>();
		this.#waiter = result;
		return result.promise;
	}

	send(frame: Envelope): void {
		this.socket.write(`${JSON.stringify(frame)}\n`);
	}

	closed(): Promise<void> {
		return this.#closed.promise;
	}

	destroy(): void {
		try {
			this.socket.destroy();
		} catch {
			// ignore
		}
	}

	#fail(error: unknown): void {
		if (this.#dead !== undefined) return;
		this.#dead = error;
		const waiter = this.#waiter;
		this.#waiter = undefined;
		waiter?.reject(error);
	}
}

function helloFrame(): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id: newId(),
		type: "hello",
		from: CALLER,
		ts: Date.now(),
		hop: 0,
		body: { token: TOKEN, clientNonce: newId(), protocol: [PROTOCOL_VERSION] },
	};
}

function statusFrame(): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id: newId(),
		type: "status",
		from: CALLER,
		to: TARGET,
		ts: Date.now(),
		hop: 0,
		body: {},
	};
}

function errorCode(frame: Envelope): unknown {
	expect(frame.type).toBe("error");
	const body = frame.body;
	if (typeof body !== "object" || body === null || !("code" in body)) {
		throw new Error("expected error body");
	}
	return body.code;
}

test("endpointFor hashes the instance id", () => {
	const hash = createHash("sha256").update(INSTANCE_ID).digest("hex").slice(0, 16);
	expect(endpointFor(dir, INSTANCE_ID)).toBe(`unix:${join(dir, "s", `${hash}.sock`)}`);
});

test("endpointFor rejects socket paths longer than 100 bytes", () => {
	expect(() => endpointFor(join(dir, "x".repeat(100)), INSTANCE_ID)).toThrow(/AGENTBRIDGE_RUNTIME_DIR/);
});

test("endpointFor measures the limit in UTF-8 bytes", () => {
	const runtimeDir = join(dir, "日本".repeat(20));
	expect(Buffer.byteLength(runtimeDir, "utf8")).toBeGreaterThan(100);
	expect(() => endpointFor(runtimeDir, INSTANCE_ID)).toThrow(/AGENTBRIDGE_RUNTIME_DIR/);
});

test("startServer rejects an overlong endpoint with the same guidance", async () => {
	const endpoint = `unix:${join(dir, "y".repeat(100), "socket")}`;
	await expect(
		startServer({ endpoint, token: TOKEN, identity: identity(), onRequest: statusHandler }),
	).rejects.toThrow(/AGENTBRIDGE_RUNTIME_DIR/);
});

test("creates the socket with mode 0600", async () => {
	await start();
	expect(statSync(socketFile()).mode & 0o777).toBe(0o600);
});

test("accepts the right token and serves a status request", async () => {
	await start();
	const first = await hello(endpoint(), TOKEN, 1_000);
	const second = await hello(endpoint(), TOKEN, 1_000);
	expect(first.sessionId).toBe(SESSION_ID);
	expect(first.instanceId).toBe(INSTANCE_ID);
	expect(first.serverNonce).not.toBe(second.serverNonce);

	const response = await request({
		endpoint: endpoint(),
		token: TOKEN,
		from: CALLER,
		to: TARGET,
		type: "status",
		body: {},
		timeoutMs: 1_000,
	});
	expect(response.hello.instanceId).toBe(INSTANCE_ID);
	expect(response.result).toEqual(statusBody());
});

test("handles hello and request written in one chunk", async () => {
	await start();
	const raw = await RawClient.connect(socketFile());
	try {
		const helloMessage = helloFrame();
		const requestMessage = statusFrame();
		raw.socket.write(`${JSON.stringify(helloMessage)}\n${JSON.stringify(requestMessage)}\n`);

		const helloResult = await raw.next();
		expect(helloResult.type).toBe("result");
		expect(helloResult.replyTo).toBe(helloMessage.id);

		const result = await raw.next();
		expect(result.type).toBe("result");
		expect(result.replyTo).toBe(requestMessage.id);
		expect(result.body).toEqual(statusBody());
	} finally {
		raw.destroy();
	}
});

test("rejects a wrong token", async () => {
	await start();
	const error = await hello(endpoint(), "wrong-token", 1_000).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ProtocolError);
	expect((error as ProtocolError).code).toBe("unauthorized");
});

test("calls onAuthFail for a bad token and survives a throwing callback", async () => {
	const reasons: string[] = [];
	await start({
		onAuthFail: (info) => {
			reasons.push(info.reason);
			throw new Error("audit unavailable");
		},
	});

	const error = await hello(endpoint(), "wrong", 1_000).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ProtocolError);
	expect((error as ProtocolError).code).toBe("unauthorized");
	expect(reasons).toEqual(["bad_token"]);

	const ok = await hello(endpoint(), TOKEN, 1_000);
	expect(ok.sessionId).toBe(SESSION_ID);
});

test("locks out after too many auth failures", async () => {
	const reasons: string[] = [];
	await start({
		onAuthFail: (info) => {
			reasons.push(info.reason);
		},
	});
	for (let attempt = 0; attempt < 11; attempt += 1) {
		const error = await hello(endpoint(), "wrong", 1_000).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe("unauthorized");
	}
	const locked = await hello(endpoint(), TOKEN, 1_000).catch((caught: unknown) => caught);
	expect(locked).toBeInstanceOf(ProtocolError);
	expect((locked as ProtocolError).code).toBe("target_exited");
	expect(reasons.filter((reason) => reason === "bad_token")).toHaveLength(11);
	expect(reasons.filter((reason) => reason === "locked")).toHaveLength(1);
});

test("rejects an oversized frame with too_large", async () => {
	await start();
	const raw = await RawClient.connect(socketFile());
	try {
		raw.socket.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78));
		const frame = await raw.next();
		expect(errorCode(frame)).toBe("too_large");
		await raw.closed();
	} finally {
		raw.destroy();
	}
});

test("closes a connection that never sends hello", async () => {
	const reasons: string[] = [];
	await start({
		onAuthFail: (info) => {
			reasons.push(info.reason);
		},
	});
	const capture = captureTimers();
	const raw = await RawClient.connect(socketFile());
	try {
		const timer = await capture.next(HELLO_TIMEOUT_MS);
		timer.run();
		const frame = await raw.next();
		expect(errorCode(frame)).toBe("unauthorized");
		expect(reasons).toEqual(["no_hello"]);
		await raw.closed();
	} finally {
		capture.restore();
		raw.destroy();
	}
});

test("closes a connection that never sends a request", async () => {
	await start();
	const capture = captureTimers();
	const raw = await RawClient.connect(socketFile());
	try {
		raw.send(helloFrame());
		const helloResult = await raw.next();
		expect(helloResult.type).toBe("result");
		const timer = await capture.next(REQUEST_TIMEOUT_MS);
		timer.run();
		const frame = await raw.next();
		expect(errorCode(frame)).toBe("bad_request");
		await raw.closed();
	} finally {
		capture.restore();
		raw.destroy();
	}
});

test("refuses a second server on the same endpoint without stealing it", async () => {
	const first = await start();
	await expect(
		startServer({
			endpoint: endpoint(),
			token: TOKEN,
			identity: identity(),
			onRequest: statusHandler,
		}),
	).rejects.toThrow();
	expect(existsSync(socketFile())).toBe(true);

	await first.close();
	expect(existsSync(socketFile())).toBe(false);
});

test("replaces a stale path that nobody listens on", async () => {
	writeFileSync(socketFile(), "stale");
	const server = await start();
	expect(existsSync(socketFile())).toBe(true);
	const result = await hello(endpoint(), TOKEN, 1_000);
	expect(result.sessionId).toBe(SESSION_ID);
	await server.close();
	expect(existsSync(socketFile())).toBe(false);
});
