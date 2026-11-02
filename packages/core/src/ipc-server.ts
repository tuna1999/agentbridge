/** Unix-domain socket server for protocol v1. Spec: 01 §2, §4.1, §7.3, §9. */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import {
	AUTH_FAIL_LIMIT_PER_MIN,
	CLOCK_SKEW_MS,
	DEDUPE_LRU,
	DEDUPE_TTL_MS,
	type Envelope,
	type ErrorCode,
	HELLO_TIMEOUT_MS,
	type HelloResult,
	isRetryable,
	LineReader,
	LOCKOUT_MS,
	newId,
	parseEnvelope,
	PROTOCOL_VERSION,
	ProtocolError,
	REQUEST_TIMEOUT_MS,
} from "@agentbridge/protocol";
import { assertSocketPathLength } from "./dirs";

/**
 * Supplies the host half of the hello result. The transport generates a fresh
 * `serverNonce` per connection and passes it in; the provider decides the rest.
 */
export type HelloResultProvider = (serverNonce: string) => HelloResult | Promise<HelloResult>;

export interface RequestIO {
	send(frame: Envelope): void;
	signal: AbortSignal;
}

export type AuthFailReason = "bad_token" | "no_hello" | "locked";

export interface StartServerOptions {
	endpoint: string;
	token: string;
	identity: HelloResultProvider;
	onRequest: (env: Envelope, io: RequestIO) => Promise<void>;
	/** Called for auth failures; exceptions are swallowed so the server keeps running. */
	onAuthFail?: (info: { reason: AuthFailReason }) => void;
}

export interface ServerHandle {
	close(): Promise<void>;
}

/** `<runtimeDir>/s/<sha256(instanceId)[0..16]>.sock`, encoded as `unix:<abs path>`. */
export function endpointFor(runtimeDir: string, instanceId: string): string {
	const hash16 = createHash("sha256").update(instanceId).digest("hex").slice(0, 16);
	const path = join(resolve(runtimeDir), "s", `${hash16}.sock`);
	assertSocketPathLength(path);
	return `unix:${path}`;
}

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

function errorFrame(code: ErrorCode, message: string, replyTo: string, fromSession: string): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id: newId(),
		type: "error",
		replyTo,
		from: { agent: "omp", sessionId: fromSession },
		ts: Date.now(),
		hop: 0,
		body: { code, message, retryable: isRetryable(code) },
	};
}

function writeFrame(socket: Socket, frame: Envelope): boolean {
	try {
		if (socket.destroyed || !socket.writable) return false;
		socket.write(`${JSON.stringify(frame)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Best-effort correlation id for a frame that failed validation. */
function extractId(line: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
			const id = parsed.id;
			if (typeof id === "string" && id.length > 0) return id;
		}
	} catch {
		// not JSON; no id
	}
	return undefined;
}

function tokensMatch(received: string, expected: string): boolean {
	try {
		const a = Buffer.from(received, "utf8");
		const b = Buffer.from(expected, "utf8");
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

class AuthFailures {
	private times: number[] = [];
	private lockedUntil = 0;

	isLocked(now: number): boolean {
		if (this.lockedUntil > now) return true;
		if (this.lockedUntil !== 0) {
			this.lockedUntil = 0;
			this.times = [];
		}
		return false;
	}

	noteFailure(now: number): void {
		this.times = this.times.filter((at) => now - at < 60_000);
		this.times.push(now);
		if (this.times.length > AUTH_FAIL_LIMIT_PER_MIN) this.lockedUntil = now + LOCKOUT_MS;
	}
}

class Dedupe {
	private seen = new Map<string, number>();

	/** True when the id is new; also records it. */
	fresh(id: string): boolean {
		const now = Date.now();
		for (const [key, at] of this.seen) {
			if (now - at > DEDUPE_TTL_MS) this.seen.delete(key);
			else break;
		}
		if (this.seen.has(id)) return false;
		this.seen.set(id, now);
		while (this.seen.size > DEDUPE_LRU) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
		return true;
	}
}

function listenOnce(server: Server, path: string): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const onError = (error: Error): void => {
			try {
				server.off("listening", onListening);
				rejectPromise(error);
			} catch {
				// ignore
			}
		};
		const onListening = (): void => {
			try {
				server.off("error", onError);
				resolvePromise();
			} catch {
				// ignore
			}
		};
		server.once("error", onError);
		server.once("listening", onListening);
		try {
			server.listen(path);
		} catch (error) {
			server.off("error", onError);
			server.off("listening", onListening);
			rejectPromise(error);
		}
	});
}

function canConnect(path: string): Promise<boolean> {
	return new Promise((resolvePromise) => {
		let settled = false;
		let socket: Socket | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (alive: boolean): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			try {
				socket?.destroy();
			} catch {
				// ignore
			}
			resolvePromise(alive);
		};
		try {
			socket = connect(path);
			socket.once("connect", () => {
				try {
					done(true);
				} catch {
					done(true);
				}
			});
			socket.once("error", () => {
				try {
					done(false);
				} catch {
					done(false);
				}
			});
			timer = setTimeout(() => {
				try {
					done(true);
				} catch {
					done(true);
				}
			}, 250);
		} catch {
			done(false);
		}
	});
}

async function listen(server: Server, path: string): Promise<void> {
	try {
		await listenOnce(server, path);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		// Only steal the path when nothing is listening on it (01 T4).
		if (await canConnect(path)) throw error;
		await rm(path, { force: true });
		await listenOnce(server, path);
	}
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
	const endpoint = unixPath(opts.endpoint);
	const authFailures = new AuthFailures();
	const dedupe = new Dedupe();
	const sockets = new Set<Socket>();

	function noteAuthFail(reason: AuthFailReason): void {
		try {
			opts.onAuthFail?.({ reason });
		} catch {
			// Audit callbacks must not break the transport.
		}
	}

	function handleConnection(socket: Socket): void {
		try {
			if (authFailures.isLocked(Date.now())) {
				noteAuthFail("locked");
				socket.destroy();
				return;
			}
			sockets.add(socket);

			const reader = new LineReader();
			const abort = new AbortController();
			let authed = false;
			let helloStarted = false;
			let hello: HelloResult | undefined;
			let requestSeen = false;
			let finished = false;
			let closed = false;
			let helloTimer: ReturnType<typeof setTimeout> | undefined;
			let requestTimer: ReturnType<typeof setTimeout> | undefined;

			const cleanup = (): void => {
				if (helloTimer !== undefined) {
					clearTimeout(helloTimer);
					helloTimer = undefined;
				}
				if (requestTimer !== undefined) {
					clearTimeout(requestTimer);
					requestTimer = undefined;
				}
			};

			const end = (): void => {
				if (finished) return;
				finished = true;
				cleanup();
				try {
					socket.end();
				} catch {
					// ignore
				}
			};

			const fail = (code: ErrorCode, message: string, replyTo?: string): void => {
				if (finished || closed) return;
				writeFrame(socket, errorFrame(code, message, replyTo ?? newId(), hello?.sessionId ?? "unknown"));
				end();
			};

			const onClose = (): void => {
				try {
					if (closed) return;
					closed = true;
					cleanup();
					abort.abort();
					sockets.delete(socket);
				} catch {
					// ignore
				}
			};

			socket.on("close", () => {
				try {
					onClose();
				} catch {
					// ignore
				}
			});
			socket.on("error", () => {
				try {
					onClose();
				} catch {
					// ignore
				}
			});

			const pending: string[] = [];

			/** Consume queued lines; hello may still be awaiting identity(). */
			const pump = (): void => {
				try {
					if (finished || closed) return;
					if (!authed) {
						if (helloStarted || pending.length === 0) return;
						const line = pending.shift();
						if (line === undefined) return;
						helloStarted = true;
						void onHello(line);
						return;
					}
					if (requestSeen) {
						pending.length = 0;
						return;
					}
					const line = pending.shift();
					if (line === undefined) return;
					requestSeen = true;
					pending.length = 0;
					void onRequest(line);
				} catch {
					try {
						socket.destroy();
					} catch {
						// ignore
					}
				}
			};

			socket.on("data", (chunk: Buffer) => {
				try {
					if (finished || closed || requestSeen) return;
					let lines: string[];
					try {
						lines = reader.push(chunk);
					} catch (error) {
						if (error instanceof ProtocolError) fail(error.code, error.message);
						else fail("internal", "framing error");
						return;
					}
					for (const line of lines) pending.push(line);
					// At most hello + one request; anything later is ignored.
					if (pending.length > 2) pending.length = 2;
					pump();
				} catch {
					try {
						socket.destroy();
					} catch {
						// ignore
					}
				}
			});

			helloTimer = setTimeout(() => {
				try {
					if (!closed && !authed) {
						noteAuthFail("no_hello");
						fail("unauthorized", "hello timeout");
					}
				} catch {
					// ignore
				}
			}, HELLO_TIMEOUT_MS);

			async function onHello(line: string): Promise<void> {
				try {
					const parsed = parseEnvelope(line);
					if (parsed instanceof ProtocolError) {
						noteAuthFail("no_hello");
						fail(parsed.code, parsed.message, extractId(line));
						return;
					}
					if (parsed.type !== "hello") {
						noteAuthFail("no_hello");
						fail("unauthorized", "hello required", parsed.id);
						return;
					}
					const body = parsed.body as { token?: unknown; protocol?: unknown };
					const token = typeof body.token === "string" ? body.token : "";
					if (!tokensMatch(token, opts.token)) {
						noteAuthFail("bad_token");
						authFailures.noteFailure(Date.now());
						fail("unauthorized", "invalid token", parsed.id);
						return;
					}
					if (!Array.isArray(body.protocol) || !body.protocol.includes(PROTOCOL_VERSION)) {
						fail("unsupported_version", "protocol [1] required", parsed.id);
						return;
					}
					const nonce = newId();
					const result = await opts.identity(nonce);
					if (finished || closed) return;
					hello = result;
					authed = true;
					if (helloTimer !== undefined) {
						clearTimeout(helloTimer);
						helloTimer = undefined;
					}
					writeFrame(socket, {
						v: PROTOCOL_VERSION,
						id: newId(),
						type: "result",
						replyTo: parsed.id,
						from: { agent: "omp", sessionId: result.sessionId },
						ts: Date.now(),
						hop: 0,
						body: result,
					});
					requestTimer = setTimeout(() => {
						try {
							if (!closed && !requestSeen) fail("bad_request", "request timeout");
						} catch {
							// ignore
						}
					}, REQUEST_TIMEOUT_MS);
					pump();
				} catch (error) {
					if (error instanceof ProtocolError) fail(error.code, error.message);
					else fail("internal", error instanceof Error ? error.message : "identity provider failed");
				}
			}

			async function onRequest(line: string): Promise<void> {
				try {
					if (requestTimer !== undefined) {
						clearTimeout(requestTimer);
						requestTimer = undefined;
					}
					const parsed = parseEnvelope(line);
					if (parsed instanceof ProtocolError) {
						fail(parsed.code, parsed.message, extractId(line));
						return;
					}
					if (hello === undefined) {
						fail("unauthorized", "hello required", parsed.id);
						return;
					}
					if (parsed.to?.sessionId !== hello.sessionId || parsed.to?.instanceId !== hello.instanceId) {
						fail("identity_mismatch", "target does not match this host", parsed.id);
						return;
					}
					const now = Date.now();
					if (Math.abs(now - parsed.ts) > CLOCK_SKEW_MS) {
						fail("expired", "timestamp outside clock skew", parsed.id);
						return;
					}
					const ttl = parsed.ttlMs ?? (parsed.type === "consult" || parsed.type === "chat" ? DEDUPE_TTL_MS : undefined);
					if (ttl !== undefined && parsed.ts + ttl < now) {
						fail("expired", "request TTL elapsed", parsed.id);
						return;
					}
					if (!dedupe.fresh(parsed.id)) {
						fail("duplicate", "duplicate request id", parsed.id);
						return;
					}
					if (parsed.type !== "status" && parsed.type !== "consult" && parsed.type !== "chat") {
						fail("unsupported_capability", `unsupported request type ${parsed.type}`, parsed.id);
						return;
					}

					let terminal = false;
					const io: RequestIO = {
						send: (frame) => {
							try {
								if (finished || closed) return;
								if (writeFrame(socket, frame) && (frame.type === "result" || frame.type === "error")) {
									terminal = true;
								}
							} catch {
								// ignore
							}
						},
						signal: abort.signal,
					};

					try {
						await opts.onRequest(parsed, io);
					} catch (error) {
						if (!terminal && !finished && !closed) {
							if (error instanceof ProtocolError) fail(error.code, error.message, parsed.id);
							else {
								const message = error instanceof Error ? error.message.slice(0, 500) : "request handler failed";
								fail("internal", message, parsed.id);
							}
						}
						end();
						return;
					}
					if (!terminal) {
						fail("internal", "handler returned without a result", parsed.id);
						return;
					}
					end();
				} catch (error) {
					if (error instanceof ProtocolError) fail(error.code, error.message);
					else fail("internal", error instanceof Error ? error.message : "request failed");
				}
			}
		} catch {
			try {
				socket.destroy();
			} catch {
				// ignore
			}
		}
	}

	const server = createServer((socket) => {
		try {
			handleConnection(socket);
		} catch {
			try {
				socket.destroy();
			} catch {
				// ignore
			}
		}
	});

	let closing: Promise<void> | undefined;
	async function shutdown(removeSocket: boolean): Promise<void> {
		if (closing !== undefined) return closing;
		closing = (async () => {
			for (const socket of sockets) {
				try {
					socket.destroy();
				} catch {
					// ignore
				}
			}
			sockets.clear();
			await new Promise<void>((resolvePromise) => {
				try {
					server.close(() => {
						try {
							resolvePromise();
						} catch {
							// ignore
						}
					});
				} catch {
					resolvePromise();
				}
			});
			if (removeSocket) {
				try {
					await rm(endpoint, { force: true });
				} catch {
					// ignore
				}
			}
		})();
		return closing;
	}

	try {
		await listen(server, endpoint);
	} catch (error) {
		// The path may belong to a live server: never unlink it here.
		await shutdown(false);
		throw error;
	}
	try {
		await chmod(endpoint, 0o600);
	} catch (error) {
		await shutdown(true);
		throw error;
	}

	return { close: () => shutdown(true) };
}
