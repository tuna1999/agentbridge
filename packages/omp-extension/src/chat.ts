/**
 * T12 opt-in chat: relay a caller message into the live OMP transcript as a
 * real user turn, then capture the reply from the resulting `agent_end`.
 *
 * OMP API sources:
 * - `pi.sendUserMessage` / `SendUserMessageOptions`:
 *   extension-types.v18.14.0.ts.txt:2059-2062, 2299-2302; options imported at
 *   :94 from session/agent-session (agent-session-types.d.ts:485-490);
 *   delivery semantics documented at extensions.md:326-331.
 * - `agent_end` with `willContinue`:
 *   extension-types.v18.14.0.ts.txt:1855-1856, 1188-1195;
 *   extensibility/shared-events.d.ts:166-174.
 * - `message_start` / `message_update` / `message_end`:
 *   extension-types.v18.14.0.ts.txt:1197-1219, 1860-1862.
 * - Programmatic sends do NOT emit `input` (extensions.md:550-553), so chat
 *   cannot recurse through our own ingress hooks.
 */
import {
 type ChatBody,
 type ChatResult,
 CONSENT_TOTAL_MAX_MS,
 type ErrorCode,
 isRecord,
 type ModelRef,
 type Peer,
 type ProgressBody,
 ProtocolError,
 redact,
 sanitizeText,
 type Usage,
} from "@agentbridge/protocol";
import {
 type AuditEvent,
 appendAudit,
 type Config,
 loadConfig,
 resolveDirs,
} from "@agentbridge/core";
import {
 projectAllowed,
 RedactingDeltaStream,
 truncateUtf8,
 UNKNOWN_MODEL,
} from "./consult";
import { buildConsentView, callerLabel, paginateText, runPagedConsent, sanitizeDialogText } from "./consent";
import { CHAT_TEXT, CONSENT_TEXT } from "./messages";
import { type AutoApproval, MANUAL_CONSENT } from "./autochat";
import {
 errorMessage,
 type OmpAgentEndLike,
 type OmpAgentMessageLike,
 type OmpContextLike,
 type OmpLike,
 type OmpMessageEndLike,
 type OmpMessageStartLike,
 type OmpMessageUpdateLike,
 type OmpTimer,
} from "./omp";

export const CHAT_SEND_OPTION = CHAT_TEXT.send;
export const CHAT_DENY_OPTION = CHAT_TEXT.deny;
/** The last consent dialog's choices as shown, deny first (01 §7.4b step 8). */
export const CHAT_CONSENT_OPTIONS: readonly string[] = [CHAT_DENY_OPTION, CHAT_SEND_OPTION];
export const CHAT_VIEW_FULL_OPTION = CONSENT_TEXT.viewFull;
export const CHAT_NEXT_PAGE_OPTION = CONSENT_TEXT.nextPage;
export const CHAT_CONSENT_TITLE = CHAT_TEXT.consentTitle;
const CALLER_CHARS = 160;
const ERROR_MESSAGE_CHARS = 500;

/**
 * Exact framing required by 01 §7.4b: the OMP model must see the source. The
 * caller id is self-declared, so it is kept to one line without brackets that
 * could close the frame label early.
 */
export function buildChatFrame(message: string, callerSessionId: string): string {
 return CHAT_TEXT.frame(callerLabel(callerSessionId), message);
}

/** §5.3: the exact text the operator approves and OMP receives. */
function chatPayload(message: string): string {
 return redact(sanitizeText(message)).text;
}

/** Kept for the public extension API; pages come from the shared consent module. */
export const paginateChatText = paginateText;

function redactedError(error: unknown): string {
 return redact(errorMessage(error)).text.slice(0, ERROR_MESSAGE_CHARS);
}

class ChatFailure extends ProtocolError {
 constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  super(code, message, details);
  this.name = "ChatFailure";
 }
}

function timeoutFailure(timeoutMs: number): ChatFailure {
 return new ChatFailure("target_exited", `chat timed out after ${timeoutMs}ms`, { reason: "chat_timeout" });
}

function messageOf(value: unknown): OmpAgentMessageLike | undefined {
 if (!isRecord(value)) return undefined;
 return value;
}

/** Text blocks of an agent message; user content may also be a plain string. */
function messageText(message: OmpAgentMessageLike | undefined): string {
 if (message === undefined) return "";
 if (typeof message.content === "string") return message.content;
 if (!Array.isArray(message.content)) return "";
 const parts: string[] = [];
 for (const block of message.content) {
  if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
 }
 return parts.join("\n");
}

function lastAssistant(messages: readonly OmpAgentMessageLike[]): OmpAgentMessageLike | undefined {
 for (let index = messages.length - 1; index >= 0; index -= 1) {
  const message = messages[index];
  if (message?.role === "assistant") return message;
 }
 return undefined;
}

function usageOf(message: OmpAgentMessageLike | undefined): Usage | undefined {
 const usage = message?.usage;
 if (usage === undefined) return undefined;
 const selected: Usage = {};
 let found = false;
 for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
  const value = usage[field];
  if (typeof value === "number" && Number.isFinite(value)) {
   selected[field] = value;
   found = true;
  }
 }
 return found ? selected : undefined;
}

function containsFrame(messages: readonly OmpAgentMessageLike[], frame: string): boolean {
 return messages.some(
  (message) => message.role === "user" && messageText(message).includes(frame),
 );
}


function consentCaller(request: ChatRequest): string {
 return sanitizeDialogText(CHAT_TEXT.caller(request.from.agent, callerLabel(request.from.sessionId)), CALLER_CHARS, 1);
}

function chatConsentTitle(
 request: ChatRequest,
 body: string,
 sizeLine: string,
 page?: { index: number; total: number },
): string {
 const lines = [CHAT_CONSENT_TITLE, ""];
 if (page !== undefined) lines.push(CONSENT_TEXT.page(page.index, page.total));
 lines.push(
  body,
  "",
  sizeLine,
  CHAT_TEXT.callerLine(consentCaller(request)),
  CHAT_TEXT.transcriptWarning,
 );
 return lines.join("\n");
}

export interface ChatRequest {
 ctx: OmpContextLike;
 sessionId: string;
 /** `git.worktree ?? cwd`, already canonical. */
 project: string;
 requestId: string;
 from: Peer;
 body: ChatBody;
 model?: ModelRef;
 signal: AbortSignal;
 sendProgress(body: ProgressBody): void;
 /** T12b: return an approval to skip the manual dialog; undefined falls back. */
 autoApprove?(message: string, config: Config): AutoApproval | undefined;
 /** T12b: called after an auto-approved message was handed to OMP. */
 autoSent?(): void;
 reportError?(error: unknown): void;
 /** Used by session switch/shutdown to write the error before sockets close. */
 sendError?(error: ProtocolError): void;
}

interface PendingChat {
 ctx: OmpContextLike;
 sessionId: string;
 requestId: string;
 startedAt: number;
 model?: ModelRef;
 replyMaxBytes: number;
 timeoutMs: number;
 consentTimeoutMs: number;
 /** "manual" or a source-specific auto consent reason, for the audit line. */
 consent?: string;
 frame?: string;
 sentWhileIdle: boolean;
 delivered: boolean;
 settled: boolean;
 timedOut: boolean;
 abort: AbortController;
 timer?: OmpTimer;
 removeCallerAbort?: () => void;
 stream?: RedactingDeltaStream;
 lastAssistant?: OmpAgentMessageLike;
 resolve(result: ChatResult): void;
 reject(error: unknown): void;
 failure?: ProtocolError;
 reportError?(error: unknown): void;
 sendError?(error: ProtocolError): void;
}

/**
 * One pending chat per OMP session. Correlation is deliberately minimal: the
 * frame echoed in `message_start`/`agent_end` identifies our turn, and only a
 * terminal `agent_end` (willContinue !== true) completes the wait.
 */
export class ChatManager {
 readonly #omp: OmpLike;
 #pending: PendingChat | undefined;

 constructor(omp: OmpLike) {
  this.#omp = omp;
 }

 /** True while a chat is waiting for consent or a reply. */
 hasPending(): boolean {
  return this.#pending !== undefined;
 }

 /** Session switch/shutdown: reject the pending request instead of leaving the caller hanging. */
 cancelAll(message = "session switched or shut down"): void {
  const pending = this.#pending;
  if (pending === undefined) return;
  this.#settleError(pending, new ChatFailure("cancelled", message), true);
 }

 async handle(request: ChatRequest): Promise<ChatResult> {
  const startedAt = Date.now();
  let config: Config | undefined;
  let pending: PendingChat | undefined;
  let replyForAudit: string | undefined;
  let usage: Usage | undefined;
  let model = this.#omp.model(request.ctx) ?? request.model;
  let outcome: "ok" | ErrorCode = "internal";

  try {
   config = await loadConfig();
   if (!config.chat.enabled) {
    throw new ChatFailure("chat_disabled", "chat is disabled in AgentBridge config");
   }
   if (!this.#omp.supportsChat()) {
    throw new ChatFailure("unsupported_capability", "pi.sendUserMessage is unavailable");
   }
   if (!projectAllowed(config.projects, request.project)) {
    throw new ChatFailure("denied", `project is not allowed: ${request.project}`);
   }
   if (!config.allowFrom.includes(request.from.agent)) {
    throw new ChatFailure("denied", `agent is not allowed: ${request.from.agent}`);
   }
   if (Buffer.byteLength(request.body.message, "utf8") > config.consult.maxQuestionBytes) {
    throw new ChatFailure("too_large", "message exceeds the configured limit");
   }
   if (this.#pending !== undefined) {
    throw new ChatFailure("busy", "another chat is already waiting");
   }
   if (!this.#omp.isIdle(request.ctx) && !config.chat.queueWhenBusy) {
    throw new ChatFailure("busy", "OMP is busy and chat.queueWhenBusy is false");
   }
   if (request.signal.aborted) {
    throw new ChatFailure("cancelled", "client disconnected before consent");
   }
   // §5.3: what the operator approves (or autochat counts) is exactly what is sent.
   const payload = chatPayload(request.body.message);

   const deferred = Promise.withResolvers<ChatResult>();
   // The timer may reject while consent is still awaiting; keep that
   // rejection observed until `handle` awaits the same promise.
   deferred.promise.catch(() => undefined);
   const current: PendingChat = {
    ctx: request.ctx,
    sessionId: request.sessionId,
    requestId: request.requestId,
    startedAt,
    model: request.model,
    replyMaxBytes: config.consult.replyMaxBytes,
    timeoutMs: request.body.timeoutMs,
    consentTimeoutMs: config.chat.consentTimeoutMs,
    sentWhileIdle: false,
    delivered: false,
    settled: false,
    timedOut: false,
    abort: new AbortController(),
    resolve: deferred.resolve,
    reject: deferred.reject,
    reportError: request.reportError,
    sendError: request.sendError,
   };
   pending = current;
   this.#pending = current;

   const onCallerAbort = (): void => {
    try {
     current.abort.abort();
     this.#settleError(current, new ChatFailure("cancelled", "client disconnected"));
    } catch (error) {
     this.#report(current, error);
    }
   };
   if (request.signal.aborted) onCallerAbort();
   else {
    request.signal.addEventListener("abort", onCallerAbort, { once: true });
    current.removeCallerAbort = () => request.signal.removeEventListener("abort", onCallerAbort);
   }

   this.#armTimeout(current, request.body.timeoutMs);

   // T12b: autochat bypasses the manual dialog only when the current session
   // state and limit config allow this exact message. Otherwise fall back to
   // the mandatory manual consent flow; session trust never applies to chat.
   let auto: AutoApproval | undefined;
   try {
    auto = request.autoApprove?.(payload, config);
   } catch (error) {
    this.#report(current, error);
   }

   if (auto !== undefined) {
    current.consent = auto.consent;
   } else {
    current.consent = MANUAL_CONSENT;
    this.#progress(request, { phase: "awaiting_consent" });
    const choicePromise = this.#selectConsent(request, current, payload);
    // If the host times out or the caller disconnects while the dialog is
    // open, stop waiting even if a UI implementation ignores AbortSignal.
    choicePromise.catch(() => undefined);
    const choice = await Promise.race([
     choicePromise,
     deferred.promise.then(() => undefined),
    ]);
    if (current.settled) throw current.failure ?? new ChatFailure("cancelled", "chat cancelled");
    if (current.timedOut) throw timeoutFailure(request.body.timeoutMs);
    if (request.signal.aborted) {
     throw new ChatFailure("cancelled", "client disconnected during consent");
    }
    if (choice === undefined) {
     throw new ChatFailure("consent_timeout", "chat consent dialog timed out");
    }
    if (choice !== CHAT_SEND_OPTION) {
     throw new ChatFailure("denied", "user declined the chat message");
    }
   }

   // Consent can take minutes; re-check busy immediately before sending.
   const busy = !this.#omp.isIdle(request.ctx);
   if (busy && !config.chat.queueWhenBusy) {
    throw new ChatFailure("busy", "OMP became busy and chat.queueWhenBusy is false");
   }

   const frame = buildChatFrame(payload, request.from.sessionId);
   current.frame = frame;
   current.sentWhileIdle = !busy;
   current.stream = new RedactingDeltaStream((delta) => {
    this.#progress(request, { phase: "delta", delta });
   });
   this.#progress(request, { phase: "running" });

   // Never steer: idle lets sendUserMessage start a turn; busy queues a
   // follow-up. `attribution: "agent"` marks relayed text, not the user.
   this.#omp.sendUserMessage(
    request.ctx,
    frame,
    busy ? { deliverAs: "followUp", attribution: "agent" } : { attribution: "agent" },
   );
   if (auto !== undefined) {
    try {
     request.autoSent?.();
    } catch (error) {
     this.#report(current, error);
    }
   }

   const result = await deferred.promise;
   model = result.model;
   usage = result.usage;
   replyForAudit = result.replyText;
   outcome = "ok";
   return result;
  } catch (error) {
   if (pending !== undefined) this.#clearPending(pending);
   if (error instanceof ProtocolError) outcome = error.code;
   else outcome = "internal";
   throw error;
  } finally {
   if (pending !== undefined) this.#clearPending(pending);
   if (config !== undefined) {
    await this.#record(
     request,
     config,
     outcome,
     replyForAudit,
     usage,
     model,
     Date.now() - startedAt,
     pending?.consent,
    );
   }
  }
 }

 /** `message_start` identifies our relayed frame once OMP accepts it. */
 messageStart(ctx: OmpContextLike, event: OmpMessageStartLike): void {
  const pending = this.#pending;
  if (pending === undefined || pending.frame === undefined) return;
  try {
   if (!this.#sameSession(ctx, pending)) return;
   const message = messageOf(event.message);
   if (message?.role !== "user") return;
   if (messageText(message).includes(pending.frame)) pending.delivered = true;
  } catch (error) {
   this.#report(pending, error);
  }
 }

 /** Stream assistant text only after our frame was delivered. */
 messageUpdate(ctx: OmpContextLike, event: OmpMessageUpdateLike): void {
  const pending = this.#pending;
  if (pending === undefined || pending.frame === undefined || !pending.delivered) return;
  try {
   if (!this.#sameSession(ctx, pending)) return;
   const message = messageOf(event.message);
   if (message?.role !== "assistant") return;
   const delta = event.assistantMessageEvent;
   if (delta?.type !== "text_delta" || typeof delta.delta !== "string") return;
   pending.stream?.push(delta.delta);
  } catch (error) {
   this.#report(pending, error);
  }
 }

 /** Keep the newest assistant snapshot as a fallback when agent_end omits it. */
 messageEnd(ctx: OmpContextLike, event: OmpMessageEndLike): void {
  const pending = this.#pending;
  if (pending === undefined || pending.frame === undefined) return;
  try {
   if (!this.#sameSession(ctx, pending)) return;
   const message = messageOf(event.message);
   if (message?.role !== "assistant") return;
   if (pending.delivered || pending.sentWhileIdle) pending.lastAssistant = message;
  } catch (error) {
   this.#report(pending, error);
  }
 }

 agentEnd(ctx: OmpContextLike, event: OmpAgentEndLike): void {
  const pending = this.#pending;
  if (pending === undefined || pending.frame === undefined) return;
  try {
   if (!this.#sameSession(ctx, pending)) return;
   const raw = Array.isArray(event.messages) ? event.messages : [];
   const messages: OmpAgentMessageLike[] = [];
   for (const value of raw) {
    const message = messageOf(value);
    if (message !== undefined) messages.push(message);
   }
   if (containsFrame(messages, pending.frame)) pending.delivered = true;

   // A non-terminal settle is a continuation or background wake.
   if (event.willContinue === true) return;
   // While queued behind another run, ignore its terminal end. The frame
   // echo (message_start or agent_end) proves our turn was delivered.
   if (!pending.delivered && !pending.sentWhileIdle) return;

   const assistant = lastAssistant(messages) ?? pending.lastAssistant;
   if (assistant?.stopReason === "aborted") {
    this.#settleError(pending, new ChatFailure("cancelled", "user aborted the OMP turn"));
    return;
   }
   if (assistant?.stopReason === "error") {
    const detail = redact(String(assistant.errorMessage ?? "assistant turn failed")).text;
    this.#settleError(
     pending,
     new ChatFailure("provider_error", detail.slice(0, ERROR_MESSAGE_CHARS)),
    );
    return;
   }

   const redacted = redact(sanitizeText(messageText(assistant)));
   const limited = truncateUtf8(redacted.text, pending.replyMaxBytes);
   const result: ChatResult = {
    replyText: limited.text,
    truncated: limited.truncated,
    model: this.#omp.model(ctx) ?? pending.model ?? UNKNOWN_MODEL,
    durationMs: Date.now() - pending.startedAt,
   };
   const usage = usageOf(assistant);
   if (usage !== undefined) result.usage = usage;
   this.#settle(pending, result);
  } catch (error) {
   this.#report(pending, error);
  }
 }

 #sameSession(ctx: OmpContextLike, pending: PendingChat): boolean {
  try {
   return this.#omp.sessionId(ctx) === pending.sessionId;
  } catch {
   return false;
  }
 }

 #armTimeout(pending: PendingChat, timeoutMs: number): void {
  pending.timer = this.#omp.setTimeout(
   pending.ctx,
   () => {
    try {
     if (pending.settled) return;
     pending.timedOut = true;
     pending.abort.abort();
     this.#settleError(pending, timeoutFailure(timeoutMs));
    } catch (error) {
     this.#report(pending, error);
    }
   },
   timeoutMs,
  );
 }

 /**
  * Snippet dialog, then "Xem toàn văn" pages when the snippet hides anything;
  * Gửi is only offered on the last page. Each dialog gets
  * `chat.consentTimeoutMs`, `CONSENT_TOTAL_MAX_MS` caps the exchange, and the
  * chat body's timeout bounds every dialog.
  */
 async #selectConsent(
  request: ChatRequest,
  pending: PendingChat,
  payload: string,
 ): Promise<string | undefined> {
  const view = buildConsentView(payload);
  return runPagedConsent({
   view,
   title: (body, page) => chatConsentTitle(request, body, view.sizeLine, page),
   approveOptions: [CHAT_SEND_OPTION],
   denyOption: CHAT_DENY_OPTION,
   dialogTimeoutMs: pending.consentTimeoutMs,
   totalTimeoutMs: CONSENT_TOTAL_MAX_MS,
   beforeDialog: () => {
    if (pending.settled) throw pending.failure ?? new ChatFailure("cancelled", "chat cancelled");
   },
   select: (title, options, initialIndex, timeoutMs) =>
    this.#selectDialog(request, pending, title, options, initialIndex, timeoutMs),
  });
 }

 async #selectDialog(
  request: ChatRequest,
  pending: PendingChat,
  title: string,
  options: readonly string[],
  initialIndex: number,
  consentMs: number,
 ): Promise<string | undefined> {
  const timeout = dialogTimeout(pending, consentMs);
  const deadline = Date.now() + timeout;
  try {
   return await this.#omp.select(request.ctx, title, [...options], {
    timeout,
    signal: pending.abort.signal,
    initialIndex,
   });
  } catch (error) {
   if (pending.settled) throw pending.failure ?? new ChatFailure("cancelled", "chat cancelled");
   if (pending.timedOut) throw timeoutFailure(pending.timeoutMs);
   if (request.signal.aborted) {
    throw new ChatFailure("cancelled", "client disconnected during consent");
   }
   if (Date.now() >= deadline) {
    throw new ChatFailure("consent_timeout", "chat consent dialog timed out");
   }
   throw new ChatFailure("internal", `ui.select failed: ${redactedError(error)}`);
  }
 }

 #progress(request: ChatRequest, body: ProgressBody): void {
  try {
   request.sendProgress(body);
  } catch (error) {
   this.#reportRequest(request, error);
  }
 }

 #reportRequest(request: ChatRequest, error: unknown): void {
  try {
   request.reportError?.(error);
  } catch {
   // Reporting must never break the request path.
  }
 }

 #report(pending: PendingChat | undefined, error: unknown): void {
  try {
   pending?.reportError?.(error);
  } catch {
   // Reporting must never break the event handler.
  }
 }

 #settle(pending: PendingChat, result: ChatResult): void {
  if (pending.settled) return;
  pending.settled = true;
  this.#clearPending(pending);
  pending.resolve(result);
 }

 #settleError(pending: PendingChat, error: ProtocolError, notify = false): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.failure = error;
  this.#clearPending(pending);
  if (notify) {
   try {
    pending.sendError?.(error);
   } catch (reportError) {
    this.#report(pending, reportError);
   }
  }
  pending.reject(error);
 }

 #clearPending(pending: PendingChat): void {
  if (this.#pending === pending) this.#pending = undefined;
  if (pending.timer !== undefined) {
   try {
    this.#omp.clearTimer(pending.ctx, pending.timer);
   } catch {
    // Best-effort timer cleanup.
   }
   pending.timer = undefined;
  }
  pending.removeCallerAbort?.();
  pending.removeCallerAbort = undefined;
 }

 async #record(
  request: ChatRequest,
  config: Config,
  outcome: "ok" | ErrorCode,
  reply: string | undefined,
  usage: Usage | undefined,
  model: ModelRef | undefined,
  durationMs: number,
  consent: string | undefined,
 ): Promise<void> {
  const audit: AuditEvent = {
   event: "chat",
   id: request.requestId,
   from: { agent: request.from.agent, sessionId: request.from.sessionId },
   to: { sessionId: request.sessionId },
   project: request.project,
   // Hash/size what was received, as consult does; content (if enabled) is redacted by appendAudit.
   question: request.body.message,
   durationMs,
   outcome,
  };
  if (consent !== undefined) audit.consent = consent;
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
   this.#reportRequest(request, error);
  }
 }
}

/**
 * The chat body owns the overall timeout, so no consent dialog outlives it;
 * `consentMs` is what the paged consent left for this dialog. The smaller
 * remaining bound wins.
 */
function dialogTimeout(pending: PendingChat, consentMs: number): number {
 const overall = pending.startedAt + pending.timeoutMs - Date.now();
 return Math.max(1, Math.min(overall, consentMs));
}
