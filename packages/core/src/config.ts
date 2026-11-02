/** Config parsing, defaults, and mtime cache. Spec: 01 §6. */
import { readFile, realpath, stat } from "node:fs/promises";
import { type ConsentPolicy, isRecord, type PeerAgent } from "@agentbridge/protocol";
import { resolveDirs } from "./dirs";
import { CORE_MESSAGES } from "./messages";

export interface ConsultConfig {
	consent: ConsentPolicy;
	consentTimeoutMs: number;
	maxQuestionBytes: number;
	maxAttachmentBytes: number;
	maxContextBytes: number;
	replyMaxBytes: number;
	maxTokens: number;
	allowUncapped: boolean;
	ratePerMinute: number;
	toolsOff: boolean;
}

export interface AuditConfig {
	content: boolean;
	maxBytes: number;
}

/** T12b: where autochat may bypass the per-message consent dialog. */
export const AUTO_APPROVE_MODES = ["off", "limited", "unlimited"] as const;
export type AutoApproveMode = (typeof AUTO_APPROVE_MODES)[number];

/** Defaults for limited mode when the user omits the fields. */
export const AUTO_MAX_CHARS_DEFAULT = 2_000;
export const AUTO_MAX_MESSAGES_DEFAULT = 20;
export const AUTO_MIN_INTERVAL_MS_DEFAULT = 10_000;

/** Hard safety caps; values beyond are clamped at snapshot time. */
export const AUTO_MAX_CHARS_CAP = 8_000;
export const AUTO_MAX_MESSAGES_CAP = 50;
export const AUTO_MIN_INTERVAL_MS_FLOOR = 2_000;

/** T12 opt-in chat: off by default; autochat is opt-in and snapshot at start. */
export interface ChatConfig {
	enabled: boolean;
	queueWhenBusy: boolean;
	consentTimeoutMs: number;
	/** Snapshot only at main-TUI session_start; other chat fields reload per request. */
	autoApprove: AutoApproveMode;
	/** Limited mode: maximum code points in one message that may be auto-approved. */
	autoMaxChars: number;
	/** Limited mode: maximum auto-approved messages per OMP session. */
	autoMaxMessages: number;
	/** Limited mode: minimum spacing between auto-approved messages. */
	autoMinIntervalMs: number;
}

/** Display-only consult widget on the OMP TUI; never written to the session. */
export interface UiConfig {
	liveWidget: boolean;
	widgetLines: number;
	widgetHoldMs: number;
}

/**
 * OMP 18.14.0 shows at most 10 widget lines (`MAX_WIDGET_LINES`). The fixed
 * layout spends 1 line on the header, up to 2 on the question and 1 on the
 * divider, leaving at most 6 tail lines.
 */
export const WIDGET_LINES_MIN = 1;
export const WIDGET_LINES_MAX = 6;

export interface Config {
	version: 1;
	projects: string[];
	allowFrom: PeerAgent[];
	consult: ConsultConfig;
	chat: ChatConfig;
	audit: AuditConfig;
	ui: UiConfig;
}

function defaultConfig(): Config {
	return {
		version: 1,
		projects: [],
		allowFrom: ["claude-code"],
		consult: {
			consent: "ask",
			consentTimeoutMs: 60_000,
			maxQuestionBytes: 32_768,
			maxAttachmentBytes: 65_536,
			maxContextBytes: 1_048_576,
			replyMaxBytes: 32_768,
			maxTokens: 4_096,
			allowUncapped: false,
			ratePerMinute: 6,
			toolsOff: true,
		},
		chat: {
			enabled: false,
			queueWhenBusy: false,
			consentTimeoutMs: 120_000,
			autoApprove: "off",
			autoMaxChars: AUTO_MAX_CHARS_DEFAULT,
			autoMaxMessages: AUTO_MAX_MESSAGES_DEFAULT,
			autoMinIntervalMs: AUTO_MIN_INTERVAL_MS_DEFAULT,
		},
		audit: { content: false, maxBytes: 5_242_880 },
		ui: { liveWidget: true, widgetLines: 6, widgetHoldMs: 20_000 },
	};
}

export const DEFAULT_CONFIG: Config = defaultConfig();

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isConsentPolicy(value: unknown): value is ConsentPolicy {
	return value === "ask" || value === "session" || value === "always" || value === "deny";
}

function isAutoApproveMode(value: unknown): value is AutoApproveMode {
	return value === "off" || value === "limited" || value === "unlimited";
}

function isPeerAgent(value: unknown): value is PeerAgent {
	return value === "claude-code" || value === "omp";
}

function parseConfig(value: unknown): Config {
	if (!isRecord(value)) throw new Error("config must be an object");
	if (value.version !== undefined && value.version !== 1) throw new Error("unsupported config version");

	const config = defaultConfig();

	if (value.projects !== undefined) {
		if (!Array.isArray(value.projects) || !value.projects.every((p) => typeof p === "string" && p.length > 0)) {
			throw new Error("invalid projects");
		}
		config.projects = value.projects as string[];
	}

	if (value.allowFrom !== undefined) {
		if (!Array.isArray(value.allowFrom) || !value.allowFrom.every(isPeerAgent)) throw new Error("invalid allowFrom");
		config.allowFrom = value.allowFrom as PeerAgent[];
	}

	if (value.consult !== undefined) {
		if (!isRecord(value.consult)) throw new Error("invalid consult");
		const consult = value.consult;
		if (consult.consent !== undefined) {
			if (!isConsentPolicy(consult.consent)) throw new Error("invalid consent");
			config.consult.consent = consult.consent;
		}
		if (consult.consentTimeoutMs !== undefined) {
			if (!isPositiveInteger(consult.consentTimeoutMs)) throw new Error("invalid consentTimeoutMs");
			config.consult.consentTimeoutMs = consult.consentTimeoutMs;
		}
		if (consult.maxQuestionBytes !== undefined) {
			if (!isPositiveInteger(consult.maxQuestionBytes)) throw new Error("invalid maxQuestionBytes");
			config.consult.maxQuestionBytes = consult.maxQuestionBytes;
		}
		if (consult.maxAttachmentBytes !== undefined) {
			if (!isPositiveInteger(consult.maxAttachmentBytes)) throw new Error("invalid maxAttachmentBytes");
			config.consult.maxAttachmentBytes = consult.maxAttachmentBytes;
		}
		if (consult.maxContextBytes !== undefined) {
			if (!isPositiveInteger(consult.maxContextBytes)) throw new Error("invalid maxContextBytes");
			config.consult.maxContextBytes = consult.maxContextBytes;
		}
		if (consult.replyMaxBytes !== undefined) {
			if (!isPositiveInteger(consult.replyMaxBytes)) throw new Error("invalid replyMaxBytes");
			config.consult.replyMaxBytes = consult.replyMaxBytes;
		}
		if (consult.maxTokens !== undefined) {
			if (!isNonNegativeInteger(consult.maxTokens)) throw new Error("invalid maxTokens");
			config.consult.maxTokens = consult.maxTokens;
		}
		if (consult.allowUncapped !== undefined) {
			if (typeof consult.allowUncapped !== "boolean") throw new Error("invalid allowUncapped");
			config.consult.allowUncapped = consult.allowUncapped;
		}
		if (consult.ratePerMinute !== undefined) {
			if (!isNonNegativeInteger(consult.ratePerMinute)) throw new Error("invalid ratePerMinute");
			config.consult.ratePerMinute = consult.ratePerMinute;
		}
		if (consult.toolsOff !== undefined) {
			if (typeof consult.toolsOff !== "boolean") throw new Error("invalid toolsOff");
			config.consult.toolsOff = consult.toolsOff;
		}
	}

	if (value.chat !== undefined) {
		if (!isRecord(value.chat)) throw new Error("invalid chat");
		const chat = value.chat;
		if (chat.enabled !== undefined) {
			if (typeof chat.enabled !== "boolean") throw new Error("invalid chat.enabled");
			config.chat.enabled = chat.enabled;
		}
		if (chat.queueWhenBusy !== undefined) {
			if (typeof chat.queueWhenBusy !== "boolean") throw new Error("invalid chat.queueWhenBusy");
			config.chat.queueWhenBusy = chat.queueWhenBusy;
		}
		if (chat.consentTimeoutMs !== undefined) {
			if (!isPositiveInteger(chat.consentTimeoutMs)) throw new Error("invalid chat.consentTimeoutMs");
			config.chat.consentTimeoutMs = chat.consentTimeoutMs;
		}
		if (chat.autoApprove !== undefined) {
			if (!isAutoApproveMode(chat.autoApprove)) throw new Error("invalid chat.autoApprove");
			config.chat.autoApprove = chat.autoApprove;
		}
		if (chat.autoMaxChars !== undefined) {
			if (!isPositiveInteger(chat.autoMaxChars)) throw new Error("invalid chat.autoMaxChars");
			config.chat.autoMaxChars = chat.autoMaxChars;
		}
		if (chat.autoMaxMessages !== undefined) {
			if (!isPositiveInteger(chat.autoMaxMessages)) throw new Error("invalid chat.autoMaxMessages");
			config.chat.autoMaxMessages = chat.autoMaxMessages;
		}
		if (chat.autoMinIntervalMs !== undefined) {
			if (!isNonNegativeInteger(chat.autoMinIntervalMs)) throw new Error("invalid chat.autoMinIntervalMs");
			config.chat.autoMinIntervalMs = chat.autoMinIntervalMs;
		}
	}

	if (value.audit !== undefined) {
		if (!isRecord(value.audit)) throw new Error("invalid audit");
		if (value.audit.content !== undefined) {
			if (typeof value.audit.content !== "boolean") throw new Error("invalid audit.content");
			config.audit.content = value.audit.content;
		}
		if (value.audit.maxBytes !== undefined) {
			if (!isPositiveInteger(value.audit.maxBytes)) throw new Error("invalid audit.maxBytes");
			config.audit.maxBytes = value.audit.maxBytes;
		}
	}

	if (value.ui !== undefined) {
		if (!isRecord(value.ui)) throw new Error("invalid ui");
		if (value.ui.liveWidget !== undefined) {
			if (typeof value.ui.liveWidget !== "boolean") throw new Error("invalid ui.liveWidget");
			config.ui.liveWidget = value.ui.liveWidget;
		}
		if (value.ui.widgetLines !== undefined) {
			if (
				!isPositiveInteger(value.ui.widgetLines) ||
				value.ui.widgetLines < WIDGET_LINES_MIN ||
				value.ui.widgetLines > WIDGET_LINES_MAX
			) {
				throw new Error("invalid ui.widgetLines");
			}
			config.ui.widgetLines = value.ui.widgetLines;
		}
		if (value.ui.widgetHoldMs !== undefined) {
			if (!isNonNegativeInteger(value.ui.widgetHoldMs)) throw new Error("invalid ui.widgetHoldMs");
			config.ui.widgetHoldMs = value.ui.widgetHoldMs;
		}
	}

	return config;
}

interface CacheEntry {
	path: string;
	mtimeMs: number;
	config: Config;
}

let cache: CacheEntry | undefined;
const warned = new Set<string>();

/** Resolve each project to its real path; silently drop and warn once for missing ones. */
async function resolveProjects(projects: string[], configPath: string): Promise<string[]> {
	const resolved: string[] = [];
	for (const project of projects) {
		try {
			resolved.push(await realpath(project));
		} catch {
			const key = `project:${configPath}:${project}`;
			if (!warned.has(key)) {
				warned.add(key);
				console.warn(CORE_MESSAGES.missingProject(project));
			}
		}
	}
	return resolved;
}

/**
 * Load config, falling back to safe defaults (projects: []) on any error.
 * `fresh` bypasses the mtime cache so a session-start snapshot sees the file
 * exactly as it is now, even if its mtime did not change detectably.
 */
export async function loadConfig(
	configPath?: string,
	options: { fresh?: boolean } = {},
): Promise<Config> {
	const path = configPath ?? resolveDirs().configFile;

	let mtimeMs: number;
	try {
		mtimeMs = (await stat(path)).mtimeMs;
	} catch {
		cache = undefined;
		return defaultConfig();
	}

	if (!options.fresh && cache !== undefined && cache.path === path && cache.mtimeMs === mtimeMs) {
		return cache.config;
	}

	let config: Config;
	try {
		config = parseConfig(JSON.parse(await readFile(path, "utf8")));
		config.projects = await resolveProjects(config.projects, path);
	} catch {
		config = defaultConfig();
		const key = `invalid:${path}:${mtimeMs}`;
		if (!warned.has(key)) {
			warned.add(key);
			console.warn(CORE_MESSAGES.invalidConfig(path));
		}
	}

	cache = { path, mtimeMs, config };
	return config;
}

export type StrictConfigRead =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "ok"; config: Config; raw: Record<string, unknown> };

/**
 * Strict variant of `loadConfig` for callers that must distinguish a missing
 * file from an invalid one (TUI config edits must never overwrite bad input).
 * Project paths are validated but not realpath-resolved, and unknown keys are
 * preserved in `raw`.
 */
export async function readConfigStrict(configPath?: string): Promise<StrictConfigRead> {
	const path = configPath ?? resolveDirs().configFile;

	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "invalid", reason: "config must be valid JSON" };
	}
	if (!isRecord(parsed)) return { kind: "invalid", reason: "config must be an object" };

	try {
		return { kind: "ok", config: parseConfig(parsed), raw: parsed };
	} catch (error) {
		return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
}
