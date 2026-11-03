/**
 * T12b autochat: session-local auto-approval state and the config-file safety
 * gate. The mode is snapshotted at main-TUI `session_start`; config edits do
 * not change it until the next OMP process. Limits are read from the current
 * config on every chat, so only `autoApprove` is frozen.
 *
 * OMP API sources:
 * - `registerFlag` / `getFlag`: extension-types.v18.14.0.ts.txt:1980-1993.
 * - Main TUI detection uses the existing `OmpLike.isRootTui` adapter.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
 AUTO_MAX_CHARS_CAP,
 AUTO_MAX_CHARS_DEFAULT,
 AUTO_MAX_MESSAGES_CAP,
 AUTO_MAX_MESSAGES_DEFAULT,
 AUTO_MIN_INTERVAL_MS_DEFAULT,
 AUTO_MIN_INTERVAL_MS_FLOOR,
 type AutoApproveMode,
 type ChatConfig,
 type Config,
} from "@agentbridge/core";
import { AUTOCHAT_TEXT } from "./messages";

/** Registered with OMP; value is `off`, `limited`, or `unlimited`. */
export const AUTOCHAT_FLAG = "agentbridge-autochat";

/** Shown whenever unlimited autochat is enabled, regardless of source. */
export const AUTO_UNLIMITED_WARNING = AUTOCHAT_TEXT.unlimitedWarning;

/** TUI limited duration ceiling. */
export const AUTOCHAT_LIMITED_MAX_MINUTES = 480;

/** Audit value when no autochat rule applied. */
export const MANUAL_CONSENT = "manual";

export type AutoApproveSource = "config" | "cli" | "tui";

/** A source-specific audit reason. Config values are exactly T12b's contract. */
export function autoConsentReason(mode: AutoApproveMode, source: AutoApproveSource): string {
 if (mode === "off") return MANUAL_CONSENT;
 const suffix = mode === "unlimited" ? "-unlimited" : "";
 return `auto-${source}${suffix}`;
}

export function isAutoApproveMode(value: unknown): value is AutoApproveMode {
 return value === "off" || value === "limited" || value === "unlimited";
}

export interface FlagAutoApprove {
 present: boolean;
 mode?: AutoApproveMode;
 invalid?: string;
}

/**
 * Interpret the registered string flag. `true`/`false` are accepted because
 * older hosts may coerce a valueless flag; an absent/empty string means the
 * flag was not supplied, so config remains the fallback.
 */
export function readAutoApproveFlag(value: boolean | string | undefined): FlagAutoApprove {
 if (value === undefined) return { present: false };
 if (value === true) return { present: true, mode: "unlimited" };
 if (value === false) return { present: true, mode: "off" };
 if (typeof value !== "string") return { present: true, invalid: String(value).slice(0, 80) };
 const normalized = value.trim().toLowerCase();
 if (normalized.length === 0) return { present: false };
 if (isAutoApproveMode(normalized)) return { present: true, mode: normalized };
 return { present: true, invalid: value.slice(0, 80) };
}

export function autoSourceLabel(source: AutoApproveSource): string {
 return AUTOCHAT_TEXT.source[source];
}

export interface AutoApproval {
 /** Audit reason: auto-config, auto-config-unlimited, auto-cli, ... */
 consent: string;
}

/** Limits frozen together with the autochat mode. */
export interface AutoChatLimits {
 maxChars: number;
 maxMessages: number;
 minIntervalMs: number;
}

export const DEFAULT_AUTO_CHAT_LIMITS: AutoChatLimits = {
 maxChars: AUTO_MAX_CHARS_DEFAULT,
 maxMessages: AUTO_MAX_MESSAGES_DEFAULT,
 minIntervalMs: AUTO_MIN_INTERVAL_MS_DEFAULT,
};

/**
 * Clamp configured limits to the hard safety caps. Out-of-range values never
 * invalidate the whole config; the caller warns once and keeps the clamped
 * snapshot. Autochat never re-reads these fields during the session.
 */
export function clampAutoChatLimits(
 chat: Pick<ChatConfig, "autoMaxChars" | "autoMaxMessages" | "autoMinIntervalMs">,
): { limits: AutoChatLimits; clamped: boolean } {
 const limits: AutoChatLimits = {
  maxChars: Math.min(Math.max(1, chat.autoMaxChars), AUTO_MAX_CHARS_CAP),
  maxMessages: Math.min(Math.max(1, chat.autoMaxMessages), AUTO_MAX_MESSAGES_CAP),
  minIntervalMs: Math.max(AUTO_MIN_INTERVAL_MS_FLOOR, chat.autoMinIntervalMs),
 };
 const clamped =
  limits.maxChars !== chat.autoMaxChars ||
  limits.maxMessages !== chat.autoMaxMessages ||
  limits.minIntervalMs !== chat.autoMinIntervalMs;
 return { limits, clamped };
}

export function autoLimitClampWarning(): string {
 return AUTOCHAT_TEXT.limitClamped(AUTO_MAX_CHARS_CAP, AUTO_MAX_MESSAGES_CAP, AUTO_MIN_INTERVAL_MS_FLOOR);
}

export function autoSentMessage(used: number, quota: number | undefined): string {
 return AUTOCHAT_TEXT.sent(used, quota);
}

/** Count Unicode code points without allocating an array. */
export function charCount(text: string): number {
 let count = 0;
 for (const _ of text) count += 1;
 return count;
}

/**
 * One per OMP process. Mode and limits are snapshotted together; only the
 * explicit TUI `autochat limited` command resets the quota. Switching mode
 * from config/CLI or via TUI off/unlimited preserves the used count.
 */
export class AutoChatSession {
 #mode: AutoApproveMode = "off";
 #source: AutoApproveSource = "config";
 #limits: AutoChatLimits = { ...DEFAULT_AUTO_CHAT_LIMITS };
 #used = 0;
 #lastApprovedAt: number | undefined;

 get mode(): AutoApproveMode {
  return this.#mode;
 }

 get source(): AutoApproveSource {
  return this.#source;
 }

 get limits(): AutoChatLimits {
  return { ...this.#limits };
 }

 get used(): number {
  return this.#used;
 }

 /** Backwards-compatible alias for the auto-approved message count. */
 get autoMessages(): number {
  return this.#used;
 }

 get quota(): number | undefined {
  return this.#mode === "limited" ? this.#limits.maxMessages : undefined;
 }

 get lastApprovedAt(): number | undefined {
  return this.#lastApprovedAt;
 }

 configure(
  mode: AutoApproveMode,
  source: AutoApproveSource,
  options: { limits?: AutoChatLimits; resetQuota?: boolean } = {},
 ): void {
  this.#mode = mode;
  this.#source = source;
  if (options.limits !== undefined) this.#limits = { ...options.limits };
  if (options.resetQuota === true) {
   this.#used = 0;
   this.#lastApprovedAt = undefined;
  }
 }

 reset(): void {
  this.#mode = "off";
  this.#source = "config";
  this.#limits = { ...DEFAULT_AUTO_CHAT_LIMITS };
  this.#used = 0;
  this.#lastApprovedAt = undefined;
 }

 /**
  * Return an auto-approval when the current mode allows this message.
  * `undefined` means the caller must use the normal manual consent dialog
  * (including when limited-mode limits are exhausted or exceeded).
  *
  * `configOrNow` is accepted for compatibility with the previous API but is
  * deliberately ignored: limits must come from the snapshot.
  */
 decide(
  message: string,
  configOrNow?: Config | number,
  now = Date.now(),
 ): AutoApproval | undefined {
  const at = typeof configOrNow === "number" ? configOrNow : now;
  if (this.#mode === "off") return undefined;
  if (this.#mode === "limited") {
   if (charCount(message) > this.#limits.maxChars) return undefined;
   if (this.#used >= this.#limits.maxMessages) return undefined;
   if (
    this.#lastApprovedAt !== undefined &&
    at - this.#lastApprovedAt < this.#limits.minIntervalMs
   ) {
    return undefined;
   }
  }
  this.#used += 1;
  this.#lastApprovedAt = at;
  return { consent: autoConsentReason(this.#mode, this.#source) };
 }
}

/** True when `child` is `parent` or lives under it (both absolute, real paths). */
export function isPathInside(child: string, parent: string): boolean {
 const rel = relative(parent, child);
 return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export type AutoConfigInspection =
 | { kind: "off" }
 | { kind: "enabled"; mode: "limited" | "unlimited"; path: string }
 | { kind: "warning"; reason: "inside-project" | "insecure"; path: string };

export function autoConfigWarningMessage(
 reason: "inside-project" | "insecure",
 path: string,
): string {
 return reason === "inside-project" ? AUTOCHAT_TEXT.configInsideProject(path) : AUTOCHAT_TEXT.configInsecure(path);
}

export function autoConfigEnabledMessage(
 mode: "limited" | "unlimited",
 path: string,
): string {
 return AUTOCHAT_TEXT.enabledFromConfig(mode, path);
}

/**
 * Validate a config-sourced autochat mode. Reject when the real config file is
 * inside any allowlisted project or this session's cwd/worktree, or when the
 * file is not 0600 and owned by the current uid. Any check that cannot be
 * completed fails closed.
 */
export async function inspectConfigAutoApprove(options: {
 config: Config;
 configPath: string;
 cwd: string;
 worktree?: string;
}): Promise<AutoConfigInspection> {
 const mode = options.config.chat.autoApprove;
 if (mode === "off") return { kind: "off" };

 let real: string;
 try {
  real = await realpath(options.configPath);
 } catch {
  return { kind: "warning", reason: "insecure", path: options.configPath };
 }

 const roots = [options.cwd, options.worktree].filter(
  (value): value is string => typeof value === "string" && value.length > 0,
 );
 const insideProject = options.config.projects.some((project) => isPathInside(real, project));
 const insideSession = roots.some((root) => isPathInside(real, root));
 if (insideProject || insideSession) {
  return { kind: "warning", reason: "inside-project", path: real };
 }

 try {
  const info = await stat(real);
  const uid = process.getuid?.();
  if (
   !info.isFile() ||
   (info.mode & 0o777) !== 0o600 ||
   uid === undefined ||
   info.uid !== uid
  ) {
   return { kind: "warning", reason: "insecure", path: real };
  }
 } catch {
  return { kind: "warning", reason: "insecure", path: real };
 }

 return { kind: "enabled", mode, path: real };
}

/** Append the autochat state to the status-bar text without changing off-mode text. */
export function bridgeStatusText(
 base: string,
 state: { mode: AutoApproveMode; used: number; quota: number | undefined },
 chatEnabled: boolean,
): string {
 if (!chatEnabled || state.mode === "off") return base;
 if (state.mode === "limited") {
  return AUTOCHAT_TEXT.statusLimited(base, state.used, state.quota ?? 0);
 }
 return AUTOCHAT_TEXT.statusUnlimited(base, state.used);
}
