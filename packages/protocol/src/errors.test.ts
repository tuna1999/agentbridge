import { expect, test } from "bun:test";
import { type ErrorCode, isErrorCode, isRetryable, ProtocolError } from "./index";

const EXPECTED: Record<ErrorCode, boolean> = {
	bad_request: false,
	unsupported_version: false,
	unauthorized: false,
	identity_mismatch: false,
	expired: false,
	duplicate: false,
	too_large: false,
	project_not_allowed: false,
	denied: false,
	consent_timeout: true,
	busy: true,
	busy_limit: true,
	chat_disabled: false,
	rate_limited: true,
	unsupported_capability: false,
	max_tokens_unsupported: false,
	model_changed: true,
	provider_error: true,
	cancelled: false,
	target_exited: true,
	no_target: false,
	ambiguous_target: false,
	target_not_found: false,
	cross_project: false,
	internal: false,
};

test("error-code retryability matches the protocol table", () => {
	for (const [code, retryable] of Object.entries(EXPECTED)) {
		expect(isRetryable(code as ErrorCode)).toBe(retryable);
	}
});

test("isErrorCode accepts known codes only", () => {
	expect(isErrorCode("consent_timeout")).toBe(true);
	expect(isErrorCode("denied")).toBe(true);
	expect(isErrorCode("not_a_code")).toBe(false);
	expect(isErrorCode(42)).toBe(false);
	expect(isErrorCode(null)).toBe(false);
});

test("ProtocolError derives retryable and serializes its body", () => {
	const withDetails = new ProtocolError("provider_error", "boom", { status: 500 });
	expect(withDetails.name).toBe("ProtocolError");
	expect(withDetails.code).toBe("provider_error");
	expect(withDetails.retryable).toBe(true);
	expect(withDetails.message).toBe("boom");
	expect(withDetails.toBody()).toEqual({
		code: "provider_error",
		message: "boom",
		retryable: true,
		details: { status: 500 },
	});

	const plain = new ProtocolError("denied", "no");
	expect(plain.details).toBeUndefined();
	expect(plain.toBody()).toEqual({ code: "denied", message: "no", retryable: false });
});
