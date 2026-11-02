/** Unix-domain socket client for protocol v1. Spec: 01 §4.1, §4.3, §7.3, §9. */
import { createConnection, type Socket } from "node:net";
import {
	type Envelope,
	type ErrorBody,
	type HelloResult,
	LineReader,
	newId,
	parseEnvelope,
	type Peer,
	PROTOCOL_VERSION,
	type ProgressBody,
	ProtocolError,
} from "@agentbridge/protocol";
import { assertSocketPathLength } from "./dirs";

export interface RequestOptions {
	endpoint: string;
	token: string;
	from: Peer;
	to: Peer;
	type: "status" | "consult" | "chat";
	body: unknown;
	onProgress?: (progress: ProgressBody) => void;
	signal?: AbortSignal;
	timeoutMs: number;
}

export interface RequestResult {
	hello: HelloResult;
	result: unknown;
}

type Expectation = "hello" | "status" | "consult" | "chat";

const DEFAULT_PEER: Peer = { agent: "claude-code", sessionId: "agentbridge-client" };

function unixPath(endpoint: string): string {
	const raw = endpoint.startsWith("unix:") ? endpoint.slice("unix:".length) : endpoint;
	if (raw.startsWith("pipe:") || raw.startsWith("\\\\")) {
		// TODO(T11): Windows named pipes.
		throw new Error("Windows named pipes are not supported yet (T11)");
	}
	if (raw.length === 0) throw new Error("empty IPC endpoint");
	assertSocketPathLength(raw);
	return raw;
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function errorFromBody(body: unknown): ProtocolError {
	// parseEnvelope validated every error body; the cast cannot fabricate fields.
	const error = body as ErrorBody;
	return new ProtocolError(error.code, error.message, error.details);
}

function helloEnvelope(id: string, token: string, from: Peer): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id,
		type: "hello",
		from,
		ts: Date.now(),
		hop: 0,
		body: { token, clientNonce: newId(), protocol: [PROTOCOL_VERSION] },
	};
}

function requestEnvelope(id: string, opts: RequestOptions): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id,
		type: opts.type,
		from: opts.from,
		to: opts.to,
		ts: Date.now(),
		hop: 0,
		body: opts.body,
	};
}

function readHello(frame: Envelope, id: string): HelloResult {
	if (frame.type === "error") throw errorFromBody(frame.body);
	if (frame.type !== "result" || frame.replyTo !== id) {
		throw new ProtocolError("bad_request", "unexpected hello response");
	}
	// parseEnvelope was called with expectResult "hello" before this frame was read.
	return frame.body as HelloResult;
}

interface Waiter {
	resolve: (frame: Envelope) => void;
	reject: (error: unknown) => void;
}

/** One connection: hello, then at most one request. All callbacks are guarded. */
class Connection {
	expectResult: Expectation | undefined;
	#socket: Socket;
	#reader = new LineReader();
	#queue: Envelope[] = [];
	#waiter: Waiter | undefined;
	#dead: unknown;
	#disposed = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#removeAbort: (() => void) | undefined;
	#connected: Promise<void>;
	#resolveConnected: () => void;
	#rejectConnected: (error: unknown) => void;

	constructor(endpoint: string, timeoutMs: number, signal?: AbortSignal) {
		const connected = Promise.withResolvers<void>();
		this.#connected = connected.promise;
		this.#resolveConnected = connected.resolve;
		this.#rejectConnected = connected.reject;

		this.#socket = createConnection(unixPath(endpoint));
		this.#socket.on("connect", () => {
			try {
				this.#resolveConnected();
			} catch {
				// ignore
			}
		});
		this.#socket.on("data", (chunk: Buffer) => {
			try {
				this.#onData(chunk);
			} catch (error) {
				this.#fail(error);
			}
		});
		this.#socket.on("error", (error: Error) => {
			try {
				this.#fail(new ProtocolError("target_exited", messageOf(error)));
			} catch {
				// ignore
			}
		});
		this.#socket.on("close", () => {
			try {
				this.#fail(new ProtocolError("target_exited", "connection closed before result"));
			} catch {
				// ignore
			}
		});

		this.#timer = setTimeout(() => {
			try {
				this.#fail(
					new ProtocolError("target_exited", `client timeout after ${timeoutMs}ms`, { reason: "timeout" }),
				);
			} catch {
				// ignore
			}
		}, timeoutMs);

		if (signal !== undefined) {
			const onAbort = (): void => {
				try {
					this.#fail(new ProtocolError("cancelled", "request aborted"));
				} catch {
					// ignore
				}
			};
			if (signal.aborted) onAbort();
			else {
				signal.addEventListener("abort", onAbort, { once: true });
				this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
			}
		}
	}

	connected(): Promise<void> {
		return this.#connected;
	}

	send(frame: Envelope): void {
		if (this.#dead !== undefined || this.#disposed) return;
		try {
			if (this.#socket.destroyed || !this.#socket.writable) {
				this.#fail(new ProtocolError("target_exited", "socket is not writable"));
				return;
			}
			this.#socket.write(`${JSON.stringify(frame)}\n`);
		} catch (error) {
			this.#fail(error);
		}
	}

	nextFrame(): Promise<Envelope> {
		if (this.#dead !== undefined) return Promise.reject(this.#dead);
		const frame = this.#queue.shift();
		if (frame !== undefined) return Promise.resolve(frame);
		if (this.#waiter !== undefined) {
			return Promise.reject(new ProtocolError("internal", "concurrent frame reads"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<Envelope>();
		this.#waiter = { resolve, reject };
		return promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#cleanup();
		try {
			this.#socket.destroy();
		} catch {
			// ignore
		}
	}

	#cleanup(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#removeAbort?.();
		this.#removeAbort = undefined;
	}

	#onData(chunk: Buffer): void {
		if (this.#dead !== undefined || this.#disposed) return;
		let lines: string[];
		try {
			lines = this.#reader.push(chunk);
		} catch (error) {
			this.#fail(error);
			return;
		}
		for (const line of lines) {
			const parsed = parseEnvelope(line, this.expectResult === undefined ? {} : { expectResult: this.expectResult });
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
	}

	#fail(error: unknown): void {
		if (this.#dead !== undefined || this.#disposed) return;
		this.#dead = error instanceof ProtocolError ? error : new ProtocolError("internal", messageOf(error));
		this.#cleanup();
		const waiter = this.#waiter;
		this.#waiter = undefined;
		waiter?.reject(this.#dead);
		this.#rejectConnected(this.#dead);
		try {
			this.#socket.destroy();
		} catch {
			// ignore
		}
	}
}

/** Authenticate only, for liveness/status discovery. */
export async function hello(endpoint: string, token: string, timeoutMs: number): Promise<HelloResult> {
	const conn = new Connection(endpoint, timeoutMs);
	try {
		await conn.connected();
		const id = newId();
		conn.expectResult = "hello";
		conn.send(helloEnvelope(id, token, DEFAULT_PEER));
		return readHello(await conn.nextFrame(), id);
	} finally {
		conn.dispose();
	}
}

/** hello → one request → progress* → result|error, then close. */
export async function request(opts: RequestOptions): Promise<RequestResult> {
	const conn = new Connection(opts.endpoint, opts.timeoutMs, opts.signal);
	try {
		await conn.connected();
		const helloId = newId();
		conn.expectResult = "hello";
		conn.send(helloEnvelope(helloId, opts.token, opts.from));
		const helloResult = readHello(await conn.nextFrame(), helloId);
		if (helloResult.sessionId !== opts.to.sessionId) {
			throw new ProtocolError("identity_mismatch", "hello sessionId does not match the target");
		}
		if (opts.to.instanceId !== undefined && helloResult.instanceId !== opts.to.instanceId) {
			throw new ProtocolError("identity_mismatch", "hello instanceId does not match the target");
		}

		const requestId = newId();
		conn.expectResult = opts.type;
		conn.send(requestEnvelope(requestId, opts));

		for (; ;) {
			const frame = await conn.nextFrame();
			if (frame.type === "error") throw errorFromBody(frame.body);
			if (frame.type === "progress") {
				if (frame.replyTo !== requestId) {
					throw new ProtocolError("bad_request", "progress replyTo mismatch");
				}
				// Content is advisory; a throwing callback must not break the connection.
				try {
					opts.onProgress?.(frame.body as ProgressBody);
				} catch {
					// ignore
				}
				continue;
			}
			if (frame.type === "result") {
				if (frame.replyTo !== requestId) {
					throw new ProtocolError("bad_request", "result replyTo mismatch");
				}
				return { hello: helloResult, result: frame.body };
			}
			throw new ProtocolError("bad_request", `unexpected frame type ${frame.type}`);
		}
	} finally {
		conn.dispose();
	}
}
