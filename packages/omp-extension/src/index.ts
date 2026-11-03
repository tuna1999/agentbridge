/**
 * @agentbridge/omp-extension entry point. Spec: 01 §7.1–§7.7.
 *
 * The factory performs no I/O: it only registers event handlers and the
 * `/agentbridge` command. All lifecycle work starts from `session_start`;
 * `runEphemeralTurn` is only reached from the IPC request callback.
 */
import packageJson from "../package.json";
import { AUTOCHAT_FLAG } from "./autochat";
import { agentbridgeArgumentCompletions } from "./completions";
import { Host } from "./lifecycle";
import { EXTENSION_TEXT } from "./messages";
import {
 type OmpAgentEndLike,
 type OmpContextLike,
 type OmpMessageEndLike,
 type OmpMessageStartLike,
 type OmpMessageUpdateLike,
 type PiLike,
 createOmpLike,
} from "./omp";

export { Host } from "./lifecycle";
export type { HostOptions, HostSnapshot } from "./lifecycle";
export {
 ChatManager,
 buildChatFrame,
 CHAT_CONSENT_OPTIONS,
 CHAT_CONSENT_TITLE,
 CHAT_DENY_OPTION,
 CHAT_NEXT_PAGE_OPTION,
 CHAT_SEND_OPTION,
 CHAT_VIEW_FULL_OPTION,
 paginateChatText,
} from "./chat";
export type { ChatRequest } from "./chat";
export {
 AUTOCHAT_FLAG,
 AUTOCHAT_LIMITED_MAX_MINUTES,
 AUTO_UNLIMITED_WARNING,
 AutoChatSession,
 DEFAULT_AUTO_CHAT_LIMITS,
 MANUAL_CONSENT,
 autoConsentReason,
 autoConfigEnabledMessage,
 autoConfigWarningMessage,
 autoLimitClampWarning,
 autoSentMessage,
 autoSourceLabel,
 bridgeStatusText,
 charCount,
 clampAutoChatLimits,
 inspectConfigAutoApprove,
 isAutoApproveMode,
 isPathInside,
 readAutoApproveFlag,
} from "./autochat";
export type {
 AutoApproval,
 AutoApproveSource,
 AutoChatLimits,
 AutoConfigInspection,
 FlagAutoApprove,
} from "./autochat";
export type {
 OmpAgentEndLike,
 OmpAgentMessageLike,
 OmpContextLike,
 OmpDialogOptions,
 OmpEphemeralResult,
 OmpEphemeralTurnOptions,
 OmpEphemeralUsage,
 OmpEventHandler,
 OmpEventName,
 OmpLike,
 OmpMessageEndLike,
 OmpMessageStartLike,
 OmpMessageUpdateLike,
 OmpSelectItem,
 OmpSelectOption,
 OmpSendUserMessageOptions,
 OmpTimer,
 OmpWidgetOptions,
 PiLike,
} from "./omp";
export { createOmpLike } from "./omp";

const EXTENSION_VERSION = packageJson.version;

export default function agentbridgeExtension(pi: PiLike): void {
 const host = new Host(createOmpLike(pi, EXTENSION_VERSION));

 // T12b: a session-start CLI override. Registered without a default so an
 // absent flag remains distinguishable from an explicit "off".
 try {
  pi.registerFlag?.(AUTOCHAT_FLAG, {
   description: EXTENSION_TEXT.autochatFlag,
   type: "string",
  });
 } catch {
  // Older hosts may not expose extension flags; config/TUI still work.
 }

 pi.on("session_start", async (_event, ctx) => {
  try {
   await host.publish(ctx, { snapshotAuto: true });
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("session_switch", async (_event, ctx) => {
  try {
   // Keep the autochat mode snapshotted at this OMP process's start.
   await host.publish(ctx, { snapshotAuto: false });
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("session_shutdown", () => {
  try {
   // 2 s budget: synchronous cleanup only.
   host.shutdownSync();
  } catch {
   // Never let shutdown failures escape into OMP.
  }
 });

 pi.on("agent_start", (_event, ctx) => {
  try {
   host.agentStart(ctx);
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("agent_end", (event, ctx) => {
  try {
   const end = event as OmpAgentEndLike; // OMP event boundary; fields are optional.
   host.agentEnd(ctx, end);
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("message_start", (event, ctx) => {
  try {
   const start = event as OmpMessageStartLike; // OMP event boundary; fields are optional.
   host.messageStart(ctx, start);
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("message_update", (event, ctx) => {
  try {
   const update = event as OmpMessageUpdateLike; // OMP event boundary; fields are optional.
   host.messageUpdate(ctx, update);
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("message_end", (event, ctx) => {
  try {
   const end = event as OmpMessageEndLike; // OMP event boundary; fields are optional.
   host.messageEnd(ctx, end);
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("tool_approval_requested", (_event, ctx) => {
  try {
   host.approvalRequested(ctx);
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.on("tool_approval_resolved", (_event, ctx) => {
  try {
   host.approvalResolved(ctx);
  } catch (error) {
   host.fail(ctx, error);
  }
 });

 pi.registerCommand("agentbridge", {
  description: EXTENSION_TEXT.command,
  getArgumentCompletions: agentbridgeArgumentCompletions,
  handler: async (args: string, ctx: OmpContextLike) => {
   try {
    await host.command(args, ctx);
   } catch (error) {
    host.fail(ctx, error);
   }
  },
 });
}
