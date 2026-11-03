/**
 * Consult handling for the OMP extension. Spec: 01 §7.4 (14 steps, in order),
 * §7.5 (prompt), §7.7 (audit), §6 (config). The transport already validates
 * envelopes, identity, clock skew and request ids; this module owns policy,
 * consent, rate/concurrency limits and the ephemeral turn.
 */
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
 CONSULT_CONCURRENCY,
 type ConsultAttachment,
 type ConsultBody,
 type ConsultResult,
 DEDUPE_LRU,
 DEDUPE_TTL_MS,
 type ErrorCode,
 type ModelRef,
 type Peer,
 type ProgressBody,
 ProtocolError,
 type Usage,
 redact,
 sanitizeLabel,
 sanitizeText,
} from "@agentbridge/protocol";
import {
 type AuditEvent,
 type AuditEventName,
 appendAudit,
 type Config,
 loadConfig,
 resolveDirs,
 type UiConfig,
} from "@agentbridge/core";
import {
 type OmpContextLike,
 type OmpDialogOptions,
 type OmpEphemeralResult,
 type OmpEphemeralTurnOptions,
 type OmpEphemeralUsage,
 type OmpLike,
 type OmpSelectItem,
 errorMessage,
} from "./omp";
import { buildConsentView, callerLabel, runPagedConsent, sanitizeDialogText } from "./consent";
import { CONSENT_TEXT, CONSULT_TEXT } from "./messages";
import { buildPrompt, locationOf } from "./prompt";

/** Choices offered by `ctx.ui.select`; the API returns the selected label. */
export const CONSENT_OPTIONS: readonly string[] = [
 CONSULT_TEXT.allowOnce,
 CONSULT_TEXT.allowSession,
 CONSULT_TEXT.deny,
];
export const CONSENT_TITLE = CONSULT_TEXT.consentTitle;
const CONSENT_SESSION_CHARS = 128;
/** Attachment locations listed in the consent dialog before "… và K tệp khác". */
const CONSENT_MAX_ATTACHMENTS = 10;
/** Attachment paths come from the caller; keep them to one bounded line. */
const ATTACHMENT_PATH_CHARS = 512;

export interface ConsultRequest {
 ctx: OmpContextLike;
 sessionId: string;
 /** `git.worktree ?? cwd`, already canonical (01 §7.4 step 2). */
 project: string;
 requestId: string;
 from: Peer;
 body: ConsultBody;
 model?: ModelRef;
 signal: AbortSignal;
 isTrusted(): boolean;
 trustSession(): void;
 sendProgress(body: ProgressBody): void;
 /** Reports non-consult failures (e.g. an unwritable audit log) without failing the turn. */
 reportError?(error: unknown): void;
}

/**
 * OMP v18.13.3 `agent-session.ts:850-866, 12604-12615` is the source of the
 * rejection messages. v18.14.0 is additive per the pinned references; re-check
 * both spots when upgrading.
 */
const MAX_TOKENS_REJECTION = /does not support maxTokens|cannot preserve maxTokens/i;
const MODEL_OR_SESSION_CHANGED = /Active (?:model|session) changed/i;

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
const ERROR_MESSAGE_CHARS = 500;

class ConsultFailure extends ProtocolError {
 readonly auditEvent: AuditEventName;

 constructor(code: ErrorCode, message: string, auditEvent: AuditEventName = "consult") {
  super(code, message);
  this.name = "ConsultFailure";
  this.auditEvent = auditEvent;
 }
}

function redactedMessage(error: unknown): string {
 return redact(errorMessage(error)).text.slice(0, ERROR_MESSAGE_CHARS);
}

/** Step 11 order: maxTokens, model/session change, abort, anything else. */
function classifyTurnError(error: unknown, aborted: boolean): ConsultFailure {
 const message = errorMessage(error);
 if (MAX_TOKENS_REJECTION.test(message)) {
  return new ConsultFailure("max_tokens_unsupported", redactedMessage(error));
 }
 if (MODEL_OR_SESSION_CHANGED.test(message)) {
  return new ConsultFailure("model_changed", redactedMessage(error));
 }
 if (aborted) return new ConsultFailure("cancelled", "client disconnected");
 return new ConsultFailure("provider_error", redactedMessage(error));
}

function isFailure(error: unknown): error is ConsultFailure {
 return error instanceof ConsultFailure;
}

function pathKey(path: string): string {
 return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Config `projects` are realpaths; the target is `git.worktree ?? cwd` (also canonical). */
export function projectAllowed(projects: readonly string[], target: string): boolean {
 const key = pathKey(target);
 return projects.some((project) => pathKey(project) === key);
}

function attachmentBytes(attachments: readonly ConsultAttachment[]): number {
 let total = 0;
 for (const attachment of attachments) total += Buffer.byteLength(attachment.text, "utf8");
 return total;
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
 const buffer = Buffer.from(text, "utf8");
 if (buffer.length <= maxBytes) return { text, truncated: false };
 let end = maxBytes;
 while (end > 0) {
  const byte = buffer[end];
  if (byte === undefined || (byte & 0xc0) !== 0x80) break;
  end -= 1;
 }
 return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/** Keep only finite numeric usage fields; shared by consult and chat. */
export function pickUsage(usage: OmpEphemeralUsage | undefined): Usage | undefined {
 if (usage === undefined) return undefined;
 const selected: Usage = {};
 let found = false;
 for (const field of USAGE_FIELDS) {
  const value = usage[field];
  if (typeof value === "number" && Number.isFinite(value)) {
   selected[field] = value;
   found = true;
  }
 }
 return found ? selected : undefined;
}

function usageOf(result: OmpEphemeralResult): Usage | undefined {
 return pickUsage(result.assistantMessage?.usage);
}

/**
 * §5.3: the exact question and attachments the model will receive. Sanitized
 * first so a secret split by an invisible character is still redacted, then
 * redacted again on the host (defense in depth; the caller redacts too).
 */
function consultPayload(body: ConsultBody): { question: string; attachments: ConsultAttachment[] } {
 const question = redact(sanitizeText(body.question)).text;
 const attachments = (body.attachments ?? []).map((attachment) => {
  const clean: ConsultAttachment = {
   path: sanitizeLabel(attachment.path, ATTACHMENT_PATH_CHARS),
   text: redact(sanitizeText(attachment.text)).text,
  };
  if (attachment.startLine !== undefined) clean.startLine = attachment.startLine;
  if (attachment.endLine !== undefined) clean.endLine = attachment.endLine;
  return clean;
 });
 return { question, attachments };
}

function consentTitle(
 request: ConsultRequest,
 attachments: readonly ConsultAttachment[],
 sizeLine: string,
 body: string,
 page?: { index: number; total: number },
): string {
 const callerSession = sanitizeDialogText(callerLabel(request.from.sessionId), CONSENT_SESSION_CHARS, 1);
 const lines = [CONSENT_TITLE, ""];
 if (page !== undefined) lines.push(CONSENT_TEXT.page(page.index, page.total));
 if (body.length > 0) lines.push(body, "");
 lines.push(sizeLine, CONSULT_TEXT.attachmentsLine(attachments.length, callerSession));
 for (const attachment of attachments.slice(0, CONSENT_MAX_ATTACHMENTS)) {
  lines.push(CONSULT_TEXT.attachmentItem(sanitizeDialogText(locationOf(attachment), 160, 1)));
 }
 if (attachments.length > CONSENT_MAX_ATTACHMENTS) {
  lines.push(CONSULT_TEXT.moreAttachments(attachments.length - CONSENT_MAX_ATTACHMENTS));
 }
 return lines.join("\n");
}

/** Token bucket; `ratePerMinute` is both refill rate and burst capacity. */
class TokenBucket {
 #tokens = 0;
 #last = 0;
 #rate = -1;

 take(ratePerMinute: number, now: number): boolean {
  if (ratePerMinute <= 0) return false;
  if (this.#rate < 0) {
   this.#rate = ratePerMinute;
   this.#tokens = ratePerMinute;
   this.#last = now;
  } else {
   const elapsed = now - this.#last;
   if (elapsed > 0) {
    this.#tokens = Math.min(ratePerMinute, this.#tokens + (elapsed * this.#rate) / 60_000);
    this.#last = now;
   }
   if (ratePerMinute !== this.#rate) {
    this.#tokens = Math.min(this.#tokens, ratePerMinute);
    this.#rate = ratePerMinute;
   }
  }
  if (this.#tokens >= 1) {
   this.#tokens -= 1;
   return true;
  }
  return false;
 }
}

/** Transport performs the same check; this guards direct callers and survives restarts of `startServer`. */
class RequestDedupe {
 #seen = new Map<string, number>();

 fresh(id: string, now: number): boolean {
  for (const [seenId, ts] of this.#seen) {
   if (now - ts <= DEDUPE_TTL_MS) break;
   this.#seen.delete(seenId);
  }
  const previous = this.#seen.get(id);
  if (previous !== undefined && now - previous <= DEDUPE_TTL_MS) return false;
  this.#seen.delete(id);
  this.#seen.set(id, now);
  while (this.#seen.size > DEDUPE_LRU) {
   const oldest = this.#seen.keys().next().value;
   if (oldest === undefined) break;
   this.#seen.delete(oldest);
  }
  return true;
 }
}

/** Bytes buffered past this without a newline are flushed up to the last whitespace. */
const DELTA_FLUSH_BYTES = 4 * 1024;
/** A PEM header means the following lines are key material; deltas stop there. */
const PEM_HEADER = "-----BEGIN";
/** Secret-assignment names (§5.1), matched at the end of a ≤ 12-character window. */
const KEYWORD_AT_END = /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)$/i;
const KEYWORD_WINDOW = 12;
/**
 * Upper bound for held text (and for the backwards scan). A real key and its
 * value are never kilobytes apart; without a bound, a name followed by an
 * endless run of blank lines would be rescanned on every delta.
 */
const MAX_HELD_CHARS = 4 * 1024;

function isSpaceOrQuote(char: string): boolean {
 const code = char.charCodeAt(0);
 if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x22 || code === 0x27) return true;
 return code > 0x7f && /\s/.test(char);
}

/**
 * Index of a secret-assignment name that the text up to `end` ends with —
 * `name`, `name:`, `"name": "` … — skipping trailing whitespace, quotes and
 * one `:`/`=`; -1 when there is none. Linear in the skipped run, no regex
 * backtracking. The name may sit inside a value (`admin_password`), which is
 * why callers hold whole lines, not just the name.
 */
function openAssignmentStart(text: string, end: number): number {
 const floor = Math.max(0, end - MAX_HELD_CHARS);
 let index = end;
 let separator = false;
 while (index > floor) {
  const char = text.charAt(index - 1);
  if (isSpaceOrQuote(char)) index -= 1;
  else if (!separator && (char === ":" || char === "=")) {
   separator = true;
   index -= 1;
  } else break;
 }
 if (index === floor && floor > 0) return -1;
 const window = text.slice(Math.max(0, index - KEYWORD_WINDOW), index);
 const match = KEYWORD_AT_END.exec(window);
 return match === null ? -1 : index - window.length + match.index;
}

/**
 * Stream deltas to the caller without ever emitting an un-redacted chunk.
 *
 * A secret split across two chunks (`"api_key="` + `"sk-…\n"`) is only
 * recognisable as a whole line, so deltas are buffered until a `\n` arrives and
 * every completed line goes through `redact()`. A chunk that ends in an open
 * assignment (`password:`) keeps that tail pending until its value arrives, even
 * across a newline. An overlong unterminated tail is flushed up to its last
 * whitespace under the same rule. Once a line contains a PEM header the rest of
 * the turn is muted, because a multi-line key block can never be redacted line
 * by line. Emitted text is also `sanitizeText`ed (§5.3). The final result still
 * carries the full redacted reply; the unterminated tail is never streamed.
 */
export class RedactingDeltaStream {
 #pending = "";
 /** A trailing `\r` waits for the next delta: `\r` + `\n` must become one newline. */
 #carry = "";
 #muted = false;
 readonly #send: (delta: string) => void;

 constructor(send: (delta: string) => void) {
  this.#send = send;
 }

 push(delta: string): void {
  if (this.#muted || delta.length === 0) return;
  // Sanitize first so the open-assignment check sees what will be emitted.
  const raw = this.#carry + delta;
  this.#carry = raw.endsWith("\r") ? "\r" : "";
  this.#pending += sanitizeText(this.#carry === "" ? raw : raw.slice(0, -1));
  const lastNewline = this.#pending.lastIndexOf("\n");
  if (lastNewline >= 0) {
   const complete = this.#pending.slice(0, lastNewline + 1);
   const rest = this.#pending.slice(lastNewline + 1);
   const held = this.#release(complete);
   if (this.#muted) return;
   this.#pending = held + rest;
  }
  if (Buffer.byteLength(this.#pending, "utf8") > DELTA_FLUSH_BYTES) this.#flushToWhitespace();
 }

 #flushToWhitespace(): void {
  // A single token with no whitespace stays buffered: splitting it would defeat
  // redaction. `replyMaxBytes` bounds how much can accumulate.
  const lastWhitespace = /\s\S*$/.exec(this.#pending);
  if (lastWhitespace === null) return;
  const chunk = this.#pending.slice(0, lastWhitespace.index + 1);
  const rest = this.#pending.slice(lastWhitespace.index + 1);
  const held = this.#release(chunk);
  if (this.#muted) return;
  this.#pending = held + rest;
 }

 /**
  * Emit `text` except a trailing open assignment, which is returned to stay
  * pending. The hold starts at the whitespace-delimited token that holds the
  * name, then moves back over `:`/`=`/whitespace while the text before it
  * ends in another name: a name can end a value (`api_key: my_api_key`,
  * `DB_PASSWORD=admin_password`) or a value can sit on the next line
  * (`password:` ⏎ value), and the key must be redacted together with its value.
  * Held text is bounded by `MAX_HELD_CHARS`. Lines before a PEM header are
  * emitted, then the stream is muted.
  */
 #release(text: string): string {
  const floor = Math.max(0, text.length - MAX_HELD_CHARS);
  let cut = text.length;
  let name = openAssignmentStart(text, cut);
  while (name >= 0) {
   cut = name;
   while (cut > floor && !isSpaceOrQuote(text.charAt(cut - 1))) cut -= 1;
   if (cut <= floor && floor > 0) {
    // Longer than the bound: holding would only delay the stream.
    cut = text.length;
    break;
   }
   name = openAssignmentStart(text, cut);
  }
  const ready = text.slice(0, cut);
  const pem = ready.indexOf(PEM_HEADER);
  if (pem >= 0) {
   this.#emit(ready.slice(0, ready.lastIndexOf("\n", pem) + 1));
   this.#muted = true;
   this.#pending = "";
   return "";
  }
  this.#emit(ready);
  return text.slice(cut);
 }

 /** Redact the whole chunk (a pair may span lines), then send one delta per line. */
 #emit(text: string): void {
  if (this.#muted || text.length === 0) return;
  const clean = redact(sanitizeText(text)).text;
  let start = 0;
  while (start < clean.length) {
   const newline = clean.indexOf("\n", start);
   const end = newline < 0 ? clean.length : newline + 1;
   this.#send(clean.slice(start, end));
   start = end;
  }
 }
}

/** Reply tail shown by the live widget; the full reply always goes to the client. */
const WIDGET_THROTTLE_MS = 200;
const WIDGET_LINE_CHARS = 160;
const WIDGET_QUESTION_LINES = 2;
const WIDGET_CALLER_CHARS = 120;
const WIDGET_DIVIDER = "─".repeat(40);

/**
 * OMP 18.14.0 renders string-array widgets in
 * `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`:
 * `MAX_WIDGET_LINES = 10`, and `#createHookWidget()` applies
 * `content.slice(0, 10)` before appending "... (widget truncated)". Lines past
 * the cap never reach the screen, so the widget must always fit.
 */
export const OMP_WIDGET_MAX_LINES = 10;
/** Header + divider + the question cap leave at most this many tail lines. */
const WIDGET_MAX_TAIL_LINES = OMP_WIDGET_MAX_LINES - WIDGET_QUESTION_LINES - 2;

type WidgetTimer = NodeJS.Timeout;

/** Timers here are display-only: never let them keep the process alive. */
function scheduleWidgetTimer(callback: () => void, ms: number): WidgetTimer {
 const timer = setNodeTimeout(callback, ms);
 timer.unref();
 return timer;
}

/** One sanitized, width-bounded widget line. */
function widgetLine(text: string, maxChars: number = WIDGET_LINE_CHARS): string {
 const clean = sanitizeText(text).replace(/\t/g, "  ").replace(/\n+/g, " ");
 return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

/**
 * Tail budget for the fixed layout: 1 header + question lines + 1 divider +
 * tail must stay within OMP's cap. The final slice is the last N lines.
 */
function widgetTailLineLimit(widgetLines: number, questionLines: number): number {
 const requested = Math.min(Math.max(Math.trunc(widgetLines), 1), WIDGET_MAX_TAIL_LINES);
 const available = OMP_WIDGET_MAX_LINES - 2 - questionLines;
 return Math.max(1, Math.min(requested, available));
}

function widgetQuestionLines(question: string): string[] {
 const sanitized = sanitizeDialogText(
  question,
  Number.POSITIVE_INFINITY,
  WIDGET_QUESTION_LINES,
 );
 if (sanitized.length === 0) return [];
 return sanitized.split("\n").slice(0, WIDGET_QUESTION_LINES).map((line) => widgetLine(line));
}

/**
 * Bounded tail of redacted stream deltas. Only the configured number of lines
 * is kept, and each kept line is capped at the widget width.
 */
class WidgetStreamTail {
 readonly #maxLines: number;
 #lines: string[] = [];
 #partial = "";

 constructor(maxLines: number) {
  this.#maxLines = Math.max(1, maxLines);
 }

 push(delta: string): void {
  if (delta.length === 0) return;
  const parts = `${this.#partial}${delta}`.split("\n");
  this.#partial = parts.pop() ?? "";
  for (const line of parts) this.#pushLine(line);
  if (this.#partial.length > WIDGET_LINE_CHARS) {
   this.#partial = this.#partial.slice(0, WIDGET_LINE_CHARS);
  }
 }

 render(): string[] {
  const lines = [...this.#lines];
  if (this.#partial.length > 0) lines.push(this.#partial);
  return lines.slice(-this.#maxLines).map((line) => widgetLine(line));
 }

 #pushLine(line: string): void {
  this.#lines.push(line.length > WIDGET_LINE_CHARS ? line.slice(0, WIDGET_LINE_CHARS) : line);
  while (this.#lines.length > this.#maxLines) this.#lines.shift();
 }
}

interface LiveWidgetState {
 readonly ctx: OmpContextLike;
 readonly question: string[];
 readonly tail: WidgetStreamTail;
 readonly holdMs: number;
 header: string;
 lastRenderAt: number;
 renderTimer?: WidgetTimer;
 holdTimer?: WidgetTimer;
 finished: boolean;
}

/** Used when OMP cannot report a model after answering; the reply is still valid. */
export const UNKNOWN_MODEL: ModelRef = { provider: "unknown", id: "unknown" };

export class ConsultManager {
 readonly #omp: OmpLike;
 readonly #bucket = new TokenBucket();
 readonly #dedupe = new RequestDedupe();
 #inFlight = 0;
 #widget: LiveWidgetState | undefined;

 constructor(omp: OmpLike) {
  this.#omp = omp;
 }

 /** Remove the live widget immediately (command, shutdown, session switch, off). */
 clearWidget(ctx?: OmpContextLike): void {
  this.#disposeWidget(ctx);
 }

 async handle(request: ConsultRequest): Promise<ConsultResult> {
  const startedAt = Date.now();
  let config: Config | undefined;
  let auditEvent: AuditEventName = "consult";
  let questionForAudit: string | undefined = request.body.question;
  let replyForAudit: string | undefined;
  let usage: Usage | undefined;
  let model = this.#omp.model(request.ctx) ?? request.model;
  let outcome: "ok" | ErrorCode = "internal";
  let widget: LiveWidgetState | undefined;

  try {
   if (!this.#dedupe.fresh(request.requestId, startedAt)) {
    throw new ConsultFailure("duplicate", "duplicate request id");
   }
   if (!this.#omp.supportsConsult(request.ctx)) {
    throw new ConsultFailure("unsupported_capability", "host has no runEphemeralTurn");
   }

   // 1. cfg = loadConfig()
   config = await loadConfig();

   // 2. project allowed
   if (!projectAllowed(config.projects, request.project)) {
    throw new ConsultFailure(
     "project_not_allowed",
     `project is not allowed: ${request.project}`,
     "denied",
    );
   }

   // 3. caller agent allowed
   if (!config.allowFrom.includes(request.from.agent)) {
    throw new ConsultFailure("denied", `agent is not allowed: ${request.from.agent}`, "denied");
   }

   // 4. size limits (question and attachments are capped separately)
   const attachments = request.body.attachments ?? [];
   if (
    Buffer.byteLength(request.body.question, "utf8") > config.consult.maxQuestionBytes ||
    attachmentBytes(attachments) > config.consult.maxAttachmentBytes
   ) {
    throw new ConsultFailure("too_large", "question or attachments exceed the configured limit");
   }

   // 5. rate limit, then concurrency (checked in this order by spec)
   if (!this.#bucket.take(config.consult.ratePerMinute, Date.now())) {
    throw new ConsultFailure("rate_limited", `rate limit ${config.consult.ratePerMinute}/min exceeded`);
   }
   if (this.#inFlight >= CONSULT_CONCURRENCY) {
    throw new ConsultFailure("busy_limit", "another consult is already running");
   }

   // 6. claim the single slot
   this.#inFlight += 1;
   try {
    // §5.3: one sanitized + redacted payload for the dialog, widget and prompt.
    const payload = consultPayload(request.body);

    // 7. consent
    const mode = request.isTrusted() ? "always" : config.consult.consent;
    if (mode === "deny") {
     throw new ConsultFailure("denied", "consent policy is deny", "denied");
    }
    if (mode === "ask" || mode === "session") {
     request.sendProgress({ phase: "awaiting_consent" });
     const choice = await this.#selectConsent(request, config, payload);
     if (request.signal.aborted) {
      throw new ConsultFailure("cancelled", "client disconnected during consent");
     }
     if (choice === undefined) {
      throw new ConsultFailure("consent_timeout", "consent dialog timed out");
     }
     if (choice === CONSENT_OPTIONS[2]) {
      throw new ConsultFailure("denied", "user declined the consult", "denied");
     }
     if (choice === CONSENT_OPTIONS[1]) request.trustSession();
     if (choice !== CONSENT_OPTIONS[0] && choice !== CONSENT_OPTIONS[1]) {
      throw new ConsultFailure("denied", "user declined the consult", "denied");
     }
    }
    if (request.signal.aborted) {
     throw new ConsultFailure("cancelled", "client disconnected before the turn");
    }

    // 8. running
    request.sendProgress({ phase: "running" });
    // Display-only: after consent, the widget shows the question and the
    // redacted delta stream. It never touches the session or LLM context.
    if (config.ui.liveWidget) widget = this.#beginWidget(request, payload.question, config.ui);

    // 9. prompt
    const prompt = buildPrompt(payload.question, payload.attachments, request.from.sessionId);

    // 10. options
    const limitReply = request.body.limits?.replyMaxBytes;
    const limitTokens = request.body.limits?.maxTokens;
    const replyMaxBytes = Math.min(
     config.consult.replyMaxBytes,
     limitReply ?? Number.POSITIVE_INFINITY,
    );
    const maxTokens =
     config.consult.maxTokens > 0
      ? Math.min(config.consult.maxTokens, limitTokens ?? Number.POSITIVE_INFINITY)
      : undefined;
    const options: OmpEphemeralTurnOptions = {
     promptText: prompt,
     tools: config.consult.toolsOff ? false : undefined,
     maxContextBytes: config.consult.maxContextBytes,
     replyMaxBytes,
     dedupeReply: true,
     signal: request.signal,
    };
    if (request.body.stream === true || widget !== undefined) {
     const stream = new RedactingDeltaStream((delta) => {
      if (request.body.stream === true) request.sendProgress({ phase: "delta", delta });
      if (widget !== undefined) this.#pushWidgetDelta(widget, delta);
     });
     options.onTextDelta = (delta: string) => stream.push(delta);
    }
    if (maxTokens !== undefined) options.maxTokens = maxTokens;

    // 11. run, with the one allowed uncapped retry
    let capped = maxTokens !== undefined;
    let result: OmpEphemeralResult;
    try {
     result = await this.#omp.runEphemeralTurn(request.ctx, options);
    } catch (error) {
     const failure = classifyTurnError(error, request.signal.aborted);
     if (
      failure.code === "max_tokens_unsupported" &&
      config.consult.allowUncapped &&
      maxTokens !== undefined
     ) {
      const retry: OmpEphemeralTurnOptions = { ...options };
      delete retry.maxTokens;
      capped = false;
      try {
       result = await this.#omp.runEphemeralTurn(request.ctx, retry);
      } catch (retryError) {
       throw classifyTurnError(retryError, request.signal.aborted);
      }
     } else {
      throw failure;
     }
    }

    // 12. sanitize (§5.3), redact and shape the result
    const redacted = redact(sanitizeText(typeof result.replyText === "string" ? result.replyText : ""));
    const limited = truncateUtf8(redacted.text, replyMaxBytes);
    const replyText = limited.text;
    // OMP can drop the model after the turn ran; an unknown label must not discard the reply.
    const usedModel = this.#omp.model(request.ctx) ?? request.model ?? UNKNOWN_MODEL;
    model = usedModel;
    usage = usageOf(result);
    replyForAudit = replyText;
    const durationMs = Date.now() - startedAt;
    outcome = "ok";
    if (widget !== undefined) {
     this.#finalizeWidget(widget, CONSULT_TEXT.widgetDone(durationMs));
    }

    // 13. notify (best-effort inside the adapter)
    this.#omp.notify(request.ctx, CONSULT_TEXT.answered(durationMs), "info");

    return {
     replyText,
     truncated: limited.truncated,
     model: usedModel,
     usage,
     durationMs,
     capped,
    };
   } finally {
    this.#inFlight -= 1;
   }
  } catch (error) {
   let code: ErrorCode = "internal";
   if (isFailure(error)) {
    auditEvent = error.auditEvent;
    outcome = error.code;
    code = error.code;
   } else if (error instanceof ProtocolError) {
    auditEvent = "error";
    outcome = error.code;
    code = error.code;
   } else {
    auditEvent = "error";
    outcome = "internal";
   }
   if (widget !== undefined) this.#finalizeWidget(widget, CONSULT_TEXT.widgetFailed(code));
   throw error;
  } finally {
   if (config !== undefined) {
    await this.#record(
     request,
     config,
     auditEvent,
     outcome,
     questionForAudit,
     replyForAudit,
     usage,
     model,
     Date.now() - startedAt,
    );
   }
  }
 }

 #beginWidget(request: ConsultRequest, questionText: string, ui: UiConfig): LiveWidgetState {
  this.#disposeWidget();
  const caller = widgetLine(callerLabel(request.from.sessionId), WIDGET_CALLER_CHARS);
  const question = widgetQuestionLines(questionText);
  const state: LiveWidgetState = {
   ctx: request.ctx,
   question,
   tail: new WidgetStreamTail(widgetTailLineLimit(ui.widgetLines, question.length)),
   holdMs: ui.widgetHoldMs,
   header: CONSULT_TEXT.widgetHeader(caller),
   lastRenderAt: Date.now(),
   finished: false,
  };
  this.#widget = state;
  this.#renderWidget(state);
  return state;
 }

 /** Feed only `RedactingDeltaStream` output here; never a raw delta. */
 #pushWidgetDelta(state: LiveWidgetState, delta: string): void {
  if (this.#widget !== state || state.finished) return;
  state.tail.push(delta);

  const now = Date.now();
  const elapsed = now - state.lastRenderAt;
  if (elapsed >= WIDGET_THROTTLE_MS) {
   if (state.renderTimer !== undefined) {
    clearNodeTimeout(state.renderTimer);
    state.renderTimer = undefined;
   }
   this.#renderWidget(state);
   state.lastRenderAt = now;
   return;
  }
  if (state.renderTimer !== undefined) return;
  state.renderTimer = scheduleWidgetTimer(() => {
   state.renderTimer = undefined;
   if (this.#widget !== state || state.finished) return;
   this.#renderWidget(state);
   state.lastRenderAt = Date.now();
  }, WIDGET_THROTTLE_MS - elapsed);
 }

 /** Final flush, then remove the widget after the configured hold. */
 #finalizeWidget(state: LiveWidgetState, header: string): void {
  if (this.#widget !== state || state.finished) return;
  state.finished = true;
  if (state.renderTimer !== undefined) {
   clearNodeTimeout(state.renderTimer);
   state.renderTimer = undefined;
  }
  state.header = header;
  this.#renderWidget(state);
  state.holdTimer = scheduleWidgetTimer(() => {
   state.holdTimer = undefined;
   if (this.#widget === state) this.#disposeWidget();
  }, state.holdMs);
 }

 #renderWidget(state: LiveWidgetState): void {
  if (this.#widget !== state) return;
  // Invariant: 1 header + ≤2 question lines + 1 divider + ≤6 tail lines, so the
  // array never exceeds OMP_WIDGET_MAX_LINES. The tail is always the last N lines.
  const lines = [state.header, ...state.question, WIDGET_DIVIDER, ...state.tail.render()];
  try {
   this.#omp.setWidget(state.ctx, lines);
  } catch {
   // The widget is display-only: never fail the consult because of the UI.
  }
 }

 #disposeWidget(ctx?: OmpContextLike): void {
  const state = this.#widget;
  if (state === undefined) return;
  this.#widget = undefined;
  if (state.renderTimer !== undefined) {
   clearNodeTimeout(state.renderTimer);
   state.renderTimer = undefined;
  }
  if (state.holdTimer !== undefined) {
   clearNodeTimeout(state.holdTimer);
   state.holdTimer = undefined;
  }
  try {
   this.#omp.setWidget(ctx ?? state.ctx, undefined);
  } catch {
   // Best-effort removal.
  }
 }

 /**
  * §7.4 step 7: snippet dialog, then "Xem toàn văn" pages when the snippet
  * hides anything; approval is only offered once everything was shown.
  * `consentTimeoutMs` is one deadline shared by every dialog.
  */
 async #selectConsent(
  request: ConsultRequest,
  config: Config,
  payload: { question: string; attachments: ConsultAttachment[] },
 ): Promise<string | undefined> {
  const view = buildConsentView(payload.question);
  const deadline = Date.now() + config.consult.consentTimeoutMs;
  return runPagedConsent({
   view,
   title: (body, page) => consentTitle(request, payload.attachments, view.sizeLine, body, page),
   finalOptions: CONSENT_OPTIONS,
   denyOption: CONSULT_TEXT.deny,
   beforeDialog: () => {
    if (Date.now() >= deadline) throw new ConsultFailure("consent_timeout", "consent dialog timed out");
   },
   expired: () => Date.now() >= deadline,
   select: async (title, options, initialIndex) => {
    const dialogOptions: OmpDialogOptions = {
     timeout: Math.max(1, deadline - Date.now()),
     signal: request.signal,
     initialIndex,
    };
    try {
     return await this.#omp.select(request.ctx, title, options as OmpSelectItem[], dialogOptions);
    } catch (error) {
     if (request.signal.aborted) {
      throw new ConsultFailure("cancelled", "client disconnected during consent");
     }
     throw new ConsultFailure("internal", `ui.select failed: ${redactedMessage(error)}`, "error");
    }
   },
  });
 }

 async #record(
  request: ConsultRequest,
  config: Config,
  event: AuditEventName,
  outcome: "ok" | ErrorCode,
  question: string | undefined,
  reply: string | undefined,
  usage: Usage | undefined,
  model: ModelRef | undefined,
  durationMs: number,
 ): Promise<void> {
  const audit: AuditEvent = {
   event,
   id: request.requestId,
   from: { agent: request.from.agent, sessionId: request.from.sessionId },
   to: { sessionId: request.sessionId },
   project: request.project,
   durationMs,
   outcome,
  };
  if (question !== undefined) audit.question = question;
  if (reply !== undefined) audit.reply = reply;
  if (usage !== undefined) audit.usage = usage;
  if (model !== undefined) audit.model = `${model.provider}/${model.id}`;
  try {
   await appendAudit(audit, {
    stateDir: resolveDirs().stateDir,
    maxBytes: config.audit.maxBytes,
    content: config.audit.content,
   });
  } catch (error) {
   request.reportError?.(error);
  }
 }
}
