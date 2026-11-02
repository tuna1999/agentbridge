/**
 * Shared harness for T9 integration tests.
 *
 * Everything runs inside one `mkdtemp`: HOME, the AgentBridge runtime/state
 * dirs, the config file and a throwaway git worktree. The OMP extension `Host`
 * is started in-process with a fake `ctx`; the real MCP server is spawned over
 * stdio with the MCP SDK client. `claude agents --json` is replaced by a shell
 * script placed first on PATH, so no real OMP, Claude or model call is made.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
 Host,
 createOmpLike,
 type OmpContextLike,
 type OmpEphemeralResult,
 type OmpEphemeralTurnOptions,
 type PiLike,
} from "../../packages/omp-extension/src/index";
import { writeRecord } from "../../packages/core/src/index";
import type { ModelRef } from "../../packages/protocol/src/index";
const MCP_ENTRY = join(import.meta.dir, "mcp-entry.ts");

export const PID_SESSION = "pid-session";
export const ENV_SESSION = "env-fallback-session";
export const FAKE_CLAUDE_LOG = "claude-calls.log";

const FAKE_CLAUDE = `#!/bin/sh
if [ -n "$AB_FAKE_CLAUDE_LOG" ]; then
	printf 'agents --json\\n' >> "$AB_FAKE_CLAUDE_LOG"
fi
printf '[{"pid": %s, "sessionId": "%s", "cwd": "%s"}]\\n' \\
	"$AB_FAKE_CLAUDE_PID" "$AB_FAKE_CLAUDE_SESSION" "$AB_FAKE_CLAUDE_CWD"
`;

export interface IntegrationEnv {
 root: string;
 home: string;
 runtimeDir: string;
 stateDir: string;
 configFile: string;
 worktree: string;
 binDir: string;
 /** Environment shared by the in-process host and the spawned MCP server. */
 vars: Record<string, string>;
 restore(): void;
}

/** Env keys the harness owns; used to restore the test process afterwards. */
const OWNED_KEYS = [
 "HOME",
 "PATH",
 "AGENTBRIDGE_HOME",
 "AGENTBRIDGE_RUNTIME_DIR",
 "AGENTBRIDGE_STATE_DIR",
 "AGENTBRIDGE_CONFIG",
 "AGENTBRIDGE_LOG",
 "CLAUDE_PROJECT_DIR",
 "CLAUDE_CODE_SESSION_ID",
 "AB_FAKE_CLAUDE_PID",
 "AB_FAKE_CLAUDE_SESSION",
 "AB_FAKE_CLAUDE_CWD",
 "AB_FAKE_CLAUDE_LOG",
] as const;

export function setupIntegrationEnv(): IntegrationEnv {
 const root = mkdtempSync(join(tmpdir(), "agentbridge-int-"));
 const home = join(root, "home");
 const runtimeDir = join(root, "run");
 const stateDir = join(root, "state");
 const worktree = join(root, "worktree");
 const binDir = join(root, "bin");
 const configFile = join(root, "config.json");
 for (const dir of [home, worktree, binDir, join(worktree, "src")]) {
  mkdirSync(dir, { recursive: true });
 }
 writeFileSync(join(worktree, "README.md"), "# agentbridge integration worktree\n");
 writeFileSync(join(worktree, "src", "app.ts"), "export const answer = 42;\n");

 // Best-effort: without git the host falls back to cwd, which is still the allowlisted project.
 try {
  Bun.spawnSync(["git", "init", "-q", worktree], { stdout: "ignore", stderr: "ignore" });
 } catch {
  // git is optional for these scenarios
 }

 const config = {
  version: 1,
  projects: [realpathSync(worktree)],
  allowFrom: ["claude-code"],
  consult: {
   consent: "always",
   consentTimeoutMs: 60_000,
   maxQuestionBytes: 32_768,
   maxAttachmentBytes: 65_536,
   maxContextBytes: 1_048_576,
   replyMaxBytes: 32_768,
   maxTokens: 4_096,
   allowUncapped: false,
   ratePerMinute: 120,
   toolsOff: true,
  },
  audit: { content: false, maxBytes: 5_242_880 },
  chat: { enabled: true, queueWhenBusy: false, consentTimeoutMs: 60_000 },
 };
 writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });

 const fakeClaude = join(binDir, "claude");
 writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });

 const vars: Record<string, string> = {
  HOME: home,
  PATH: `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  AGENTBRIDGE_HOME: join(home, ".agentbridge"),
  AGENTBRIDGE_RUNTIME_DIR: runtimeDir,
  AGENTBRIDGE_STATE_DIR: stateDir,
  AGENTBRIDGE_CONFIG: configFile,
  AGENTBRIDGE_LOG: join(root, "mcp.log"),
  CLAUDE_PROJECT_DIR: worktree,
  // Different from the fake agent's sessionId: the pid path must win.
  CLAUDE_CODE_SESSION_ID: ENV_SESSION,
  AB_FAKE_CLAUDE_PID: String(process.pid),
  AB_FAKE_CLAUDE_SESSION: PID_SESSION,
  AB_FAKE_CLAUDE_CWD: worktree,
  AB_FAKE_CLAUDE_LOG: join(root, FAKE_CLAUDE_LOG),
 };

 const saved = new Map<string, string | undefined>();
 for (const key of OWNED_KEYS) saved.set(key, process.env[key]);
 for (const [key, value] of Object.entries(vars)) process.env[key] = value;

 return {
  root,
  home,
  runtimeDir,
  stateDir,
  configFile,
  worktree,
  binDir,
  vars,
  restore() {
   for (const key of OWNED_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
   }
   rmSync(root, { recursive: true, force: true });
  },
 };
}

export interface FakeTurn {
 /** Streamed in order; each chunk goes through the host's delta redactor. */
 deltas: string[];
 replyText: string;
 /** Reproduces a provider that pauses between chunks (progress throttle). */
 delayBetweenDeltasMs?: number;
}

export interface FakeHost {
 host: Host;
 ctx: OmpContextLike;
 runCalls: OmpEphemeralTurnOptions[];
 notifications: string[];
 /** Frames passed to the fake `pi.sendUserMessage`, in order. */
 sentChats: string[];
 publish(): Promise<void>;
 shutdown(): void;
}

export interface FakeChatReply {
 replyText: string;
 deltas?: string[];
 /** Emit a non-terminal agent_end before the terminal one. */
 willContinueFirst?: boolean;
}

const FAKE_PI_BASE: PiLike = {
 on() {
  // The Host is driven directly; no extension event wiring is needed here.
 },
 registerCommand() {
  // No command surface is exercised by these scenarios.
 },
};

// The Host runs in-process and would otherwise share `process.pid` with the
// fake `claude agents` pid, making every request look like an OMP self-target.
// A synthetic OMP pid models the separate processes production actually has.
const INTEGRATION_OMP_PID = 2_000_000_000;

export function createFakeHost(options: {
 sessionId: string;
 cwd: string;
 turn: FakeTurn;
 model?: ModelRef;
 chatReply?: FakeChatReply;
}): FakeHost {
 const model = options.model ?? { provider: "openai", id: "gpt-int" };
 const runCalls: OmpEphemeralTurnOptions[] = [];
 const notifications: string[] = [];
 const sentChats: string[] = [];
 const chatReply = options.chatReply ?? { replyText: "Đã nhận tin nhắn.\nTôi sẽ kiểm tra." };
 let host: Host | undefined;
 const ctx: OmpContextLike = {
  ui: {
   setStatus() {
    // Status bar text is not asserted here.
   },
   notify(message) {
    notifications.push(message);
   },
   async select() {
    return "Gửi";
   },
  },
  mode: "tui",
  hasUI: true,
  cwd: options.cwd,
  agent: { kind: "main" },
  model,
  sessionManager: { getSessionId: () => options.sessionId },
  isIdle: () => true,
  hasPendingMessages: () => false,
  setInterval: () => 1,
  setTimeout: (callback, ms) => {
   const timer = setTimeout(callback, ms);
   timer.unref?.();
   return timer;
  },
  clearTimer: () => undefined,
  async runEphemeralTurn(turnOptions): Promise<OmpEphemeralResult> {
   runCalls.push(turnOptions);
   const total = options.turn.deltas.length;
   for (let index = 0; index < total; index += 1) {
    const delta = options.turn.deltas[index];
    if (delta !== undefined) await turnOptions.onTextDelta?.(delta);
    if (options.turn.delayBetweenDeltasMs !== undefined && index < total - 1) {
     await new Promise<void>((resolve) => setTimeout(resolve, options.turn.delayBetweenDeltasMs));
    }
   }
   return {
    replyText: options.turn.replyText,
    assistantMessage: { usage: { input: 12, output: 4 } },
   };
  },
 };
 const assistantMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  usage: { input: 12, output: 4 },
 });
 const pi: PiLike = {
  ...FAKE_PI_BASE,
  sendUserMessage(content: string) {
   sentChats.push(content);
   queueMicrotask(() => {
    if (host === undefined) return;
    const frame = { role: "user", content };
    host.messageStart(ctx, { message: frame });
    for (const delta of chatReply.deltas ?? []) {
     host.messageUpdate(ctx, {
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta },
     });
    }
    if (chatReply.willContinueFirst === true) {
     host.agentEnd(ctx, {
      willContinue: true,
      messages: [frame, assistantMessage("(đang tiếp tục)")],
     });
    }
    host.agentEnd(ctx, {
     willContinue: false,
     messages: [frame, assistantMessage(chatReply.replyText)],
    });
   });
  },
 };
 const created = new Host(createOmpLike(pi, "integration"), {
  selfPid: INTEGRATION_OMP_PID,
  readParentPid: async () => undefined,
 });
 host = created;
 return {
  host: created,
  ctx,
  runCalls,
  notifications,
  sentChats,
  publish: () => created.publish(ctx),
  shutdown: () => created.shutdownSync(),
 };
}

export interface RecordFile extends Record<string, unknown> {
 endpoint: string;
 sessionId: string;
 instanceId: string;
 tokenFile: string;
 pid: number;
 procStart: string;
}

export function sessionDir(env: IntegrationEnv): string {
 return join(env.runtimeDir, "sessions");
}

export function readRecord(env: IntegrationEnv, sessionId: string): RecordFile {
 return JSON.parse(readFileSync(join(sessionDir(env), `omp-${sessionId}.json`), "utf8")) as RecordFile;
}

export function readToken(env: IntegrationEnv, record: RecordFile): string {
 return readFileSync(join(sessionDir(env), record.tokenFile), "utf8").trim();
}

/**
 * Simulate a crashed host: its record and token remain on disk, but the pid is
 * gone, so liveness must report `dead` without a hello round-trip.
 */
export async function simulateCrash(record: RecordFile, token: string): Promise<void> {
 const dead = { ...record, pid: 2_147_483_647, procStart: "unknown", status: "idle" };
 await writeRecord(dead as unknown as Parameters<typeof writeRecord>[0], token);
}

export interface McpConnection {
 client: Client;
 list(scope?: "worktree" | "repo" | "all"): Promise<CallToolResult>;
 consult(
  args: Record<string, unknown>,
  onProgress?: (message: string) => void,
 ): Promise<CallToolResult>;
 chat(
  args: Record<string, unknown>,
  onProgress?: (message: string) => void,
 ): Promise<CallToolResult>;
 stderr(): string;
 close(): Promise<void>;
}

export function resultText(result: CallToolResult): string {
 return result.content
  .map((item) => (item.type === "text" ? item.text : ""))
  .join("\n");
}

export async function connectMcp(env: IntegrationEnv): Promise<McpConnection> {
 const transport = new StdioClientTransport({
  command: process.execPath,
  args: [MCP_ENTRY],
  env: env.vars,
  cwd: env.root,
  stderr: "pipe",
 });
 const chunks: Buffer[] = [];
 transport.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

 const client = new Client({ name: "agentbridge-integration", version: "0.0.0" });
 /**
  * Progress is captured through a notification handler, not through the SDK's
  * per-request `onprogress` callback. The SDK dispatches notifications in a
  * microtask (`Protocol._onnotification`) but processes responses
  * synchronously, deleting that request's progress handler in `_onresponse`.
  * When the final `notifications/progress` and the tool response arrive in one
  * stdout chunk, the notification is then discarded as "unknown token". A
  * registered handler has no per-request lifetime, so it sees every
  * notification regardless of chunking.
  */
 const progressListeners = new Set<(message: string) => void>();
 client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
  const message = notification.params.message;
  if (typeof message !== "string") return;
  for (const listener of progressListeners) listener(message);
 });
 await client.connect(transport);

 const call = async (
  name: string,
  args: Record<string, unknown>,
  onProgress?: (message: string) => void,
 ): Promise<CallToolResult> => {
  if (onProgress !== undefined) progressListeners.add(onProgress);
  try {
   return (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 30_000,
    // The SDK attaches `_meta.progressToken` only when `onprogress` is set;
    // the notifications themselves are captured by the handler above.
    onprogress: () => {
     // Intentionally empty.
    },
   })) as CallToolResult;
  } finally {
   if (onProgress !== undefined) progressListeners.delete(onProgress);
  }
 };

 return {
  client,
  list: (scope = "repo") => call("agent_list", { scope }),
  consult: (args, onProgress) => call("agent_consult", args, onProgress),
  chat: (args, onProgress) => call("agent_chat", args, onProgress),
  stderr: () => Buffer.concat(chunks).toString("utf8"),
  close: async () => {
   await client.close();
  },
 };
}

export function auditLines(env: IntegrationEnv): Array<Record<string, unknown>> {
 try {
  return readFileSync(join(env.stateDir, "audit.jsonl"), "utf8")
   .split("\n")
   .filter((line) => line.length > 0)
   .map((line) => JSON.parse(line) as Record<string, unknown>);
 } catch {
  return [];
 }
}
