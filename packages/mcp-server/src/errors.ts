/** Tool failures, Vietnamese mapping, and option tables for the model. */
import { isErrorCode, isRetryable, type MatchSummary, ProtocolError, sanitizeLabel } from "@agentbridge/protocol";
import { ERROR_TEXT, MCP_MESSAGES } from "./messages";

export interface TargetOption extends MatchSummary {
	worktree?: string;
	branch?: string;
}

export interface Failure {
	code: string;
	message: string;
	hint: string;
	detail?: string;
	options?: TargetOption[];
}

/** Local (non-protocol) failures raised before or around the IPC request. */
export type LocalFailureCode = "path_blocked" | "include_too_large" | "bad_lines" | "identity";

export class BridgeError extends Error {
	readonly code: string;
	readonly hint: string;
	readonly options?: TargetOption[];
	readonly detail?: string;

	constructor(code: string, message: string, hint: string, options?: TargetOption[], detail?: string) {
		super(message);
		this.name = "BridgeError";
		this.code = code;
		this.hint = hint;
		if (options !== undefined) this.options = options;
		if (detail !== undefined) this.detail = detail;
	}
}

const RETRYABLE_NOTE =
	"Lưu ý: lỗi này được đánh dấu retryable ở giao thức, nhưng AgentBridge KHÔNG tự động thử lại vì mỗi lần chạy là một lần suy luận mới.";

function escapeCell(value: string): string {
	return sanitizeLabel(value, 300).replace(/\|/g, "\\|");
}

function formatOptions(options: TargetOption[]): string {
	if (options.length === 0) return "";
	const rows = options.map((option) => {
		const cells = [
			option.sessionId,
			option.sessionName ?? "-",
			option.status,
			option.liveness,
			option.worktree ?? "-",
			option.branch ?? "-",
		];
		return `| ${cells.map(escapeCell).join(" | ")} |`;
	});
	return [
		"",
		MCP_MESSAGES.optionsHeader,
		"| sessionId | name | status | liveness | worktree | branch |",
		"|---|---|---|---|---|---|",
		...rows,
	].join("\n");
}

/** Build a failure from anything a tool handler or client can throw. */
export function failureFrom(error: unknown): Failure {
	if (error instanceof BridgeError) {
		const failure: Failure = { code: error.code, message: error.message, hint: error.hint };
		if (error.detail !== undefined) failure.detail = error.detail;
		if (error.options !== undefined) failure.options = error.options;
		return failure;
	}

	if (error instanceof ProtocolError) {
		const timeoutReason = error.code === "target_exited" ? error.details?.reason : undefined;
		const mapped =
			timeoutReason === "chat_timeout"
				? { message: MCP_MESSAGES.chatTimeout, hint: MCP_MESSAGES.chatTimeoutHint }
				: timeoutReason === "timeout"
					? { message: MCP_MESSAGES.consultTimeout, hint: MCP_MESSAGES.consultTimeoutHint }
					: (ERROR_TEXT[error.code] ?? {
						message: MCP_MESSAGES.internal,
						hint: MCP_MESSAGES.internalHint,
					});
		const failure: Failure = {
			code: error.code,
			message: mapped.message,
			hint: mapped.hint,
			detail: error.message,
		};
		return failure;
	}

	const detail = error instanceof Error ? error.message : String(error);
	return { code: "internal", message: MCP_MESSAGES.internal, hint: MCP_MESSAGES.internalHint, detail };
}

export function formatFailure(failure: Failure): string {
	const lines = [`[AgentBridge] ${failure.code} — ${failure.message}`, `Gợi ý: ${failure.hint}`];
	// Details can carry host or model text: one sanitized line.
	const detail = failure.detail === undefined ? "" : sanitizeLabel(failure.detail, 1_000);
	if (detail.length > 0) lines.push(`Chi tiết: ${detail}`);
	if (isErrorCode(failure.code) && isRetryable(failure.code)) lines.push(RETRYABLE_NOTE);
	if (failure.options !== undefined) {
		const options = formatOptions(failure.options);
		if (options.length > 0) lines.push(options);
	}
	return lines.join("\n");
}
