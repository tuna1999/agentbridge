/** Result formatting for MCP tools and the CLI. Spec: 01 §8.3–8.4. */
import { type ChatResult, type ConsultResult, sanitizeLabel, sanitizeText, type StatusResult } from "@agentbridge/protocol";
import { type SessionView, sessionWorktree } from "./client";
import { MCP_MESSAGES } from "./messages";

/** Host-provided labels (names, paths, branches): one line, no escapes or invisible characters. */
function label(value: string, maxChars = 1_000): string {
	return sanitizeLabel(value, maxChars);
}

function escapeCell(value: string): string {
	return label(value, 300).replace(/\|/g, "\\|");
}

/** The session name, quoted so it can never end the header line or fake a new one. */
function quotedName(record: { sessionName?: string }): string {
	return JSON.stringify(label(record.sessionName ?? MCP_MESSAGES.unnamedSession, 120));
}

const REPLY_TAG = "OMP_REPLY";

/**
 * §8.4 reply frame. The reply is model output: when it contains the tag, a
 * numbered tag it does not contain is used instead, so it can never close the
 * frame early and add text outside the reference-data block.
 */
function replyFrame(replyText: string): string[] {
	const sanitized = sanitizeText(replyText);
	const body = sanitized.endsWith("\n") ? sanitized : `${sanitized}\n`;
	let tag = REPLY_TAG;
	for (let suffix = 1; body.includes(tag); suffix += 1) tag = `${REPLY_TAG}_${suffix}`;
	const lines: string[] = [];
	if (tag !== REPLY_TAG) lines.push(MCP_MESSAGES.replyTagChanged(tag));
	lines.push(`<<<${tag}`, `${body}${tag}>>>`);
	return lines;
}

function shortSessionId(sessionId: string): string {
	return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function modelLabel(model: { provider: string; id: string } | undefined): string {
	return model === undefined ? "-" : `${model.provider}/${model.id}`;
}

function formatNumber(value: number): string {
	const rounded = Math.trunc(value);
	return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function yesNo(value: boolean): string {
	return value ? "có" : "không";
}

export function sessionJson(view: SessionView): Record<string, unknown> {
	const { record } = view;
	const git = view.status?.git ?? record.git;
	return {
		sessionId: record.sessionId,
		name: record.sessionName ?? null,
		model: view.status?.model ?? record.model ?? null,
		status: view.status?.status ?? record.status,
		worktree: sessionWorktree(record),
		branch: git?.branch ?? null,
		liveness: view.liveness,
		capabilities: view.status?.capabilities ?? record.capabilities,
		consent: view.status?.policy.consultConsent ?? null,
	};
}

export function formatSessionTable(views: SessionView[]): string {
	if (views.length === 0) return `[AgentBridge] ${MCP_MESSAGES.emptyList}`;

	const sorted = [...views].sort((a, b) => b.record.startedAt - a.record.startedAt);
	const rows = sorted.map((view) => {
		const { record } = view;
		const git = view.status?.git ?? record.git;
		const cells = [
			record.sessionId,
			record.sessionName ?? "-",
			modelLabel(view.status?.model ?? record.model),
			view.status?.status ?? record.status,
			sessionWorktree(record),
			git?.branch ?? "-",
			view.liveness,
			(view.status?.capabilities ?? record.capabilities).join(", "),
			view.status?.policy.consultConsent ?? "-",
		];
		return `| ${cells.map(escapeCell).join(" | ")} |`;
	});

	return [
		`[AgentBridge] Phiên OMP (${sorted.length}):`,
		"| sessionId | name | model | status | worktree | branch | liveness | capabilities | consent |",
		"|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		MCP_MESSAGES.listHint,
	].join("\n");
}

export function formatStatus(view: SessionView, status: StatusResult): string {
	const { record } = view;
	const git = status.git ?? record.git;
	const lines = [
		`[AgentBridge] Trạng thái phiên OMP — ${shortSessionId(label(record.sessionId))} ${quotedName(record)}`,
		`- Session: ${label(status.sessionId)}`,
		`- Instance: ${label(status.instanceId)}`,
		`- Agent: omp ${label(status.agentVersion)} · extension ${label(status.extensionVersion)}`,
		`- Model: ${label(modelLabel(status.model ?? record.model))}`,
		`- Status: ${status.status}`,
		`- Liveness: ${view.liveness}`,
		`- CWD: ${label(status.cwd)}`,
		`- Worktree: ${label(git?.worktree ?? sessionWorktree(record))}`,
		`- Branch: ${label(git?.branch ?? "-")}`,
		`- Capabilities: ${status.capabilities.join(", ")}`,
		`- Project allowed: ${yesNo(status.policy.projectAllowed)}`,
		`- Consent: ${status.policy.consultConsent}`,
		`- Pending messages: ${yesNo(status.pendingMessages)}`,
	];
	return lines.join("\n");
}

export function formatConsultHeader(record: { sessionId: string; sessionName?: string }, result: ConsultResult): string {
	const seconds = (result.durationMs / 1000).toFixed(1);
	const parts = [
		`[AgentBridge] Phản hồi từ OMP — phiên ${shortSessionId(label(record.sessionId))} ${quotedName(record)}`,
		`model ${label(modelLabel(result.model))}`,
		`${seconds}s`,
	];
	if (result.usage?.output !== undefined) parts.push(`out ${formatNumber(result.usage.output)} tok`);
	if (result.truncated) parts.push("đã cắt theo replyMaxBytes");
	return parts.join(" · ");
}

/** Exact §8.4 framing: reference data, never instructions. */
export function formatConsultResult(record: { sessionId: string; sessionName?: string }, result: ConsultResult): string {
	return [
		formatConsultHeader(record, result),
		MCP_MESSAGES.referenceDataNote,
		MCP_MESSAGES.referenceDataAdvice,
		...replyFrame(result.replyText),
	].join("\n");
}

export function formatChatHeader(record: { sessionId: string; sessionName?: string }, result: ChatResult): string {
	const seconds = (result.durationMs / 1000).toFixed(1);
	const parts = [
		`[AgentBridge] OMP đã trả lời trong phiên chat — phiên ${shortSessionId(label(record.sessionId))} ${quotedName(record)}`,
		`model ${label(modelLabel(result.model))}`,
		`${seconds}s`,
	];
	if (result.usage?.output !== undefined) parts.push(`out ${formatNumber(result.usage.output)} tok`);
	if (result.truncated) parts.push("đã cắt theo replyMaxBytes");
	return parts.join(" · ");
}

/** Chat uses the same reference-data framing as consult (01 §8.4). */
export function formatChatResult(record: { sessionId: string; sessionName?: string }, result: ChatResult): string {
	return [
		formatChatHeader(record, result),
		MCP_MESSAGES.referenceDataNote,
		MCP_MESSAGES.referenceDataAdvice,
		...replyFrame(result.replyText),
	].join("\n");
}
