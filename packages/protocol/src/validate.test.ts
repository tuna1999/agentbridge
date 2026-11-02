import { expect, test } from "bun:test";
import {
	DEFAULT_MAX_QUESTION_BYTES,
	type Envelope,
	type ErrorCode,
	type MsgType,
	parseEnvelope,
	type ParseEnvelopeOptions,
	PROTOCOL_VERSION,
	ProtocolError,
} from "./index";

type Json = Record<string, unknown>;

const SESSION = "01a18dd3-7bdd-71ef-9ea9-1312bd62b611";

function peer(agent: "claude-code" | "omp" = "claude-code"): Json {
	return { agent, sessionId: SESSION };
}

function envelope(type: MsgType, body: unknown, extra: Json = {}): Json {
	return {
		v: PROTOCOL_VERSION,
		id: SESSION,
		type,
		from: peer(),
		ts: 1_700_000_000_000,
		hop: 0,
		body,
		...extra,
	};
}

function request(type: "status" | "consult" | "chat", body: unknown): Json {
	return envelope(type, body, { to: peer("omp") });
}

function response(type: "progress" | "result" | "error", body: unknown): Json {
	return envelope(type, body, { replyTo: SESSION });
}

const HELLO_BODY = { token: "token", clientNonce: "nonce", protocol: [1] };
const CONSULT_BODY = { question: "xin chào" };
const CHAT_BODY = { message: "chạy test giúp tôi", timeoutMs: 600_000 };
const PROGRESS_BODY = { phase: "running" };
const RESULT_BODY = {
	replyText: "ok",
	truncated: false,
	model: { provider: "provider", id: "model" },
	durationMs: 10,
	capped: false,
};
const ERROR_BODY = { code: "denied", message: "no", retryable: false };
const HELLO_RESULT = {
	sessionId: SESSION,
	instanceId: "instance-1",
	agentVersion: "18.14.0",
	extensionVersion: "0.0.0",
	protocol: 1,
	capabilities: ["status", "consult"],
	model: { provider: "provider", id: "model" },
	status: "idle",
	serverNonce: "nonce",
};
const STATUS_RESULT = {
	sessionId: SESSION,
	instanceId: "instance-1",
	agentVersion: "18.14.0",
	extensionVersion: "0.0.0",
	capabilities: ["status", "consult"],
	model: { provider: "provider", id: "model" },
	status: "idle",
	cwd: "/tmp/project",
	git: { worktree: "/tmp/project", commonDir: "/tmp/project/.git", branch: "main" },
	pendingMessages: false,
	policy: { projectAllowed: true, consultConsent: "ask" },
};

function parse(value: Json): Envelope | ProtocolError {
	return parseEnvelope(JSON.stringify(value));
}

function expectBad(value: Json, code: ErrorCode = "bad_request", options?: ParseEnvelopeOptions): void {
	const result = parseEnvelope(JSON.stringify(value), options);
	expect(result).toBeInstanceOf(ProtocolError);
	expect((result as ProtocolError).code).toBe(code);
}

test("accepts a hello frame", () => {
	expect(parse(envelope("hello", HELLO_BODY))).not.toBeInstanceOf(ProtocolError);
});

test("accepts a status frame", () => {
	expect(parse(request("status", {}))).not.toBeInstanceOf(ProtocolError);
});

test("accepts a consult frame", () => {
	expect(parse(request("consult", CONSULT_BODY))).not.toBeInstanceOf(ProtocolError);
});

test("accepts a chat frame", () => {
	expect(parse(request("chat", CHAT_BODY))).not.toBeInstanceOf(ProtocolError);
});

test("accepts every progress phase", () => {
	for (const phase of ["awaiting_consent", "running", "delta"]) {
		expect(parse(response("progress", { phase }))).not.toBeInstanceOf(ProtocolError);
	}
});

test("accepts a result frame with usage", () => {
	const body = { ...RESULT_BODY, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 } };
	expect(parse(response("result", body))).not.toBeInstanceOf(ProtocolError);
});

test("accepts an error frame with details", () => {
	const body = { ...ERROR_BODY, details: { retryAfterMs: 100 } };
	expect(parse(response("error", body))).not.toBeInstanceOf(ProtocolError);
});

test("preserves the body and optional fields", () => {
	const value = request("consult", CONSULT_BODY);
	value.ttlMs = 1_000;
	const result = parse(value) as Envelope;
	expect(result.body).toEqual(CONSULT_BODY);
	expect(result.ttlMs).toBe(1_000);
	expect(result.replyTo).toBeUndefined();
});

test("rejects malformed JSON", () => {
	const result = parseEnvelope("{");
	expect(result).toBeInstanceOf(ProtocolError);
	expect((result as ProtocolError).code).toBe("bad_request");
});

test("rejects non-object JSON", () => {
	for (const line of ["[]", "null", "42", '"text"']) {
		const result = parseEnvelope(line);
		expect(result).toBeInstanceOf(ProtocolError);
		expect((result as ProtocolError).code).toBe("bad_request");
	}
});

test("rejects a missing or unsupported version", () => {
	const missing = request("status", {});
	delete missing.v;
	expect(parse(missing)).toBeInstanceOf(ProtocolError);
	expect((parse(missing) as ProtocolError).code).toBe("unsupported_version");

	const wrong = request("status", {});
	wrong.v = 2;
	expect((parse(wrong) as ProtocolError).code).toBe("unsupported_version");
});

test("rejects a missing or non-zero hop", () => {
	const missing = request("status", {});
	delete missing.hop;
	expectBad(missing);
	const wrong = request("status", {});
	wrong.hop = 1;
	expectBad(wrong);
});

test("rejects bad id and type fields", () => {
	for (const value of [undefined, "", 5]) {
		const frame = request("status", {});
		frame.id = value;
		expectBad(frame);
	}
	for (const value of [undefined, "", "work"]) {
		const frame = request("status", {});
		frame.type = value;
		expectBad(frame);
	}
});

test("requires replyTo on responses", () => {
	for (const type of ["progress", "result", "error"] as const) {
		const body = type === "progress" ? PROGRESS_BODY : type === "result" ? RESULT_BODY : ERROR_BODY;
		const frame = envelope(type, body);
		expectBad(frame);
	}
});

test("rejects an empty or invalid replyTo", () => {
	const empty = response("progress", PROGRESS_BODY);
	empty.replyTo = "";
	expectBad(empty);
	const invalid = response("progress", PROGRESS_BODY);
	invalid.replyTo = 7;
	expectBad(invalid);
});

test("requires to on status and consult", () => {
	for (const type of ["status", "consult"] as const) {
		const frame = envelope(type, type === "status" ? {} : CONSULT_BODY);
		expectBad(frame);
	}
});

test("rejects an invalid to peer", () => {
	const frame = request("status", {});
	frame.to = { agent: "other", sessionId: SESSION };
	expectBad(frame);
});

test("rejects a bad from peer", () => {
	for (const value of [undefined, null, "peer"]) {
		const frame = request("status", {});
		frame.from = value;
		expectBad(frame);
	}
	const badAgent = request("status", {});
	badAgent.from = { agent: "other", sessionId: SESSION };
	expectBad(badAgent);
});

test("rejects bad peer session ids", () => {
	for (const sessionId of ["", "x".repeat(129)]) {
		const frame = request("status", {});
		frame.from = { agent: "claude-code", sessionId };
		expectBad(frame);
	}
});

test("rejects bad peer pid and instanceId", () => {
	for (const pid of [0, 1.5, "1"]) {
		const frame = request("status", {});
		frame.from = { ...peer(), pid };
		expectBad(frame);
	}
	const frame = request("status", {});
	frame.from = { ...peer(), instanceId: "" };
	expectBad(frame);
});

test("rejects bad timestamps and ttl", () => {
	const badTs = request("status", {});
	badTs.ts = "now";
	expectBad(badTs);
	for (const ttlMs of [0, -1, "1s"]) {
		const frame = request("status", {});
		frame.ttlMs = ttlMs;
		expectBad(frame);
	}
});

test("rejects a missing or non-object body", () => {
	for (const value of [undefined, null, [], "body"]) {
		const frame = request("status", {});
		frame.body = value;
		expectBad(frame);
	}
});

test("validates hello body fields", () => {
	for (const body of [{ clientNonce: "n", protocol: [1] }, { token: "", clientNonce: "n", protocol: [1] }]) {
		expectBad(envelope("hello", body));
	}
	for (const protocol of [undefined, null, [], ["1"]]) {
		expectBad(envelope("hello", { token: "t", clientNonce: "n", protocol }));
	}
});

test("validates consult question bytes", () => {
	expectBad(request("consult", {}));
	expectBad(request("consult", { question: 1 }));

	const tooLarge = "ế".repeat(10_923);
	expect(Buffer.byteLength(tooLarge, "utf8")).toBe(DEFAULT_MAX_QUESTION_BYTES + 1);
	const oversized = parseEnvelope(JSON.stringify(request("consult", { question: tooLarge })));
	expect(oversized).toBeInstanceOf(ProtocolError);
	expect((oversized as ProtocolError).code).toBe("too_large");

	const exact = `${"ế".repeat(10_922)}aa`;
	expect(Buffer.byteLength(exact, "utf8")).toBe(DEFAULT_MAX_QUESTION_BYTES);
	expect(parse(request("consult", { question: exact }))).not.toBeInstanceOf(ProtocolError);
});

test("honours a smaller question limit", () => {
	const value = request("consult", { question: "abcdef" });
	const result = parseEnvelope(JSON.stringify(value), { maxQuestionBytes: 5 });
	expect(result).toBeInstanceOf(ProtocolError);
});

test("validates consult attachments", () => {
	const valid = request("consult", {
		...CONSULT_BODY,
		attachments: [{ path: "src/a.ts", startLine: 1, endLine: 2, text: "const a = 1;" }],
	});
	expect(parse(valid)).not.toBeInstanceOf(ProtocolError);

	expectBad(request("consult", { ...CONSULT_BODY, attachments: "file" }));
	expectBad(request("consult", { ...CONSULT_BODY, attachments: [null] }));
	expectBad(request("consult", { ...CONSULT_BODY, attachments: [{ path: "", text: "x" }] }));
	expectBad(request("consult", { ...CONSULT_BODY, attachments: [{ path: "a", startLine: 0, text: "x" }] }));
	expectBad(request("consult", { ...CONSULT_BODY, attachments: [{ path: "a", endLine: 1.5, text: "x" }] }));
	expectBad(request("consult", { ...CONSULT_BODY, attachments: [{ path: "a" }] }));
});

test("validates consult limits and stream", () => {
	expect(parse(request("consult", { ...CONSULT_BODY, limits: { maxTokens: 10, replyMaxBytes: 100 } }))).not.toBeInstanceOf(
		ProtocolError,
	);
	expectBad(request("consult", { ...CONSULT_BODY, limits: "limits" }));
	expectBad(request("consult", { ...CONSULT_BODY, limits: { maxTokens: 0 } }));
	expectBad(request("consult", { ...CONSULT_BODY, limits: { replyMaxBytes: "100" } }));
	expectBad(request("consult", { ...CONSULT_BODY, stream: "yes" }));
});

test("validates chat message bytes and timeout", () => {
	expectBad(request("chat", {}));
	expectBad(request("chat", { message: 1, timeoutMs: 1_000 }));
	expectBad(request("chat", { message: "hello" }));
	expectBad(request("chat", { message: "hello", timeoutMs: 0 }));
	expectBad(request("chat", { message: "hello", timeoutMs: 1.5 }));
	expectBad(request("chat", { message: "hello", timeoutMs: 1_800_001 }));

	const tooLarge = "ế".repeat(10_923);
	const oversized = parseEnvelope(JSON.stringify(request("chat", { message: tooLarge, timeoutMs: 1_000 })));
	expect(oversized).toBeInstanceOf(ProtocolError);
	expect((oversized as ProtocolError).code).toBe("too_large");
});

test("validates chat result body fields", () => {
	const CHAT_RESULT = {
		replyText: "ok",
		truncated: false,
		model: { provider: "openai", id: "gpt" },
		durationMs: 10,
	};
	expect(parseEnvelope(JSON.stringify(response("result", CHAT_RESULT)), { expectResult: "chat" })).not.toBeInstanceOf(
		ProtocolError,
	);
	for (const patch of [
		{ replyText: 1 },
		{ truncated: "no" },
		{ model: undefined },
		{ durationMs: "10" },
		{ usage: "usage" },
		{ usage: { output: "2" } },
	]) {
		expectBad(response("result", { ...CHAT_RESULT, ...patch }), "bad_request", { expectResult: "chat" });
	}
});

test("validates progress body fields", () => {
	expectBad(response("progress", {}));
	expectBad(response("progress", { phase: "unknown" }));
	expectBad(response("progress", { phase: "delta", delta: 1 }));
});

test("validates result body fields", () => {
	for (const patch of [
		{ replyText: 1 },
		{ truncated: "no" },
		{ model: undefined },
		{ model: { provider: "", id: "m" } },
		{ model: { provider: "p", id: 5 } },
		{ durationMs: "10" },
		{ capped: 0 },
		{ usage: "usage" },
		{ usage: { input: "1" } },
	]) {
		expectBad(response("result", { ...RESULT_BODY, ...patch }), "bad_request", { expectResult: "consult" });
	}
});

test("validates error body fields", () => {
	for (const patch of [
		{ code: "not_a_code" },
		{ message: 1 },
		{ retryable: "no" },
		{ details: [] },
	]) {
		expectBad(response("error", { ...ERROR_BODY, ...patch }));
	}
});

test("validates a hello result when expected", () => {
	expect(parseEnvelope(JSON.stringify(response("result", HELLO_RESULT)), { expectResult: "hello" })).not.toBeInstanceOf(
		ProtocolError,
	);
	const withoutModel = { ...HELLO_RESULT } as Json;
	delete withoutModel.model;
	expect(parseEnvelope(JSON.stringify(response("result", withoutModel)), { expectResult: "hello" })).not.toBeInstanceOf(
		ProtocolError,
	);
	const missingInstance = { ...HELLO_RESULT } as Json;
	delete missingInstance.instanceId;
	expectBad(response("result", missingInstance), "bad_request", { expectResult: "hello" });
});

test("rejects malformed hello results", () => {
	const patches: Json[] = [
		{ sessionId: "" },
		{ sessionId: "x".repeat(129) },
		{ instanceId: "" },
		{ agentVersion: 1 },
		{ extensionVersion: 1 },
		{ protocol: 2 },
		{ capabilities: "status" },
		{ capabilities: ["unknown"] },
		{ model: { provider: "", id: "m" } },
		{ status: "sleeping" },
		{ serverNonce: "" },
	];
	for (const patch of patches) {
		expectBad(response("result", { ...HELLO_RESULT, ...patch }), "bad_request", { expectResult: "hello" });
	}
});

test("validates a status result when expected", () => {
	expect(parseEnvelope(JSON.stringify(response("result", STATUS_RESULT)), { expectResult: "status" })).not.toBeInstanceOf(
		ProtocolError,
	);
	const withoutGit = { ...STATUS_RESULT } as Json;
	delete withoutGit.git;
	delete withoutGit.model;
	expect(parseEnvelope(JSON.stringify(response("result", withoutGit)), { expectResult: "status" })).not.toBeInstanceOf(
		ProtocolError,
	);
	const missingPolicy = { ...STATUS_RESULT } as Json;
	delete missingPolicy.policy;
	expectBad(response("result", missingPolicy), "bad_request", { expectResult: "status" });
});

test("rejects malformed status results", () => {
	const patches: Json[] = [
		{ sessionId: "" },
		{ instanceId: "" },
		{ agentVersion: 1 },
		{ extensionVersion: 1 },
		{ capabilities: ["unknown"] },
		{ model: { provider: "p", id: "" } },
		{ status: "sleeping" },
		{ cwd: "" },
		{ git: "git" },
		{ git: { worktree: "", commonDir: "/x" } },
		{ git: { worktree: "/x", commonDir: 1 } },
		{ git: { worktree: "/x", commonDir: "/y", branch: 1 } },
		{ pendingMessages: "no" },
		{ policy: undefined },
		{ policy: { projectAllowed: "yes", consultConsent: "ask" } },
		{ policy: { projectAllowed: true, consultConsent: "never" } },
	];
	for (const patch of patches) {
		expectBad(response("result", { ...STATUS_RESULT, ...patch }), "bad_request", { expectResult: "status" });
	}
});

test("validates a consult result when expected", () => {
	expect(parseEnvelope(JSON.stringify(response("result", RESULT_BODY)), { expectResult: "consult" })).not.toBeInstanceOf(
		ProtocolError,
	);
	expectBad(response("result", { ...RESULT_BODY, replyText: 1 }), "bad_request", { expectResult: "consult" });
});

test("accepts any object result without expectResult", () => {
	expect(parse(response("result", { anything: true }))).not.toBeInstanceOf(ProtocolError);
});
