/** Hand-written envelope validator. Spec: docs/plan/01-design-spec.md §4.5. */
import { PROTOCOL_VERSION, type Envelope, type MsgType, type Peer } from "./envelope";
import { isErrorCode, ProtocolError } from "./errors";
import { isRecord } from "./guards";
import { CHAT_TIMEOUT_MAX_MS, DEFAULT_MAX_QUESTION_BYTES } from "./limits";
import { VALIDATION_MESSAGES as MSG } from "./messages";

export interface ParseEnvelopeOptions {
	/** Overrides `DEFAULT_MAX_QUESTION_BYTES` (config `consult.maxQuestionBytes`). */
	maxQuestionBytes?: number;
	/** Chooses the validator for a `result` body; absent means "object only". */
	expectResult?: "hello" | "status" | "consult" | "chat";
}

const MSG_TYPES: readonly MsgType[] = ["hello", "status", "consult", "chat", "progress", "result", "error"];
const RESPONSE_TYPES: readonly MsgType[] = ["progress", "result", "error"];
const REQUEST_TYPES: readonly MsgType[] = ["status", "consult", "chat"];
const PROGRESS_PHASES = ["awaiting_consent", "running", "delta"] as const;
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
const CAPABILITIES = ["status", "consult", "chat", "delegate"] as const;
const AGENT_STATUSES = ["idle", "busy", "waiting"] as const;
const CONSENT_POLICIES = ["ask", "session", "always", "deny"] as const;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function bad(message: string): ProtocolError {
	return new ProtocolError("bad_request", message);
}

function badField(field: string): ProtocolError {
	return bad(MSG.badField(field));
}

function parsePeer(value: unknown, path: string): Peer | ProtocolError {
	if (!isRecord(value)) return badField(path);
	const { agent, sessionId, pid, instanceId } = value;
	if (agent !== "claude-code" && agent !== "omp") return badField(`${path}.agent`);
	if (!isNonEmptyString(sessionId) || sessionId.length > 128) return badField(`${path}.sessionId`);
	if (pid !== undefined && !isPositiveInteger(pid)) return badField(`${path}.pid`);
	if (instanceId !== undefined && !isNonEmptyString(instanceId)) return badField(`${path}.instanceId`);
	const peer: Peer = { agent, sessionId };
	if (pid !== undefined) peer.pid = pid;
	if (instanceId !== undefined) peer.instanceId = instanceId;
	return peer;
}

function validateHello(body: Record<string, unknown>): ProtocolError | undefined {
	if (!isNonEmptyString(body.token)) return badField("body.token");
	if (!isNonEmptyString(body.clientNonce)) return badField("body.clientNonce");
	if (!Array.isArray(body.protocol) || body.protocol.length === 0) return badField("body.protocol");
	if (!body.protocol.every((version) => Number.isInteger(version))) return badField("body.protocol");
	return undefined;
}

function validateAttachment(value: unknown, index: number): ProtocolError | undefined {
	const path = `body.attachments[${index}]`;
	if (!isRecord(value)) return badField(path);
	if (!isNonEmptyString(value.path)) return badField(`${path}.path`);
	if (value.startLine !== undefined && !isPositiveInteger(value.startLine)) return badField(`${path}.startLine`);
	if (value.endLine !== undefined && !isPositiveInteger(value.endLine)) return badField(`${path}.endLine`);
	if (typeof value.text !== "string") return badField(`${path}.text`);
	return undefined;
}

function validateConsult(body: Record<string, unknown>, options: ParseEnvelopeOptions): ProtocolError | undefined {
	if (typeof body.question !== "string") return badField("body.question");
	const limit = options.maxQuestionBytes ?? DEFAULT_MAX_QUESTION_BYTES;
	if (Buffer.byteLength(body.question, "utf8") > limit) {
		return new ProtocolError("too_large", MSG.questionTooLarge(limit));
	}

	if (body.attachments !== undefined) {
		if (!Array.isArray(body.attachments)) return badField("body.attachments");
		for (let index = 0; index < body.attachments.length; index += 1) {
			const error = validateAttachment(body.attachments[index] as unknown, index);
			if (error !== undefined) return error;
		}
	}

	if (body.limits !== undefined) {
		if (!isRecord(body.limits)) return badField("body.limits");
		if (body.limits.maxTokens !== undefined && !isPositiveInteger(body.limits.maxTokens)) {
			return badField("body.limits.maxTokens");
		}
		if (body.limits.replyMaxBytes !== undefined && !isPositiveInteger(body.limits.replyMaxBytes)) {
			return badField("body.limits.replyMaxBytes");
		}
	}

	if (body.stream !== undefined && typeof body.stream !== "boolean") return badField("body.stream");
	return undefined;
}

function validateProgress(body: Record<string, unknown>): ProtocolError | undefined {
	if (typeof body.phase !== "string" || !(PROGRESS_PHASES as readonly string[]).includes(body.phase)) {
		return badField("body.phase");
	}
	if (body.delta !== undefined && typeof body.delta !== "string") return badField("body.delta");
	return undefined;
}

function validateChat(body: Record<string, unknown>, options: ParseEnvelopeOptions): ProtocolError | undefined {
	if (typeof body.message !== "string") return badField("body.message");
	const limit = options.maxQuestionBytes ?? DEFAULT_MAX_QUESTION_BYTES;
	if (Buffer.byteLength(body.message, "utf8") > limit) {
		return new ProtocolError("too_large", MSG.messageTooLarge(limit));
	}
	if (!isPositiveInteger(body.timeoutMs) || body.timeoutMs > CHAT_TIMEOUT_MAX_MS) {
		return badField("body.timeoutMs");
	}
	return undefined;
}

function validateModel(value: unknown, path: string): ProtocolError | undefined {
	if (!isRecord(value)) return badField(path);
	if (!isNonEmptyString(value.provider)) return badField(`${path}.provider`);
	if (!isNonEmptyString(value.id)) return badField(`${path}.id`);
	return undefined;
}

function validateConsultResult(body: Record<string, unknown>): ProtocolError | undefined {
	if (typeof body.replyText !== "string") return badField("body.replyText");
	if (typeof body.truncated !== "boolean") return badField("body.truncated");
	const modelError = validateModel(body.model, "body.model");
	if (modelError !== undefined) return modelError;
	if (body.usage !== undefined) {
		if (!isRecord(body.usage)) return badField("body.usage");
		for (const field of USAGE_FIELDS) {
			if (body.usage[field] !== undefined && !isFiniteNumber(body.usage[field])) {
				return badField(`body.usage.${field}`);
			}
		}
	}
	if (!isFiniteNumber(body.durationMs)) return badField("body.durationMs");
	if (typeof body.capped !== "boolean") return badField("body.capped");
	return undefined;
}

function validateChatResult(body: Record<string, unknown>): ProtocolError | undefined {
	if (typeof body.replyText !== "string") return badField("body.replyText");
	if (typeof body.truncated !== "boolean") return badField("body.truncated");
	const modelError = validateModel(body.model, "body.model");
	if (modelError !== undefined) return modelError;
	if (body.usage !== undefined) {
		if (!isRecord(body.usage)) return badField("body.usage");
		for (const field of USAGE_FIELDS) {
			if (body.usage[field] !== undefined && !isFiniteNumber(body.usage[field])) {
				return badField(`body.usage.${field}`);
			}
		}
	}
	if (!isFiniteNumber(body.durationMs)) return badField("body.durationMs");
	return undefined;
}

function isCapability(value: unknown): boolean {
	return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

function isAgentStatus(value: unknown): boolean {
	return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);
}

function isConsentPolicy(value: unknown): boolean {
	return typeof value === "string" && (CONSENT_POLICIES as readonly string[]).includes(value);
}

function validateGitInfo(value: unknown, path: string): ProtocolError | undefined {
	if (!isRecord(value)) return badField(path);
	if (!isNonEmptyString(value.worktree)) return badField(`${path}.worktree`);
	if (!isNonEmptyString(value.commonDir)) return badField(`${path}.commonDir`);
	if (value.branch !== undefined && typeof value.branch !== "string") return badField(`${path}.branch`);
	return undefined;
}

function validateHelloResult(body: Record<string, unknown>): ProtocolError | undefined {
	if (!isNonEmptyString(body.sessionId) || body.sessionId.length > 128) return badField("body.sessionId");
	if (!isNonEmptyString(body.instanceId)) return badField("body.instanceId");
	if (typeof body.agentVersion !== "string") return badField("body.agentVersion");
	if (typeof body.extensionVersion !== "string") return badField("body.extensionVersion");
	if (body.protocol !== PROTOCOL_VERSION) return badField("body.protocol");
	if (!Array.isArray(body.capabilities) || !body.capabilities.every(isCapability)) return badField("body.capabilities");
	if (body.model !== undefined) {
		const modelError = validateModel(body.model, "body.model");
		if (modelError !== undefined) return modelError;
	}
	if (!isAgentStatus(body.status)) return badField("body.status");
	if (!isNonEmptyString(body.serverNonce)) return badField("body.serverNonce");
	return undefined;
}

function validateStatusResult(body: Record<string, unknown>): ProtocolError | undefined {
	if (!isNonEmptyString(body.sessionId) || body.sessionId.length > 128) return badField("body.sessionId");
	if (!isNonEmptyString(body.instanceId)) return badField("body.instanceId");
	if (typeof body.agentVersion !== "string") return badField("body.agentVersion");
	if (typeof body.extensionVersion !== "string") return badField("body.extensionVersion");
	if (!Array.isArray(body.capabilities) || !body.capabilities.every(isCapability)) return badField("body.capabilities");
	if (body.model !== undefined) {
		const modelError = validateModel(body.model, "body.model");
		if (modelError !== undefined) return modelError;
	}
	if (!isAgentStatus(body.status)) return badField("body.status");
	if (!isNonEmptyString(body.cwd)) return badField("body.cwd");
	if (body.git !== undefined) {
		const gitError = validateGitInfo(body.git, "body.git");
		if (gitError !== undefined) return gitError;
	}
	if (typeof body.pendingMessages !== "boolean") return badField("body.pendingMessages");
	if (!isRecord(body.policy)) return badField("body.policy");
	if (typeof body.policy.projectAllowed !== "boolean") return badField("body.policy.projectAllowed");
	if (!isConsentPolicy(body.policy.consultConsent)) return badField("body.policy.consultConsent");
	return undefined;
}

function validateResultBody(
	body: Record<string, unknown>,
	expect: ParseEnvelopeOptions["expectResult"],
): ProtocolError | undefined {
	switch (expect) {
		case undefined:
			return undefined;
		case "hello":
			return validateHelloResult(body);
		case "status":
			return validateStatusResult(body);
		case "consult":
			return validateConsultResult(body);
		case "chat":
			return validateChatResult(body);
	}
}

function validateError(body: Record<string, unknown>): ProtocolError | undefined {
	if (!isErrorCode(body.code)) return badField("body.code");
	if (typeof body.message !== "string") return badField("body.message");
	if (typeof body.retryable !== "boolean") return badField("body.retryable");
	if (body.details !== undefined && !isRecord(body.details)) return badField("body.details");
	return undefined;
}

function validateBody(type: MsgType, body: Record<string, unknown>, options: ParseEnvelopeOptions): ProtocolError | undefined {
	switch (type) {
		case "hello":
			return validateHello(body);
		case "status":
			return undefined;
		case "consult":
			return validateConsult(body, options);
		case "chat":
			return validateChat(body, options);
		case "progress":
			return validateProgress(body);
		case "result":
			return validateResultBody(body, options.expectResult);
		case "error":
			return validateError(body);
	}
}

/** Parse one JSON Lines frame. Returns a `ProtocolError` instead of throwing. */
export function parseEnvelope(line: string, options: ParseEnvelopeOptions = {}): Envelope | ProtocolError {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return bad(MSG.invalidJson);
	}
	if (!isRecord(parsed)) return bad(MSG.notObject);
	if (parsed.v !== PROTOCOL_VERSION) {
		return new ProtocolError("unsupported_version", MSG.unsupportedVersion(parsed.v));
	}
	if (parsed.hop !== 0) return bad(MSG.badHop);

	const id = parsed.id;
	if (!isNonEmptyString(id)) return badField("id");

	const type = parsed.type;
	if (typeof type !== "string" || !(MSG_TYPES as readonly string[]).includes(type)) return badField("type");

	const replyTo = parsed.replyTo;
	if (replyTo !== undefined && !isNonEmptyString(replyTo)) return badField("replyTo");
	if (RESPONSE_TYPES.includes(type as MsgType) && replyTo === undefined) return badField("replyTo");

	const from = parsePeer(parsed.from, "from");
	if (from instanceof ProtocolError) return from;

	let to: Peer | undefined;
	if (parsed.to !== undefined) {
		const parsedTo = parsePeer(parsed.to, "to");
		if (parsedTo instanceof ProtocolError) return parsedTo;
		to = parsedTo;
	}
	if (REQUEST_TYPES.includes(type as MsgType) && to === undefined) return badField("to");

	const ts = parsed.ts;
	if (!isFiniteNumber(ts)) return badField("ts");

	const ttlMs = parsed.ttlMs;
	if (ttlMs !== undefined && (!isFiniteNumber(ttlMs) || ttlMs <= 0)) return badField("ttlMs");

	const body = parsed.body;
	if (!isRecord(body)) return badField("body");
	const bodyError = validateBody(type as MsgType, body, options);
	if (bodyError !== undefined) return bodyError;

	const envelope: Envelope = { v: PROTOCOL_VERSION, id, type: type as MsgType, from, ts, hop: 0, body };
	if (replyTo !== undefined) envelope.replyTo = replyTo;
	if (to !== undefined) envelope.to = to;
	if (ttlMs !== undefined) envelope.ttlMs = ttlMs;
	return envelope;
}
