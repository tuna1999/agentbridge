/** Shared client logic for MCP tools and the `ab` CLI. Spec: 01 §8.2–8.5. */
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
	checkLiveness,
	hello,
	type Liveness,
	listRecords,
	readToken,
	request,
	type RequestOptions,
	type SessionRecord,
} from "@agentbridge/core";
import {
	type ChatBody,
	type ChatResult,
	type ConsultAttachment,
	type ConsultBody,
	type ConsultResult,
	LIVENESS_HELLO_TIMEOUT_MS,
	MAX_CONSULT_ATTACHMENTS,
	type MatchSummary,
	PathGuardError,
	type Peer,
	type ProgressBody,
	ProtocolError,
	redact,
	REQUEST_TIMEOUT_MS,
	resolveInside,
	selectTarget,
	type StatusResult,
} from "@agentbridge/protocol";
import { BridgeError, type TargetOption } from "./errors";
import { MCP_MESSAGES } from "./messages";

export const MAX_INCLUDE_FILES = MAX_CONSULT_ATTACHMENTS;
export const MAX_INCLUDE_BYTES = 65_536;
/** Per-file guard checked before reading; a 2 MiB sparse file must never be loaded. */
export const MAX_INCLUDE_FILE_BYTES = 1_048_576;

export type Scope = "worktree" | "repo" | "all";

export interface CallerContext {
	peer: Peer;
	/** Project root used for include_files and as the no-git fallback. */
	root: string;
	worktree?: string;
	commonDir?: string;
	caseInsensitive: boolean;
}

export interface SessionView {
	record: SessionRecord;
	liveness: Liveness;
	status?: StatusResult;
}

export interface IncludeFileInput {
	path: string;
	startLine?: number;
	endLine?: number;
}

export interface ConsultOptions {
	timeoutMs: number;
	stream: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: ProgressBody) => void;
}

export interface ChatOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?: (progress: ProgressBody) => void;
}

export interface CollectOptions {
	/** `agent_list` needs the consent policy, which only `status` exposes. */
	fetchStatus?: boolean;
}

function normalizePath(path: string, caseInsensitive: boolean): string {
	const stripped = path.replace(/[\\/]+$/, "");
	const rooted = stripped.length === 0 ? "/" : stripped;
	return caseInsensitive ? rooted.replace(/\\/g, "/").toLowerCase() : rooted;
}

function samePath(a: string | undefined, b: string | undefined, caseInsensitive: boolean): boolean {
	return a !== undefined && b !== undefined && normalizePath(a, caseInsensitive) === normalizePath(b, caseInsensitive);
}

export function sessionWorktree(record: SessionRecord): string {
	return record.git?.worktree ?? record.cwd;
}

/** Stable view for callers: same shape whether or not the session answered status. */
export function matchCandidates(views: SessionView[]): Array<SessionRecord & { liveness: "alive" | "unresponsive" }> {
	const candidates: Array<SessionRecord & { liveness: "alive" | "unresponsive" }> = [];
	for (const view of views) {
		if (view.liveness === "dead") continue;
		candidates.push({ ...view.record, liveness: view.liveness });
	}
	return candidates;
}

function enrichOptions(summaries: MatchSummary[], views: SessionView[]): TargetOption[] {
	return summaries.map((summary) => {
		const record = views.find((view) => view.record.sessionId === summary.sessionId)?.record;
		const option: TargetOption = { ...summary };
		if (record !== undefined) {
			option.worktree = sessionWorktree(record);
			if (record.git?.branch !== undefined) option.branch = record.git.branch;
		}
		return option;
	});
}

/** Re-read the registry and probe every session; dead sessions never reach matching. */
export async function collectSessions(caller: CallerContext, options: CollectOptions = {}): Promise<SessionView[]> {
	const records = await listRecords();
	const views = await Promise.all(
		records.map(async (record): Promise<SessionView> => {
			const liveness = await checkLiveness(record, async () => {
				const token = await readToken(record);
				return hello(record.endpoint, token, LIVENESS_HELLO_TIMEOUT_MS);
			});
			return { record, liveness };
		}),
	);

	if (options.fetchStatus === true) {
		await Promise.all(
			views.map(async (view) => {
				if (view.liveness !== "alive") return;
				try {
					view.status = await statusOf(caller, view.record);
				} catch {
					// Consent is advisory for listing; liveness came from a separate hello.
				}
			}),
		);
	}

	return views;
}

export function filterByScope(views: SessionView[], caller: CallerContext, scope: Scope): SessionView[] {
	if (scope === "all") return views;
	const callerWorktree = caller.worktree ?? caller.root;
	return views.filter((view) => {
		const record = view.record;
		if (scope === "worktree") return samePath(sessionWorktree(record), callerWorktree, caller.caseInsensitive);
		const sameWorktree = samePath(sessionWorktree(record), callerWorktree, caller.caseInsensitive);
		if (sameWorktree) return true;
		if (caller.commonDir !== undefined) {
			return samePath(record.git?.commonDir, caller.commonDir, caller.caseInsensitive);
		}
		return samePath(record.cwd, caller.root, caller.caseInsensitive);
	});
}

/** Apply §8.2 without ever preferring the newest session. */
export function resolveTarget(caller: CallerContext, views: SessionView[], target?: string): SessionView {
	const result = selectTarget({
		callerWorktree: caller.worktree,
		callerCommonDir: caller.commonDir,
		callerRoot: caller.root,
		candidates: matchCandidates(views),
		target,
		allowCrossProject: false,
		caseInsensitive: caller.caseInsensitive,
	});

	if (result.kind === "selected") {
		const view = views.find(
			(candidate) =>
				candidate.record.sessionId === result.rec.sessionId &&
				candidate.record.instanceId === result.rec.instanceId,
		);
		if (view === undefined) {
			throw new BridgeError("internal", MCP_MESSAGES.internal, MCP_MESSAGES.internalHint, undefined, "selected record vanished");
		}
		return view;
	}

	const options = enrichOptions(result.options, views);
	switch (result.code) {
		case "no_target":
			throw new BridgeError(
				"no_target",
				options.length > 0 ? MCP_MESSAGES.noTargetWithOptions : MCP_MESSAGES.noTarget,
				options.length > 0
					? MCP_MESSAGES.noTargetWithOptionsHint
					: MCP_MESSAGES.noTargetHint,
				options,
			);
		case "ambiguous_target":
			throw new BridgeError(
				"ambiguous_target",
				MCP_MESSAGES.ambiguousTarget,
				MCP_MESSAGES.ambiguousTargetHint,
				options,
			);
		case "cross_project":
			throw new BridgeError(
				"cross_project",
				MCP_MESSAGES.crossProject,
				MCP_MESSAGES.crossProjectHint,
				options,
			);
		case "target_not_found": {
			const unresponsive = options.some((option) => option.liveness === "unresponsive");
			throw new BridgeError(
				"target_not_found",
				unresponsive ? MCP_MESSAGES.targetUnresponsive : MCP_MESSAGES.targetNotFound,
				unresponsive
					? MCP_MESSAGES.targetUnresponsiveHint
					: MCP_MESSAGES.targetNotFoundHint,
				options,
			);
		}
	}
}

async function tokenFor(record: SessionRecord): Promise<string> {
	try {
		return await readToken(record);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new BridgeError(
			"identity",
			MCP_MESSAGES.tokenUnreadable,
			MCP_MESSAGES.tokenUnreadableHint,
			undefined,
			detail,
		);
	}
}

function targetPeer(record: SessionRecord): Peer {
	return { agent: "omp", sessionId: record.sessionId, instanceId: record.instanceId };
}

export async function statusOf(caller: CallerContext, record: SessionRecord): Promise<StatusResult> {
	const token = await tokenFor(record);
	const requestOptions: RequestOptions = {
		endpoint: record.endpoint,
		token,
		from: caller.peer,
		to: targetPeer(record),
		type: "status",
		body: {},
		timeoutMs: REQUEST_TIMEOUT_MS,
	};
	const { result } = await request(requestOptions);
	return result as StatusResult;
}

export async function consultSession(
	caller: CallerContext,
	record: SessionRecord,
	question: string,
	attachments: ConsultAttachment[],
	options: ConsultOptions,
): Promise<ConsultResult> {
	const token = await tokenFor(record);
	// §5.1: question and attachments are redacted by the caller before sending.
	const body: ConsultBody = { question: redact(question).text, stream: options.stream };
	if (attachments.length > 0) body.attachments = attachments;

	const requestOptions: RequestOptions = {
		endpoint: record.endpoint,
		token,
		from: caller.peer,
		to: targetPeer(record),
		type: "consult",
		body,
		timeoutMs: options.timeoutMs,
	};
	if (options.signal !== undefined) requestOptions.signal = options.signal;
	if (options.onProgress !== undefined) requestOptions.onProgress = options.onProgress;

	const { result } = await request(requestOptions);
	return result as ConsultResult;
}

/**
 * T12: send a message into the OMP transcript. The host still asks the user
 * for consent; the caller timeout covers consent + the reply wait. The extra
 * 5 s lets the host's own timeout error reach the caller before the transport
 * times out. The message is redacted here as well as on the host.
 */
export async function chatSession(
	caller: CallerContext,
	record: SessionRecord,
	message: string,
	options: ChatOptions,
): Promise<ChatResult> {
	const token = await tokenFor(record);
	const body: ChatBody = {
		message: redact(message).text,
		timeoutMs: options.timeoutMs,
	};

	const requestOptions: RequestOptions = {
		endpoint: record.endpoint,
		token,
		from: caller.peer,
		to: targetPeer(record),
		type: "chat",
		body,
		timeoutMs: options.timeoutMs + 5_000,
	};
	if (options.signal !== undefined) requestOptions.signal = options.signal;
	if (options.onProgress !== undefined) requestOptions.onProgress = options.onProgress;

	try {
		const { result } = await request(requestOptions);
		return result as ChatResult;
	} catch (error) {
		// A transport-level timeout is also a chat timeout; distinguish it from
		// the consult timeout so the model gets the "do not resend" warning.
		if (error instanceof ProtocolError && error.code === "target_exited" && error.details?.reason === "timeout") {
			throw new ProtocolError("target_exited", error.message, {
				...(error.details ?? {}),
				reason: "chat_timeout",
			});
		}
		throw error;
	}
}

interface SlicedText {
	text: string;
	startLine?: number;
	endLine?: number;
}

function sliceLines(text: string, path: string, startLine?: number, endLine?: number): SlicedText {
	if (startLine === undefined && endLine === undefined) return { text };
	const lines = text.split(/\r?\n/);
	const first = startLine ?? 1;
	const last = endLine ?? lines.length;
	if (first < 1 || last < 1 || last < first) {
		throw new BridgeError(
			"bad_lines",
			MCP_MESSAGES.badLines,
			MCP_MESSAGES.badLinesHint,
			undefined,
			`${path}: start_line=${first}, end_line=${last}`,
		);
	}
	if (first > lines.length) {
		throw new BridgeError(
			"bad_lines",
			MCP_MESSAGES.badLines,
			MCP_MESSAGES.badLinesHint,
			undefined,
			MCP_MESSAGES.badLinesBeyondEnd(path, first, lines.length),
		);
	}
	const effectiveEnd = Math.min(last, lines.length);
	return {
		text: lines.slice(first - 1, effectiveEnd).join("\n"),
		startLine: first,
		endLine: effectiveEnd,
	};
}

/**
 * The name an include travels under: the real file the path guard accepted,
 * relative to the real root. Never the caller's raw string, whose `missing/../`
 * segments could smuggle text into the OMP prompt (01 §5.3).
 */
function includeLabel(rootReal: string, resolved: string): string {
	return relative(rootReal, resolved).split(sep).join("/");
}

/** Read, slice, redact, and cap include_files. Spec: 01 §8.3 step 2 and §5.2. */
export async function readIncludeFiles(
	root: string,
	files: IncludeFileInput[],
	caseInsensitive: boolean,
): Promise<ConsultAttachment[]> {
	if (files.length === 0) return [];
	if (files.length > MAX_INCLUDE_FILES) {
		throw new BridgeError(
			"bad_request",
			MCP_MESSAGES.tooManyIncludes(MAX_INCLUDE_FILES),
			MCP_MESSAGES.tooManyIncludesHint,
		);
	}

	const attachments: ConsultAttachment[] = [];
	let totalBytes = 0;
	let rootReal: string | undefined;
	for (const file of files) {
		const resolved = resolveInside(root, file.path, { caseInsensitive });
		if (resolved instanceof Error) {
			// The path guard rejects files above its own 256 KiB cap before reading; surface
			// that as the include limit so callers see one stable error code.
			if (resolved instanceof PathGuardError && resolved.reason === "too_large") {
				throw new BridgeError(
					"include_too_large",
					MCP_MESSAGES.includeFileTooLarge,
					MCP_MESSAGES.includeFileTooLargeHint,
					undefined,
					`${file.path}: ${resolved.message}`,
				);
			}
			throw new BridgeError("path_blocked", resolved.message, MCP_MESSAGES.pathBlockedHint, undefined, file.path);
		}

		let size: number;
		try {
			// The path guard currently caps files at 256 KiB; this explicit 1 MiB guard
			// belongs to the MCP layer so a future guard change can never load a huge file.
			size = (await stat(resolved)).size;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new BridgeError(
				"path_blocked",
				MCP_MESSAGES.includeUnreadable,
				MCP_MESSAGES.pathBlockedHint,
				undefined,
				`${file.path}: ${detail}`,
			);
		}
		if (size > MAX_INCLUDE_FILE_BYTES) {
			throw new BridgeError(
				"include_too_large",
				MCP_MESSAGES.includeFileTooLarge,
				MCP_MESSAGES.includeFileTooLargeHint,
				undefined,
				`${file.path}: ${size} byte`,
			);
		}

		let content: string;
		try {
			content = await readFile(resolved, "utf8");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new BridgeError(
				"path_blocked",
				MCP_MESSAGES.includeUnreadable,
				MCP_MESSAGES.pathBlockedHint,
				undefined,
				`${file.path}: ${detail}`,
			);
		}

		const sliced = sliceLines(content, file.path, file.startLine, file.endLine);
		const redacted = redact(sliced.text).text;
		totalBytes += Buffer.byteLength(redacted, "utf8");
		if (totalBytes > MAX_INCLUDE_BYTES) {
			throw new BridgeError(
				"include_too_large",
				MCP_MESSAGES.includeTooLarge,
				MCP_MESSAGES.includeTooLargeHint,
				undefined,
				`${totalBytes} byte`,
			);
		}

		// resolveInside has just realpath'd the same root.
		rootReal ??= await realpath(root);
		const attachment: ConsultAttachment = { path: includeLabel(rootReal, resolved), text: redacted };
		if (sliced.startLine !== undefined) attachment.startLine = sliced.startLine;
		if (sliced.endLine !== undefined) attachment.endLine = sliced.endLine;
		attachments.push(attachment);
	}
	return attachments;
}

/** Convenience for the CLI and tests: one-shot target selection + consult. */
export async function consultTarget(
	caller: CallerContext,
	views: SessionView[],
	target: string | undefined,
	question: string,
	attachments: ConsultAttachment[],
	options: ConsultOptions,
): Promise<{ record: SessionRecord; result: ConsultResult }> {
	const view = resolveTarget(caller, views, target);
	const result = await consultSession(caller, view.record, question, attachments, options);
	return { record: view.record, result };
}

/** Convenience for the CLI and tests: one-shot target selection + chat. */
export async function chatTarget(
	caller: CallerContext,
	views: SessionView[],
	target: string | undefined,
	message: string,
	options: ChatOptions,
): Promise<{ record: SessionRecord; result: ChatResult }> {
	const view = resolveTarget(caller, views, target);
	const result = await chatSession(caller, view.record, message, options);
	return { record: view.record, result };
}
