import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Envelope,
	newId,
	type ProgressBody,
	PROTOCOL_VERSION,
	ProtocolError,
} from "@agentbridge/protocol";
import {
	endpointFor,
	type HelloResultProvider,
	type RequestIO,
	type RequestOptions,
	request,
	type ServerHandle,
	startServer,
} from "./index";

const TOKEN = "test-token-0123456789";
const SESSION_ID = "session-1";
const INSTANCE_ID = "instance-1";
const TARGET = { agent: "omp" as const, sessionId: SESSION_ID, instanceId: INSTANCE_ID };
const CALLER = { agent: "claude-code" as const, sessionId: "caller" };

const consultResult = {
	replyText: "hi",
	truncated: false,
	model: { provider: "openai", id: "gpt" },
	durationMs: 5,
	capped: false,
};

interface ScheduledTimer {
	ms: number | undefined;
	run: () => void;
}

/** Deterministic replacement for the client's timeout so tests never sleep. */
function captureTimers(): { next(ms: number): Promise<ScheduledTimer>; restore(): void } {
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
	dir = mkdtempSync(join(tmpdir(), "ab-core-ipc-cli-"));
	mkdirSync(join(dir, "s"), { mode: 0o700 });
});

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	rmSync(dir, { recursive: true, force: true });
});

function endpoint(): string {
	return endpointFor(dir, INSTANCE_ID);
}

test("rejects an overlong endpoint with AGENTBRIDGE_RUNTIME_DIR guidance", async () => {
	const longEndpoint = `unix:${join(dir, "z".repeat(100), "socket")}`;
	await expect(
		request({
			endpoint: longEndpoint,
			token: TOKEN,
			from: CALLER,
			to: TARGET,
			type: "status",
			body: {},
			timeoutMs: 1_000,
		}),
	).rejects.toThrow(/AGENTBRIDGE_RUNTIME_DIR/);
});

function identity(): HelloResultProvider {
	return (serverNonce) => ({
		sessionId: SESSION_ID,
		instanceId: INSTANCE_ID,
		agentVersion: "18.14.0",
		extensionVersion: "0.1.0",
		protocol: 1,
		capabilities: ["status", "consult"],
		status: "idle",
		serverNonce,
	});
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

function progressFrame(requestFrame: Envelope, body: ProgressBody): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id: newId(),
		type: "progress",
		replyTo: requestFrame.id,
		from: { agent: "omp", sessionId: SESSION_ID },
		ts: Date.now(),
		hop: 0,
		body,
	};
}

function errorFrame(requestFrame: Envelope, code: "denied", message: string): Envelope {
	return {
		v: PROTOCOL_VERSION,
		id: newId(),
		type: "error",
		replyTo: requestFrame.id,
		from: { agent: "omp", sessionId: SESSION_ID },
		ts: Date.now(),
		hop: 0,
		body: { code, message, retryable: false },
	};
}

async function waitForAbort(io: RequestIO): Promise<void> {
	const done = Promise.withResolvers<void>();
	const onAbort = () => done.resolve();
	if (io.signal.aborted) onAbort();
	else io.signal.addEventListener("abort", onAbort, { once: true });
	await done.promise;
}

async function start(onRequest: (env: Envelope, io: RequestIO) => Promise<void>): Promise<ServerHandle> {
	const server = await startServer({ endpoint: endpoint(), token: TOKEN, identity: identity(), onRequest });
	servers.push(server);
	return server;
}

function baseRequest(): RequestOptions {
	return {
		endpoint: endpoint(),
		token: TOKEN,
		from: CALLER,
		to: TARGET,
		type: "consult",
		body: { question: "hello" },
		timeoutMs: 5_000,
	};
}

test("collects progress and returns the consult result", async () => {
	const phases: string[] = [];
	await start(async (env, io) => {
		io.send(progressFrame(env, { phase: "awaiting_consent" }));
		io.send(progressFrame(env, { phase: "running" }));
		io.send(progressFrame(env, { phase: "delta", delta: "hi" }));
		io.send(resultFrame(env, consultResult));
	});

	const response = await request({
		...baseRequest(),
		onProgress: (progress: ProgressBody) => {
			phases.push(progress.phase);
		},
	});
	expect(phases).toEqual(["awaiting_consent", "running", "delta"]);
	expect(response.hello.instanceId).toBe(INSTANCE_ID);
	expect(response.result).toEqual(consultResult);
});

test("rejects hello identities that do not match the target", async () => {
	let requested = false;
	await start(async () => {
		requested = true;
	});

	const wrongSession = await request({
		...baseRequest(),
		to: { agent: "omp", sessionId: "other-session" },
	}).catch((caught: unknown) => caught);
	expect(wrongSession).toBeInstanceOf(ProtocolError);
	expect((wrongSession as ProtocolError).code).toBe("identity_mismatch");

	const wrongInstance = await request({
		...baseRequest(),
		to: { agent: "omp", sessionId: SESSION_ID, instanceId: "other-instance" },
	}).catch((caught: unknown) => caught);
	expect(wrongInstance).toBeInstanceOf(ProtocolError);
	expect((wrongInstance as ProtocolError).code).toBe("identity_mismatch");

	expect(requested).toBe(false);
});

test("aborting closes the socket and aborts the server signal", async () => {
	const entered = Promise.withResolvers<void>();
	const serverDone = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	await start(async (_env, io) => {
		signal = io.signal;
		entered.resolve();
		await waitForAbort(io);
		serverDone.resolve();
	});

	const controller = new AbortController();
	const pending = request({ ...baseRequest(), signal: controller.signal });
	await entered.promise;
	controller.abort();
	const error = await pending.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ProtocolError);
	expect((error as ProtocolError).code).toBe("cancelled");
	await serverDone.promise;
	expect(signal?.aborted).toBe(true);
});

test("reports target_exited when the server closes mid-request", async () => {
	const entered = Promise.withResolvers<void>();
	const server = await start(async (_env, io) => {
		entered.resolve();
		await waitForAbort(io);
	});

	const pending = request(baseRequest()).catch((caught: unknown) => caught);
	await entered.promise;
	await server.close();
	const error = await pending;
	expect(error).toBeInstanceOf(ProtocolError);
	expect((error as ProtocolError).code).toBe("target_exited");
	expect((error as ProtocolError).details?.reason).not.toBe("timeout");
});

test("times out when no result arrives", async () => {
	await start(async (_env, io) => {
		await waitForAbort(io);
	});

	const capture = captureTimers();
	try {
		const pending = request({ ...baseRequest(), timeoutMs: 100 });
		const timer = await capture.next(100);
		timer.run();
		const error = await pending.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe("target_exited");
		expect((error as ProtocolError).message).toContain("timeout");
		expect((error as ProtocolError).details).toEqual({ reason: "timeout" });
	} finally {
		capture.restore();
	}
});

test("surfaces server error frames", async () => {
	await start(async (env, io) => {
		io.send(errorFrame(env, "denied", "consent denied"));
	});

	const error = await request(baseRequest()).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ProtocolError);
	expect((error as ProtocolError).code).toBe("denied");
});
