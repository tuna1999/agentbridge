/** Protocol and runtime limits. Spec: docs/plan/01-design-spec.md §9. */
export const MAX_FRAME_BYTES = 1_048_576;
export const HELLO_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const LIVENESS_HELLO_TIMEOUT_MS = 2_000;
export const HEARTBEAT_MS = 15_000;
export const DEDUPE_LRU = 256;
export const DEDUPE_TTL_MS = 600_000;
export const CLOCK_SKEW_MS = 300_000;
export const AUTH_FAIL_LIMIT_PER_MIN = 10;
export const LOCKOUT_MS = 30_000;
export const CONSULT_CONCURRENCY = 1;

/** Default `consult.maxQuestionBytes` from config (01 §6); callers may override. */
export const DEFAULT_MAX_QUESTION_BYTES = 32_768;
/** T12 chat body timeout ceiling (matches the MCP tool's 1800 s maximum). */
export const CHAT_TIMEOUT_MAX_MS = 1_800_000;
/** Per-file attachment cap from the path guard (01 §5.2): 256 KiB. */
export const MAX_ATTACHMENT_FILE_BYTES = 262_144;
