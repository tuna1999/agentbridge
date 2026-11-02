/** Protocol error codes and their retryability. Spec: docs/plan/01-design-spec.md §4.4. */

export interface ErrorDefinition {
	retryable: boolean;
}

const ERROR_DEFINITIONS = {
	bad_request: { retryable: false },
	unsupported_version: { retryable: false },
	unauthorized: { retryable: false },
	identity_mismatch: { retryable: false },
	expired: { retryable: false },
	duplicate: { retryable: false },
	too_large: { retryable: false },
	project_not_allowed: { retryable: false },
	denied: { retryable: false },
	consent_timeout: { retryable: true },
	busy: { retryable: true },
	busy_limit: { retryable: true },
	chat_disabled: { retryable: false },
	rate_limited: { retryable: true },
	unsupported_capability: { retryable: false },
	max_tokens_unsupported: { retryable: false },
	model_changed: { retryable: true },
	provider_error: { retryable: true },
	cancelled: { retryable: false },
	target_exited: { retryable: true },
	no_target: { retryable: false },
	ambiguous_target: { retryable: false },
	target_not_found: { retryable: false },
	cross_project: { retryable: false },
	internal: { retryable: false },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === "string" && Object.hasOwn(ERROR_DEFINITIONS, value);
}

export function isRetryable(code: ErrorCode): boolean {
	return ERROR_DEFINITIONS[code].retryable;
}

export interface ErrorBody {
	code: ErrorCode;
	message: string;
	retryable: boolean;
	details?: Record<string, unknown>;
}

export class ProtocolError extends Error {
	readonly code: ErrorCode;
	readonly retryable: boolean;
	readonly details?: Record<string, unknown>;

	constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
		this.retryable = isRetryable(code);
		this.details = details;
	}

	toBody(): ErrorBody {
		const body: ErrorBody = { code: this.code, message: this.message, retryable: this.retryable };
		if (this.details !== undefined) body.details = this.details;
		return body;
	}
}
