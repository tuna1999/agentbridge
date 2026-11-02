/** Envelope and frame bodies. Spec: docs/plan/01-design-spec.md §4.2–4.3. */

export const PROTOCOL_VERSION = 1;

export type MsgType = "hello" | "status" | "consult" | "chat" | "progress" | "result" | "error";
export type PeerAgent = "claude-code" | "omp";
export type AgentStatus = "idle" | "busy" | "waiting";
export type Capability = "status" | "consult" | "chat" | "delegate";
export type ConsentPolicy = "ask" | "session" | "always" | "deny";

export interface Peer {
	agent: PeerAgent;
	sessionId: string;
	pid?: number;
	instanceId?: string;
}

export interface Envelope<T extends MsgType = MsgType, B = unknown> {
	v: 1;
	id: string;
	type: T;
	replyTo?: string;
	from: Peer;
	to?: Peer;
	ts: number;
	ttlMs?: number;
	hop: number;
	body: B;
}

export interface ModelRef {
	provider: string;
	id: string;
}

export interface GitInfo {
	worktree: string;
	commonDir: string;
	branch?: string;
}

export interface HelloBody {
	token: string;
	clientNonce: string;
	protocol: number[];
}

export interface HelloResult {
	sessionId: string;
	instanceId: string;
	agentVersion: string;
	extensionVersion: string;
	protocol: 1;
	capabilities: Capability[];
	model?: ModelRef;
	status: AgentStatus;
	serverNonce: string;
}

export interface StatusBody { }

export interface StatusPolicy {
	projectAllowed: boolean;
	consultConsent: ConsentPolicy;
}

export interface StatusResult extends Omit<HelloResult, "serverNonce" | "protocol"> {
	cwd: string;
	git?: GitInfo;
	pendingMessages: boolean;
	policy: StatusPolicy;
}

export interface ConsultAttachment {
	path: string;
	startLine?: number;
	endLine?: number;
	text: string;
}

export interface ConsultLimits {
	maxTokens?: number;
	replyMaxBytes?: number;
}

export interface ConsultBody {
	question: string;
	attachments?: ConsultAttachment[];
	limits?: ConsultLimits;
	stream?: boolean;
}

export interface ProgressBody {
	phase: "awaiting_consent" | "running" | "delta";
	delta?: string;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}

export interface ConsultResult {
	replyText: string;
	truncated: boolean;
	model: ModelRef;
	usage?: Usage;
	durationMs: number;
	capped: boolean;
}

/**
 * T12 opt-in chat: the caller's message becomes a real user turn in the OMP
 * transcript. `timeoutMs` bounds the consent dialog and the reply wait.
 */
export interface ChatBody {
	message: string;
	timeoutMs: number;
}

export interface ChatResult {
	replyText: string;
	truncated: boolean;
	model: ModelRef;
	usage?: Usage;
	durationMs: number;
}
