/**
 * Thin adapter over the OMP extension surface (spec 01 §7.1).
 *
 * Every member here maps to an API verified in `references/extension-types.v18.14.0.ts.txt`.
 * `Host` depends only on this interface, so tests can drive it with a fake `pi`/`ctx`
 * without loading OMP. Accessors are defensive: a host mismatch must never crash OMP.
 */
import type { ModelRef } from "@agentbridge/protocol";
import type { CompletionItem } from "./completions";

export type OmpTimer = unknown;
export type OmpUiMessageType = "info" | "warning" | "error";

/** types.ts:551-568 `ExtensionAgentIdentity` (only `kind` is used). */
export interface OmpAgentIdentityLike {
 kind?: string;
}

/** Model is `@oh-my-pi/pi-ai`'s `Model`; this is the subset AgentBridge reads. */
export interface OmpModelLike {
 provider?: unknown;
 id?: unknown;
}

/** types.ts:522-540 `ExtensionModelQuery` (subset). */
export interface OmpModelsLike {
 current?(): OmpModelLike | undefined;
}

/** types.ts:158-163 `ExtensionUISelectOption`; `select` accepts strings too. */
export interface OmpSelectOption {
 label: string;
 description?: string;
}
export type OmpSelectItem = string | OmpSelectOption;

/** types.ts:207-... `ExtensionUIDialogOptions` (subset). */
export interface OmpDialogOptions {
 signal?: AbortSignal;
 timeout?: number;
}

/** types.ts:253-257 `ExtensionWidgetOptions` (subset). */
export interface OmpWidgetOptions {
 placement?: "aboveEditor" | "belowEditor";
}

/** CA/session/agent-session-types.ts:622 `EphemeralTurnOptions` (subset). */
export interface OmpEphemeralTurnOptions {
 promptText: string;
 tools?: false;
 maxTokens?: number;
 maxContextBytes?: number;
 onTextDelta?: (delta: string) => void | Promise<void>;
 signal?: AbortSignal;
 dedupeReply?: boolean;
 replyMaxBytes?: number;
}

/** `AssistantMessage.usage` subset (CA/session/agent-session-types.ts). */
export interface OmpEphemeralUsage {
 input?: number;
 output?: number;
 cacheRead?: number;
 cacheWrite?: number;
 cost?: number;
}

/** CA/session/agent-session-types.ts `EphemeralTurnResult` (subset). */
export interface OmpEphemeralResult {
 replyText: string;
 assistantMessage?: { usage?: OmpEphemeralUsage };
}

/**
 * `SendUserMessageOptions` subset (agent-session-types.d.ts:485-490; the pinned
 * v18.14.0 reference imports the type at extension-types...:94 and documents
 * delivery in extensions.md:326-331). T12 never passes "steer".
 */
export interface OmpSendUserMessageOptions {
 deliverAs?: "followUp";
 attribution?: "agent";
}

/** `AgentMessage` subset (pi-ai types.d.ts:947-963, 1020-1065). */
export interface OmpAgentMessageLike {
 role?: unknown;
 content?: unknown;
 usage?: OmpEphemeralUsage;
 stopReason?: unknown;
 errorMessage?: unknown;
}

/** `AgentEndEvent` (shared-events.d.ts:166-174; re-exported at extension-types...:1189). */
export interface OmpAgentEndLike {
 willContinue?: unknown;
 messages?: unknown;
}

/** `MessageStartEvent` / `MessageEndEvent` (extension-types...:1197-1219). */
export interface OmpMessageStartLike {
 message?: unknown;
}

export interface OmpMessageUpdateLike {
 message?: unknown;
 /** `AssistantMessageEvent` (pi-ai types.d.ts:1385-1397); only `text_delta` is read. */
 assistantMessageEvent?: { type?: unknown; delta?: unknown };
}

export interface OmpMessageEndLike {
 message?: unknown;
}

/** types.ts:746-762 `ExtensionContext` subset used by T6/T7/T12. */
export interface OmpContextLike {
 /** types.ts:748 */
 ui: {
  /** types.ts:377 */
  setStatus(key: string, text: string | undefined): void;
  /** types.ts:354 */
  notify(message: string, type?: OmpUiMessageType): void;
  /** types.ts:322-326 */
  select?(
   title: string,
   options: OmpSelectItem[],
   dialogOptions?: OmpDialogOptions,
  ): Promise<string | undefined>;
  /** types.ts:382-383; absent outside the interactive TUI (RPC/print). */
  setWidget?(key: string, content: string[] | undefined, options?: OmpWidgetOptions): void;
 };
 /** types.ts:750 */
 mode?: string;
 /** types.ts:758 */
 hasUI?: boolean;
 /** types.ts:760 */
 cwd: string;
 /** types.ts:812 */
 agent?: OmpAgentIdentityLike;
 /** types.ts:768 */
 model?: OmpModelLike;
 /** types.ts:770 */
 models?: OmpModelsLike;
 /** types.ts:762 */
 sessionManager: {
  getSessionId(): string;
 };
 /** types.ts:772 */
 isIdle?: () => boolean;
 /** types.ts:776 */
 hasPendingMessages?: () => boolean;
 /** types.ts:851 */
 setInterval?: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => OmpTimer;
 /** types.ts:853-857 (isolated callback; cleared at session_shutdown). */
 setTimeout?: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => OmpTimer;
 /** types.ts:859 */
 clearTimer?: (timer: OmpTimer) => void;
 /** types.ts:830 (optional; presence selects the `consult` capability). */
 runEphemeralTurn?: (options: OmpEphemeralTurnOptions) => Promise<OmpEphemeralResult>;
}

/** `agent_end` payload subset (shared-events.d.ts:166-174; 01 §7.2). */
export type OmpEventName =
 | "session_start"
 | "session_switch"
 | "session_shutdown"
 | "agent_start"
 | "agent_end"
 | "message_start"
 | "message_update"
 | "message_end"
 | "tool_approval_requested"
 | "tool_approval_resolved";

export type OmpEventHandler = (event: unknown, ctx: OmpContextLike) => unknown;

/** types.ts:1795-2131 `ExtensionAPI` subset used by T6. */
export interface PiLike {
 /** types.ts:1820-1882 */
 on(event: OmpEventName, handler: OmpEventHandler): void;
 /** types.ts:1962-1969, handler at 1773 */
 registerCommand(
  name: string,
  options: {
   description?: string;
   /** extension-types.v18.14.0.ts.txt:1772; value replaces the whole argument text. */
   getArgumentCompletions?: (argumentPrefix: string) => CompletionItem[] | null;
   handler: (args: string, ctx: OmpContextLike) => Promise<void> | void;
  },
 ): void;
 /** types.ts:2104; feature-detected per spec 01 §7.1. */
 getSessionName?(): string | undefined;
 /** extension-types.v18.14.0.ts.txt:1980-1993. */
 registerFlag?(
  name: string,
  options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
 ): void;
 getFlag?(name: string): boolean | string | undefined;
 /**
  * extension-types.v18.14.0.ts.txt:2059-2062 (handler alias :2299-2302).
  * Programmatic sends do not emit `input` (extensions.md:550-553).
  */
 sendUserMessage?(content: string, options?: OmpSendUserMessageOptions): void;
}

/** Operations `Host` needs, independent of whether OMP is real or fake. */
export interface OmpLike {
 readonly extensionVersion: string;
 readonly agentVersion: string;
 getSessionName(): string | undefined;
 sessionId(ctx: OmpContextLike): string;
 cwd(ctx: OmpContextLike): string;
 isRootTui(ctx: OmpContextLike): boolean;
 model(ctx: OmpContextLike): ModelRef | undefined;
 isIdle(ctx: OmpContextLike): boolean;
 hasPendingMessages(ctx: OmpContextLike): boolean;
 setStatus(ctx: OmpContextLike, text: string | undefined): void;
 /** Display-only widget; `undefined` removes it. Best-effort and non-throwing. */
 setWidget(ctx: OmpContextLike, lines: string[] | undefined): void;
 notify(ctx: OmpContextLike, message: string, type?: OmpUiMessageType): void;
 select(
  ctx: OmpContextLike,
  title: string,
  options: OmpSelectItem[],
  dialogOptions?: OmpDialogOptions,
 ): Promise<string | undefined>;
 runEphemeralTurn(ctx: OmpContextLike, options: OmpEphemeralTurnOptions): Promise<OmpEphemeralResult>;
 setInterval(ctx: OmpContextLike, callback: () => void, ms: number): OmpTimer;
 setTimeout(ctx: OmpContextLike, callback: () => void, ms: number): OmpTimer;
 clearTimer(ctx: OmpContextLike, timer: OmpTimer): void;
 supportsConsult(ctx: OmpContextLike): boolean;
 /** True when `pi.sendUserMessage` exists (chat cannot work without it). */
 supportsChat(): boolean;
 /** Registered extension CLI flag value; undefined when the host has no flag API. */
 getFlag?(name: string): boolean | string | undefined;
 /** Relay text into the OMP transcript. Never passes `deliverAs: "steer"`. */
 sendUserMessage(ctx: OmpContextLike, text: string, options?: OmpSendUserMessageOptions): void;
}

function errorMessage(error: unknown): string {
 return error instanceof Error ? error.message : String(error);
}

function modelOf(value: OmpModelLike | undefined): ModelRef | undefined {
 if (value === undefined) return undefined;
 const { provider, id } = value;
 if (typeof provider !== "string" || provider.length === 0) return undefined;
 if (typeof id !== "string" || id.length === 0) return undefined;
 return { provider, id };
}

/** Build the production adapter. No OMP call happens until a method is invoked. */
export function createOmpLike(pi: PiLike, extensionVersion: string): OmpLike {
 return {
  extensionVersion,
  // No version API is exposed by the pinned extension surface (01 §3.1 allows "unknown").
  agentVersion: "unknown",
  getSessionName(): string | undefined {
   try {
    return typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined;
   } catch {
    return undefined;
   }
  },
  sessionId(ctx): string {
   return ctx.sessionManager.getSessionId();
  },
  cwd(ctx): string {
   return ctx.cwd;
  },
  isRootTui(ctx): boolean {
   try {
    return ctx.agent?.kind === "main" && ctx.hasUI === true && ctx.mode === "tui";
   } catch {
    return false;
   }
  },
  model(ctx): ModelRef | undefined {
   try {
    if (typeof ctx.models?.current === "function") {
     const current = modelOf(ctx.models.current());
     if (current !== undefined) return current;
    }
    return modelOf(ctx.model);
   } catch {
    return undefined;
   }
  },
  isIdle(ctx): boolean {
   try {
    return typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
   } catch {
    return true;
   }
  },
  hasPendingMessages(ctx): boolean {
   try {
    return typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
   } catch {
    return false;
   }
  },
  setStatus(ctx, text): void {
   try {
    ctx.ui.setStatus("agentbridge", text);
   } catch {
    // UI failures must not break hosting.
   }
  },
  setWidget(ctx, lines): void {
   try {
    // Absent in RPC/print mode; `undefined` is the documented removal value.
    if (typeof ctx.ui.setWidget !== "function") return;
    ctx.ui.setWidget("agentbridge", lines, { placement: "aboveEditor" });
   } catch {
    // The widget is display-only: a UI failure must not affect the consult.
   }
  },
  notify(ctx, message, type): void {
   try {
    ctx.ui.notify(message, type);
   } catch {
    // Notifications are best-effort.
   }
  },
  async select(ctx, title, options, dialogOptions) {
   if (typeof ctx.ui.select !== "function") throw new Error("ctx.ui.select is unavailable");
   return ctx.ui.select(title, options, dialogOptions);
  },
  async runEphemeralTurn(ctx, options) {
   if (typeof ctx.runEphemeralTurn !== "function") {
    throw new Error("ctx.runEphemeralTurn is unavailable");
   }
   return ctx.runEphemeralTurn(options);
  },
  setInterval(ctx, callback, ms): OmpTimer {
   if (typeof ctx.setInterval !== "function") throw new Error("ctx.setInterval is unavailable");
   return ctx.setInterval(callback, ms);
  },
  setTimeout(ctx, callback, ms): OmpTimer {
   if (typeof ctx.setTimeout === "function") return ctx.setTimeout(callback, ms);
   // Older/fake contexts: still unref so a pending chat timer cannot keep OMP alive.
   const timer = setTimeout(callback, ms);
   timer.unref?.();
   return timer;
  },
  clearTimer(ctx, timer): void {
   try {
    if (timer === undefined) return;
    if (typeof ctx.clearTimer === "function") {
     ctx.clearTimer(timer);
     return;
    }
    clearTimeout(timer as ReturnType<typeof setTimeout>);
   } catch {
    // Timer cleanup is best-effort.
   }
  },
  supportsConsult(ctx): boolean {
   try {
    return typeof ctx.runEphemeralTurn === "function";
   } catch {
    return false;
   }
  },
  supportsChat(): boolean {
   try {
    return typeof pi.sendUserMessage === "function";
   } catch {
    return false;
   }
  },
  getFlag(name): boolean | string | undefined {
   try {
    return typeof pi.getFlag === "function" ? pi.getFlag(name) : undefined;
   } catch {
    return undefined;
   }
  },
  sendUserMessage(_ctx, text, options): void {
   if (typeof pi.sendUserMessage !== "function") {
    throw new Error("pi.sendUserMessage is unavailable");
   }
   pi.sendUserMessage(text, options);
  },
 };
}

export { errorMessage };
