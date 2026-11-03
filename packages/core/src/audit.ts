/** Append-only audit log with rotation. Spec: 01 §7.7. */
import { createHash } from "node:crypto";
import { appendFile, chmod, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ErrorCode, type PeerAgent, redact, sanitizeText, type Usage } from "@agentbridge/protocol";
import { ensureSecureDir } from "./dirs";

export type AuditEventName = "consult" | "chat" | "status" | "auth_fail" | "denied" | "error";

export interface AuditEvent {
	event: AuditEventName;
	id: string;
	from: { agent: PeerAgent; sessionId: string };
	to?: { sessionId: string };
	project?: string;
	model?: string;
	question?: string;
	reply?: string;
	usage?: Usage;
	durationMs?: number;
	outcome: "ok" | ErrorCode;
	/** T12b: "manual" or the autochat source (e.g. "auto-config-unlimited"). */
	consent?: string;
}

export interface AuditOptions {
	stateDir: string;
	maxBytes: number;
	content: boolean;
}

/** Append one JSON line to `stateDir/audit.jsonl` (0600), rotating to `.1` when full. */
export async function appendAudit(event: AuditEvent, options: AuditOptions): Promise<void> {
	await ensureSecureDir(options.stateDir);
	const record: Record<string, unknown> = {
		ts: Date.now(),
		event: event.event,
		id: event.id,
		from: event.from,
	};
	if (event.to !== undefined) record.to = event.to;
	if (event.project !== undefined) record.project = event.project;
	if (event.model !== undefined) record.model = event.model;
	if (event.question !== undefined) {
		record.questionBytes = Buffer.byteLength(event.question, "utf8");
		record.questionSha256 = createHash("sha256").update(event.question).digest("hex");
	}
	if (event.reply !== undefined) record.replyBytes = Buffer.byteLength(event.reply, "utf8");
	if (event.usage !== undefined) record.usage = event.usage;
	if (event.durationMs !== undefined) record.durationMs = event.durationMs;
	record.outcome = event.outcome;
	if (event.consent !== undefined) record.consent = event.consent;
	if (options.content) {
		if (event.question !== undefined) record.question = redact(sanitizeText(event.question)).text;
		if (event.reply !== undefined) record.reply = redact(sanitizeText(event.reply)).text;
	}

	const line = `${JSON.stringify(record)}\n`;
	const file = join(options.stateDir, "audit.jsonl");
	const rotated = `${file}.1`;

	let size = 0;
	try {
		size = (await stat(file)).size;
	} catch {
		// no log yet
	}

	if (size > 0 && size + Buffer.byteLength(line, "utf8") > options.maxBytes) {
		await rm(rotated, { force: true });
		try {
			await rename(file, rotated);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	await appendFile(file, line, { mode: 0o600 });
	await chmod(file, 0o600);
}
