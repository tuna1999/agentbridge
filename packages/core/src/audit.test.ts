import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, type AuditEvent, type AuditOptions, InsecureDirError } from "./index";

let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "ab-core-audit-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

function options(overrides: Partial<AuditOptions> = {}): AuditOptions {
	return { stateDir, maxBytes: 5_242_880, content: false, ...overrides };
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
	return {
		event: "consult",
		id: "request-1",
		from: { agent: "claude-code", sessionId: "session-from" },
		to: { sessionId: "session-to" },
		project: "/tmp/project",
		model: "openai/gpt",
		question: "hello",
		reply: "world",
		usage: { input: 1, output: 2 },
		durationMs: 10,
		outcome: "ok",
		...overrides,
	};
}

function logFile(): string {
	return join(stateDir, "audit.jsonl");
}

function readLines(): Record<string, unknown>[] {
	return readFileSync(logFile(), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("writes one 0600 line with metadata but no content by default", async () => {
	await appendAudit(event(), options());

	expect(statSync(logFile()).mode & 0o777).toBe(0o600);
	const [line] = readLines();
	expect(line).toBeDefined();
	expect(line?.event).toBe("consult");
	expect(line?.id).toBe("request-1");
	expect(line?.from).toEqual({ agent: "claude-code", sessionId: "session-from" });
	expect(line?.to).toEqual({ sessionId: "session-to" });
	expect(line?.project).toBe("/tmp/project");
	expect(line?.model).toBe("openai/gpt");
	expect(line?.questionBytes).toBe(5);
	expect(line?.questionSha256).toBe(createHash("sha256").update("hello").digest("hex"));
	expect(line?.replyBytes).toBe(5);
	expect(line?.usage).toEqual({ input: 1, output: 2 });
	expect(line?.durationMs).toBe(10);
	expect(line?.outcome).toBe("ok");
	expect("question" in (line ?? {})).toBe(false);
	expect("reply" in (line ?? {})).toBe(false);
});

test("redacts question and reply when content is enabled", async () => {
	await appendAudit(
		event({ question: 'password = "hunter2hunter2"', reply: `sk-${"a".repeat(24)}` }),
		options({ content: true }),
	);
	const [line] = readLines();
	expect(line?.question).toContain("[REDACTED:secret]");
	expect(line?.reply).toContain("[REDACTED:openai_key]");
	expect(line?.questionBytes).toBe(Buffer.byteLength('password = "hunter2hunter2"'));
});

test("records an explicit consent reason", async () => {
	await appendAudit(event({ consent: "auto-config-unlimited" }), options());
	expect(readLines().at(-1)?.consent).toBe("auto-config-unlimited");
});

test("omits optional fields and records error outcomes", async () => {
	await appendAudit(
		{ event: "denied", id: "request-2", from: { agent: "claude-code", sessionId: "s" }, outcome: "denied" },
		options(),
	);
	const [line] = readLines();
	expect(line?.event).toBe("denied");
	expect(line?.outcome).toBe("denied");
	expect("to" in (line ?? {})).toBe(false);
	expect("project" in (line ?? {})).toBe(false);
	expect("questionBytes" in (line ?? {})).toBe(false);
});

test("appends multiple lines", async () => {
	await appendAudit(event({ id: "a" }), options());
	await appendAudit(event({ id: "b" }), options());
	expect(readLines().map((line) => line.id)).toEqual(["a", "b"]);
});

test("rotates to .1 when the next line would exceed maxBytes", async () => {
	await appendAudit(event({ id: "first" }), options({ maxBytes: 1 }));
	await appendAudit(event({ id: "second" }), options({ maxBytes: 1 }));

	const rotated = readFileSync(`${logFile()}.1`, "utf8").trim().split("\n");
	expect(rotated.length).toBe(1);
	expect(JSON.parse(rotated[0] as string).id).toBe("first");
	expect(readLines().map((line) => line.id)).toEqual(["second"]);
	expect(statSync(`${logFile()}.1`).mode & 0o777).toBe(0o600);
	expect(statSync(logFile()).mode & 0o777).toBe(0o600);
});

test("refuses a group/other-accessible state directory", async () => {
	chmodSync(stateDir, 0o755);
	await expect(appendAudit(event(), options())).rejects.toThrow(InsecureDirError);
});
