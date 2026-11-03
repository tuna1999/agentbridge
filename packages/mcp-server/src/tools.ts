/** Tool handlers shared by the MCP server. Spec: 01 §8.3–8.4. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProtocolError, type ProgressBody } from "@agentbridge/protocol";
import { z } from "zod";
import {
	type CallerContext,
	chatSession,
	collectSessions,
	consultSession,
	filterByScope,
	type IncludeFileInput,
	MAX_INCLUDE_FILES,
	readIncludeFiles,
	resolveTarget,
	type Scope,
	statusOf,
} from "./client";
import { BridgeError, failureFrom, formatFailure } from "./errors";
import {
	formatChatResult,
	formatConsultResult,
	formatSessionTable,
	formatStatus,
} from "./format";
import { type BridgeIdentity, resolveIdentity } from "./identity";
import { MCP_MESSAGES, TOOL_DESCRIPTIONS } from "./messages";

export interface ToolDependencies {
	resolveIdentity?: () => Promise<BridgeIdentity | undefined>;
	now?: () => number;
}

export interface ProgressNotificationLike {
	method: "notifications/progress";
	params: {
		progressToken: string | number;
		progress: number;
		message?: string;
	};
}

export interface ConsultExtra {
	signal: AbortSignal;
	_meta?: { progressToken?: string | number };
	sendNotification?: (notification: ProgressNotificationLike) => Promise<void>;
}

export interface ListArgs {
	scope?: Scope;
}

export interface StatusArgs {
	target?: string;
}

export interface ConsultArgs {
	question: string;
	include_files?: IncludeFileInput[];
	target?: string;
	timeout_s?: number;
}

export interface ChatArgs {
	message: string;
	target?: string;
	timeout_s?: number;
}

function callerFromIdentity(identity: BridgeIdentity): CallerContext {
	const caller: CallerContext = {
		peer: { agent: "claude-code", sessionId: identity.sessionId, pid: identity.pid },
		root: identity.projectRoot,
		caseInsensitive: process.platform === "win32",
	};
	if (identity.git?.worktree !== undefined) caller.worktree = identity.git.worktree;
	if (identity.git?.commonDir !== undefined) caller.commonDir = identity.git.commonDir;
	return caller;
}

/**
 * Tool results are text-only by design: Claude Code prefers `structuredContent`
 * over `content[].text` when both are present, which silently hid the framed
 * reply (and the "DỮ LIỆU THAM KHẢO" warning) from the model. Text is the sole
 * contract; no tool declares `outputSchema`.
 */
function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): CallToolResult {
	const failure = failureFrom(error);
	return {
		isError: true,
		content: [{ type: "text", text: formatFailure(failure) }],
	};
}

function lastChars(text: string, count: number): string {
	const codepoints = Array.from(text);
	return codepoints.slice(-count).join("");
}

/** Only with a progressToken; at most one notification per second. */
export function createProgressReporter(
	extra: ConsultExtra,
	now: () => number = Date.now,
): ((progress: ProgressBody) => void) | undefined {
	const token = extra._meta?.progressToken;
	const send = extra.sendNotification;
	if (token === undefined || send === undefined) return undefined;

	let lastSentAt = Number.NEGATIVE_INFINITY;
	let counter = 0;
	let streamed = "";

	const emit = (message: string): void => {
		const at = now();
		if (at - lastSentAt < 1_000) return;
		lastSentAt = at;
		counter += 1;
		const notification: ProgressNotificationLike = {
			method: "notifications/progress",
			params: { progressToken: token, progress: counter, message },
		};
		void Promise.resolve(send(notification)).catch(() => {
			// Progress is advisory; a broken client must not abort a consult.
		});
	};

	return (progress: ProgressBody): void => {
		if (progress.phase === "awaiting_consent") {
			emit(MCP_MESSAGES.awaitingConsent);
			return;
		}
		if (progress.phase !== "delta" || progress.delta === undefined || progress.delta.length === 0) return;
		streamed += progress.delta;
		emit(lastChars(streamed, 80));
	};
}

export function createToolHandlers(deps: ToolDependencies = {}): {
	list(args: ListArgs): Promise<CallToolResult>;
	status(args: StatusArgs): Promise<CallToolResult>;
	consult(args: ConsultArgs, extra: ConsultExtra): Promise<CallToolResult>;
	chat(args: ChatArgs, extra: ConsultExtra): Promise<CallToolResult>;
} {
	const identityResolver = deps.resolveIdentity ?? resolveIdentity;
	const now = deps.now ?? Date.now;

	async function caller(): Promise<CallerContext> {
		const identity = await identityResolver();
		if (identity === undefined) {
			// Not `denied`: that code tells the model the user refused in OMP.
			throw new BridgeError("unsupported_caller", MCP_MESSAGES.unsupportedCaller, MCP_MESSAGES.unsupportedCallerHint);
		}
		return callerFromIdentity(identity);
	}

	return {
		async list(args: ListArgs): Promise<CallToolResult> {
			try {
				const context = await caller();
				const views = await collectSessions(context, { fetchStatus: true });
				const scoped = filterByScope(views, context, args.scope ?? "repo");
				return textResult(formatSessionTable(scoped));
			} catch (error) {
				return errorResult(error);
			}
		},

		async status(args: StatusArgs): Promise<CallToolResult> {
			try {
				const context = await caller();
				const views = await collectSessions(context);
				const selected = resolveTarget(context, views, args.target);
				const status = await statusOf(context, selected.record);
				return textResult(formatStatus(selected, status));
			} catch (error) {
				return errorResult(error);
			}
		},

		async consult(args: ConsultArgs, extra: ConsultExtra): Promise<CallToolResult> {
			try {
				if (extra.signal.aborted) {
					return errorResult(new ProtocolError("cancelled", "request aborted before start"));
				}
				const context = await caller();
				const views = await collectSessions(context);
				const selected = resolveTarget(context, views, args.target);
				const files = args.include_files ?? [];
				const attachments = await readIncludeFiles(context.root, files, context.caseInsensitive);
				const onProgress = createProgressReporter(extra, now);
				const result = await consultSession(context, selected.record, args.question, attachments, {
					timeoutMs: (args.timeout_s ?? 600) * 1_000,
					stream: true,
					signal: extra.signal,
					onProgress,
				});
				return textResult(formatConsultResult(selected.record, result));
			} catch (error) {
				return errorResult(error);
			}
		},

		async chat(args: ChatArgs, extra: ConsultExtra): Promise<CallToolResult> {
			try {
				if (extra.signal.aborted) {
					return errorResult(new ProtocolError("cancelled", "request aborted before start"));
				}
				const context = await caller();
				const views = await collectSessions(context);
				const selected = resolveTarget(context, views, args.target);
				const onProgress = createProgressReporter(extra, now);
				const result = await chatSession(context, selected.record, args.message, {
					timeoutMs: (args.timeout_s ?? 600) * 1_000,
					signal: extra.signal,
					onProgress,
				});
				return textResult(formatChatResult(selected.record, result));
			} catch (error) {
				return errorResult(error);
			}
		},
	};
}

function toIncludeFiles(
	files: Array<{ path: string; start_line?: number; end_line?: number }> | undefined,
): IncludeFileInput[] {
	if (files === undefined) return [];
	return files.map((file) => {
		const input: IncludeFileInput = { path: file.path };
		if (file.start_line !== undefined) input.startLine = file.start_line;
		if (file.end_line !== undefined) input.endLine = file.end_line;
		return input;
	});
}

export function registerTools(server: McpServer, deps: ToolDependencies = {}): void {
	const handlers = createToolHandlers(deps);

	server.registerTool(
		"agent_list",
		{
			description: TOOL_DESCRIPTIONS.list,
			inputSchema: {
				scope: z.enum(["worktree", "repo", "all"]).default("repo"),
			},
		},
		async (args) => handlers.list({ scope: args.scope ?? "repo" }),
	);

	server.registerTool(
		"agent_status",
		{
			description: TOOL_DESCRIPTIONS.status,
			inputSchema: {
				target: z.string().optional(),
			},
		},
		async (args) => handlers.status({ target: args.target }),
	);

	server.registerTool(
		"agent_consult",
		{
			description: TOOL_DESCRIPTIONS.consult,
			inputSchema: {
				question: z.string().min(1).describe(TOOL_DESCRIPTIONS.question),
				include_files: z
					.array(
						z.object({
							path: z.string().min(1),
							start_line: z.number().int().min(1).optional(),
							end_line: z.number().int().min(1).optional(),
						}),
					)
					.max(MAX_INCLUDE_FILES)
					.describe(TOOL_DESCRIPTIONS.includeFiles)
					.optional(),
				target: z.string().optional().describe(TOOL_DESCRIPTIONS.target),
				timeout_s: z.number().int().min(10).max(1800).default(600).describe(TOOL_DESCRIPTIONS.timeout),
			},
			_meta: { "anthropic/maxResultSizeChars": 100000 },
		},
		async (args, extra) =>
			handlers.consult(
				{
					question: args.question,
					include_files: toIncludeFiles(args.include_files),
					target: args.target,
					timeout_s: args.timeout_s ?? 600,
				},
				{
					signal: extra.signal,
					_meta: extra._meta,
					sendNotification: extra.sendNotification as unknown as ConsultExtra["sendNotification"],
				},
			),
	);

	server.registerTool(
		"agent_chat",
		{
			description: TOOL_DESCRIPTIONS.chat,
			inputSchema: {
				message: z.string().min(1).describe(TOOL_DESCRIPTIONS.chatMessage),
				target: z.string().optional().describe(TOOL_DESCRIPTIONS.target),
				timeout_s: z.number().int().min(10).max(1800).default(600).describe(TOOL_DESCRIPTIONS.timeout),
			},
			_meta: { "anthropic/maxResultSizeChars": 100000 },
		},
		async (args, extra) =>
			handlers.chat(
				{
					message: args.message,
					target: args.target,
					timeout_s: args.timeout_s ?? 600,
				},
				{
					signal: extra.signal,
					_meta: extra._meta,
					sendNotification: extra.sendNotification as unknown as ConsultExtra["sendNotification"],
				},
			),
	);
}
