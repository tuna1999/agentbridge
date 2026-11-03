/**
 * Session host for the AgentBridge OMP extension. Spec: 01 §7.2, §7.3 (status), §7.6.
 *
 * All OMP and filesystem work happens here; the factory only registers handlers.
 * Every callback that OMP (or the IPC server) can invoke is wrapped so a failure
 * is reported once and never escapes into the OMP process.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
 type Capability,
 type ChatBody,
 type ConsultBody,
 type Envelope,
 type ErrorBody,
 type GitInfo,
 HEARTBEAT_MS,
 type HelloResult,
 type ModelRef,
 newId,
 PROTOCOL_VERSION,
 type ProgressBody,
 ProtocolError,
 type StatusResult,
} from "@agentbridge/protocol";
import {
 type AutoApproveMode,
 type Config,
 DEFAULT_CONFIG,
 type RequestIO,
 type ServerHandle,
 type SessionRecord,
 appendAudit,
 ensureRuntimeDirs,
 endpointFor,
 getParentPid,
 getProcStart,
 gitInfo,
 loadConfig,
 removeRecord,
 resolveDirs,
 sweepStale,
 startServer,
 writeRecord,
} from "@agentbridge/core";
import { ChatManager } from "./chat";
import {
 AUTOCHAT_FLAG,
 AUTOCHAT_LIMITED_MAX_MINUTES,
 AUTO_UNLIMITED_WARNING,
 AutoChatSession,
 type AutoChatLimits,
 autoConfigEnabledMessage,
 autoConfigWarningMessage,
 autoLimitClampWarning,
 autoSentMessage,
 autoSourceLabel,
 bridgeStatusText,
 clampAutoChatLimits,
 inspectConfigAutoApprove,
 isAutoApproveMode,
 readAutoApproveFlag,
} from "./autochat";
import { ConsultManager, projectAllowed } from "./consult";
import {
 type ConfigInspection,
 type ProjectAction,
 type ProjectChangeResult,
 changeProjectConfig,
 inspectConfig,
} from "./project-config";
import { HOST_TEXT } from "./messages";
import { isSelfTarget } from "./self-target";
import {
 type OmpAgentEndLike,
 type OmpContextLike,
 type OmpLike,
 type OmpMessageEndLike,
 type OmpMessageStartLike,
 type OmpMessageUpdateLike,
 type OmpTimer,
 errorMessage,
} from "./omp";

/** §7.2: the record is rewritten on a heartbeat only when status/model changed or 60 s elapsed. */
const RECORD_REFRESH_MS = 60_000;
/** TUI confirm dialog budget for allow/disallow; no config setting is added. */
const PROJECT_CONFIRM_TIMEOUT_MS = 60_000;
/** Session names are written to the record; keep them well below the registry bound. */
const MAX_SESSION_NAME_CHARS = 256;

type AgentStatus = "idle" | "busy" | "waiting";

interface ActiveSession {
 ctx: OmpContextLike;
 sessionId: string;
 sessionName?: string;
 instanceId: string;
 agentVersion: string;
 extensionVersion: string;
 token: string;
 endpoint: string;
 tokenFile: string;
 tokenPath: string;
 recordFile: string;
 socketFile: string;
 cwd: string;
 procStart: string;
 git?: GitInfo;
 model?: ModelRef;
 capabilities: Capability[];
 status: AgentStatus;
 startedAt: number;
 heartbeatAt: number;
 lastWriteAt: number;
 lastWrittenStatus: AgentStatus;
 lastWrittenModel?: ModelRef;
 lastWrittenCapabilities: Capability[];
 timer?: OmpTimer;
 server?: ServerHandle;
 requests: number;
}

export interface HostSnapshot {
 instanceId: string;
 sessionId: string;
 endpoint: string;
 cwd: string;
 git?: GitInfo;
 model?: ModelRef;
 status: AgentStatus;
 capabilities: Capability[];
 requests: number;
}

function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
 if (a === undefined || b === undefined) return a === b;
 return a.provider === b.provider && a.id === b.id;
}

function sameCapabilities(a: readonly Capability[], b: readonly Capability[]): boolean {
 return a.length === b.length && a.every((capability, index) => capability === b[index]);
}

/**
 * T12: advertise `chat` only while `chat.enabled` and `pi.sendUserMessage`
 * exists. `consult` keeps its existing feature detection.
 */
function capabilitiesFor(omp: OmpLike, ctx: OmpContextLike, config: Config): Capability[] {
 const capabilities: Capability[] = ["status"];
 if (omp.supportsConsult(ctx)) capabilities.push("consult");
 if (config.chat.enabled && omp.supportsChat()) capabilities.push("chat");
 return capabilities;
}

function socketFileOf(endpoint: string): string {
 return endpoint.startsWith("unix:") ? endpoint.slice("unix:".length) : endpoint;
}

async function canonicalCwd(cwd: string): Promise<string> {
 try {
  return await realpath(cwd);
 } catch {
  return resolve(cwd);
 }
}

function recordOf(active: ActiveSession): SessionRecord {
 const record: SessionRecord = {
  schema: "agentbridge.session/1",
  agent: "omp",
  agentVersion: active.agentVersion,
  extensionVersion: active.extensionVersion,
  instanceId: active.instanceId,
  sessionId: active.sessionId,
  pid: process.pid,
  procStart: active.procStart,
  cwd: active.cwd,
  status: active.status,
  capabilities: active.capabilities,
  endpoint: active.endpoint,
  tokenFile: active.tokenFile,
  startedAt: active.startedAt,
  heartbeatAt: active.heartbeatAt,
 };
 if (active.sessionName !== undefined) record.sessionName = active.sessionName;
 if (active.git !== undefined) record.git = active.git;
 if (active.model !== undefined) record.model = active.model;
 return record;
}

function resultEnvelope<T>(active: ActiveSession, replyTo: string, body: T): Envelope<"result", T> {
 return {
  v: PROTOCOL_VERSION,
  id: newId(),
  type: "result",
  replyTo,
  from: { agent: "omp", sessionId: active.sessionId },
  ts: Date.now(),
  hop: 0,
  body,
 };
}

function progressEnvelope(
 active: ActiveSession,
 replyTo: string,
 body: ProgressBody,
): Envelope<"progress", ProgressBody> {
 return {
  v: PROTOCOL_VERSION,
  id: newId(),
  type: "progress",
  replyTo,
  from: { agent: "omp", sessionId: active.sessionId },
  ts: Date.now(),
  hop: 0,
  body,
 };
}

function errorEnvelope(
 active: ActiveSession,
 replyTo: string,
 error: ProtocolError,
): Envelope<"error", ErrorBody> {
 return {
  v: PROTOCOL_VERSION,
  id: newId(),
  type: "error",
  replyTo,
  from: { agent: "omp", sessionId: active.sessionId },
  ts: Date.now(),
  hop: 0,
  body: error.toBody(),
 };
}

/** Optional seams for tests and process inspection; raw pid readers are platform-specific. */
export interface HostOptions {
 /** Stale-session sweep used after publish; defaults to core `sweepStale`. */
 sweepStale?: () => Promise<number>;
 /** OMP process identity used for self-target rejection; defaults to `process.pid`. */
 selfPid?: number;
 /** Parent-pid reader used for ancestor walks; defaults to core `getParentPid`. */
 readParentPid?: (pid: number) => Promise<number | undefined>;
}

export class Host {
 readonly #omp: OmpLike;
 readonly #sweepStale: () => Promise<number>;
 readonly #selfPid: number;
 readonly #readParentPid: (pid: number) => Promise<number | undefined>;
 readonly #consult: ConsultManager;
 readonly #chat: ChatManager;
 readonly #auto = new AutoChatSession();
 readonly #agentVersion: string;
 readonly #extensionVersion: string;
 #active: ActiveSession | undefined;
 #enabled = true;
 #trusted = false;
 #warned = false;
 #generation = 0;
 #autoSnapshotTaken = false;
 #autoTuiMode: AutoApproveMode | undefined;
 #autoTimer?: OmpTimer;
 #autoTimerCtx?: OmpContextLike;
 #autoTimerEpoch = 0;
 #autoLimitWarned = false;
 #queue: Promise<void> = Promise.resolve();

 constructor(omp: OmpLike, options: HostOptions = {}) {
  this.#omp = omp;
  this.#sweepStale = options.sweepStale ?? sweepStale;
  this.#selfPid = options.selfPid ?? process.pid;
  this.#readParentPid = options.readParentPid ?? getParentPid;
  this.#consult = new ConsultManager(omp);
  this.#chat = new ChatManager(omp);
  this.#agentVersion = omp.agentVersion;
  this.#extensionVersion = omp.extensionVersion;
 }

 snapshot(): HostSnapshot | undefined {
  const active = this.#active;
  if (active === undefined) return undefined;
  const snapshot: HostSnapshot = {
   instanceId: active.instanceId,
   sessionId: active.sessionId,
   endpoint: active.endpoint,
   cwd: active.cwd,
   status: active.status,
   capabilities: [...active.capabilities],
   requests: active.requests,
  };
  if (active.git !== undefined) snapshot.git = active.git;
  if (active.model !== undefined) snapshot.model = active.model;
  return snapshot;
 }

 isTrusted(): boolean {
  return this.#trusted;
 }

 /**
  * Root TUI only; a new instanceId, token, endpoint and record each time.
  * `snapshotAuto` is true only for `session_start`; `session_switch` keeps the
  * autochat mode read when the OMP process started.
  */
 publish(ctx: OmpContextLike, options: { snapshotAuto?: boolean } = {}): Promise<void> {
  return this.#enqueue(async () => {
   // A start/switch belongs to a new OMP session: drop any widget or
   // pending chat left behind.
   this.#chat.cancelAll("session switched");
   this.#consult.clearWidget();
   if (!this.#omp.isRootTui(ctx)) return;

   // A start/switch begins a new OMP session; §7.6 trust is session-only,
   // so it resets even while the server is off.
   this.#trusted = false;
   if (options.snapshotAuto !== false) await this.#snapshotAutoChat(ctx);
   if (!this.#enabled) return;

   this.#generation += 1;
   const generation = this.#generation;

   await this.#stop();
   if (generation !== this.#generation || !this.#enabled) return;

   try {
    await this.#start(ctx, generation);
   } catch (error) {
    if (generation === this.#generation) this.#enabled = false;
    this.notifyError(ctx, error);
   }
  });
 }

 /** `/agentbridge off`: stop the server and remove the record, but keep the extension loaded. */
 pause(ctx: OmpContextLike): Promise<void> {
  return this.#enqueue(async () => {
   this.#enabled = false;
   this.#generation += 1;
   this.#chat.cancelAll("bridge paused");
   this.#consult.clearWidget(ctx);
   await this.#stop();
   this.#omp.setStatus(ctx, undefined);
  });
 }

 /** `/agentbridge on`: republish when this is a root TUI session. */
 resume(ctx: OmpContextLike): Promise<void> {
  return this.#enqueue(async () => {
   this.#enabled = true;
   this.#generation += 1;
   const generation = this.#generation;
   if (!this.#omp.isRootTui(ctx)) return;
   try {
    await this.#start(ctx, generation);
   } catch (error) {
    if (generation === this.#generation) this.#enabled = false;
    this.notifyError(ctx, error);
   }
  });
 }

 agentStart(ctx: OmpContextLike): void {
  this.#setStatus(ctx, "busy");
 }

 agentEnd(ctx: OmpContextLike, event: OmpAgentEndLike): void {
  this.#chat.agentEnd(ctx, event);
  if (event.willContinue === true) return;
  this.#setStatus(ctx, "idle");
 }

 messageStart(ctx: OmpContextLike, event: OmpMessageStartLike): void {
  this.#chat.messageStart(ctx, event);
 }

 messageUpdate(ctx: OmpContextLike, event: OmpMessageUpdateLike): void {
  this.#chat.messageUpdate(ctx, event);
 }

 messageEnd(ctx: OmpContextLike, event: OmpMessageEndLike): void {
  this.#chat.messageEnd(ctx, event);
 }

 approvalRequested(ctx: OmpContextLike): void {
  this.#setStatus(ctx, "waiting");
 }

 approvalResolved(ctx: OmpContextLike): void {
  this.#setStatus(ctx, "busy");
 }

 /**
  * §7.2 cleanup at `session_shutdown` uses synchronous operations only: the handler
  * budget is 2 s and the process may exit immediately afterwards. The socket close is
  * started synchronously; record/token/socket removal is sync.
  */
 shutdownSync(): void {
  this.#enabled = false;
  this.#generation += 1;
  this.#chat.cancelAll("session shut down");
  this.#clearAutoTimer();
  this.#auto.reset();
  this.#autoSnapshotTaken = false;
  this.#autoTuiMode = undefined;
  this.#autoLimitWarned = false;
  const active = this.#active;
  this.#active = undefined;
  this.#consult.clearWidget(active?.ctx);
  if (active === undefined) return;

  this.#omp.clearTimer(active.ctx, active.timer);

  try {
   void active.server?.close().catch(() => undefined);
  } catch {
   // ignore
  }

  this.#removeOwnRecordSync(active);
  try {
   rmSync(active.socketFile, { force: true });
  } catch {
   // socket file may already be gone
  }
  this.#omp.setStatus(active.ctx, undefined);
 }

 /** All config-mutating commands are main-TUI only; subagents never write. */
 async #requireMainTui(ctx: OmpContextLike, commandName: string): Promise<boolean> {
  if (this.#omp.isRootTui(ctx)) return true;
  this.#omp.notify(
   ctx,
   HOST_TEXT.mainTuiOnly(commandName),
   "warning",
  );
  return false;
 }

 /** Compute the current session project live from ctx; never use a stale active record. */
 async #currentProject(ctx: OmpContextLike): Promise<string> {
  const cwd = this.#omp.cwd(ctx);
  let candidate = cwd;
  try {
   candidate = (await gitInfo(cwd))?.worktree ?? cwd;
  } catch {
   candidate = cwd;
  }
  try {
   return await realpath(candidate);
  } catch {
   return resolve(candidate);
  }
 }

 async #confirmProjectChange(
  ctx: OmpContextLike,
  action: ProjectAction,
  project: string,
 ): Promise<boolean> {
  const label = HOST_TEXT.projectActionLabel(action);
  let answer: string | undefined;
  try {
   answer = await this.#omp.select(
    ctx,
    HOST_TEXT.projectConfirmTitle(action, label, project),
    [HOST_TEXT.refuse, HOST_TEXT.agree],
    // "Từ chối" first and highlighted: a timeout (adapter → undefined), a host
    // that auto-picks the first item, or a reflexive Enter changes nothing.
    { timeout: PROJECT_CONFIRM_TIMEOUT_MS, initialIndex: 0 },
   );
  } catch {
   this.#omp.notify(ctx, HOST_TEXT.confirmUnavailable, "warning");
   return false;
  }
  if (answer !== HOST_TEXT.agree) {
   this.#omp.notify(ctx, HOST_TEXT.confirmCancelled, "info");
   return false;
  }
  return true;
 }

 async #changeProject(action: ProjectAction, ctx: OmpContextLike): Promise<void> {
  if (!(await this.#requireMainTui(ctx, action))) return;
  const project = await this.#currentProject(ctx);
  if (!(await this.#confirmProjectChange(ctx, action, project))) return;

  const dirs = resolveDirs();
  let result: ProjectChangeResult;
  try {
   result = await changeProjectConfig({
    action,
    project,
    configPath: dirs.configFile,
    homeDir: dirs.homeDir,
   });
  } catch (error) {
   this.#omp.notify(
    ctx,
    HOST_TEXT.configWriteFailed(dirs.configFile, errorMessage(error)),
    "warning",
   );
   return;
  }

  switch (result.kind) {
   case "changed":
    this.#omp.notify(
     ctx,
     action === "allow"
      ? HOST_TEXT.projectAllowed(project)
      : HOST_TEXT.projectDisallowed(project),
     "info",
    );
    return;
   case "unchanged":
    this.#omp.notify(
     ctx,
     result.present
      ? HOST_TEXT.projectAlreadyListed(project)
      : HOST_TEXT.projectNotListed(project),
     "info",
    );
    return;
   case "invalid":
    this.#omp.notify(
     ctx,
     HOST_TEXT.configInvalidNoWrite(result.configPath, result.reason),
     "warning",
    );
    return;
   case "insecure":
    this.#omp.notify(
     ctx,
     HOST_TEXT.configInsecureNoWrite(result.configPath, result.reason),
     "warning",
    );
    return;
   case "config_inside_project":
    this.#omp.notify(
     ctx,
     HOST_TEXT.configInsideProject(result.project),
     "warning",
    );
    return;
   case "write_failed":
    this.#omp.notify(
     ctx,
     HOST_TEXT.configWriteFailed(result.configPath, result.reason),
     "warning",
    );
    return;
  }
 }

 /** Read-only config summary; missing/invalid files are reported, never repaired. */
 async #showConfig(ctx: OmpContextLike): Promise<void> {
  if (!(await this.#requireMainTui(ctx, "config"))) return;
  const dirs = resolveDirs();
  let inspected: ConfigInspection;
  try {
   inspected = await inspectConfig(dirs.configFile, { requireSecureMode: false });
  } catch (error) {
   this.#omp.notify(
    ctx,
    HOST_TEXT.configReadFailed(dirs.configFile, errorMessage(error)),
    "warning",
   );
   return;
  }

  switch (inspected.kind) {
   case "missing":
    this.#omp.notify(
     ctx,
     [
      HOST_TEXT.configMissingHeader(dirs.configFile),
      HOST_TEXT.projectsLine([]),
      `chat.enabled: ${String(DEFAULT_CONFIG.chat.enabled)}`,
      `chat.autoApprove: ${DEFAULT_CONFIG.chat.autoApprove}`,
     ].join("\n"),
     "info",
    );
    return;
   case "invalid":
    this.#omp.notify(
     ctx,
     HOST_TEXT.configInvalidNoWrite(dirs.configFile, inspected.reason),
     "warning",
    );
    return;
   case "insecure":
    this.#omp.notify(
     ctx,
     HOST_TEXT.configInsecure(dirs.configFile, inspected.reason),
     "warning",
    );
    return;
   case "ok": {
    this.#omp.notify(
     ctx,
     [
      HOST_TEXT.configHeader(dirs.configFile),
      HOST_TEXT.projectsLine(inspected.config.projects),
      `chat.enabled: ${String(inspected.config.chat.enabled)}`,
      `chat.autoApprove: ${inspected.config.chat.autoApprove}`,
     ].join("\n"),
     "info",
    );
    return;
   }
  }
 }

 /** `/agentbridge status|trust|untrust|autochat|off|on|clear|allow|disallow|config`; trust is memory-only. */
 async command(args: string, ctx: OmpContextLike): Promise<void> {
  const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
  const arg = (parts[0] ?? "").toLowerCase();
  switch (arg) {
   case "":
   case "status":
    await this.#showStatus(ctx);
    return;
   case "trust":
    this.#trusted = true;
    this.#omp.notify(ctx, HOST_TEXT.trusted, "info");
    return;
   case "untrust":
    this.#trusted = false;
    this.#omp.notify(ctx, HOST_TEXT.untrusted, "info");
    return;
   case "off":
    await this.pause(ctx);
    this.#omp.notify(ctx, HOST_TEXT.serverOff, "info");
    return;
   case "on":
    await this.resume(ctx);
    this.#omp.notify(ctx, HOST_TEXT.serverOn, "info");
    return;
   case "allow":
   case "disallow":
    await this.#changeProject(arg, ctx);
    return;
   case "config":
    await this.#showConfig(ctx);
    return;
   case "autochat": {
    const requested = (parts[1] ?? "").toLowerCase();
    if (requested.length === 0) {
     this.#omp.notify(
      ctx,
      HOST_TEXT.autochatState(this.#auto.mode, autoSourceLabel(this.#auto.source)),
      "info",
     );
     return;
    }
    if (!isAutoApproveMode(requested)) {
     this.#omp.notify(
      ctx,
      HOST_TEXT.autochatUsage,
      "warning",
     );
     return;
    }

    if (requested === "off") {
     this.#autoTuiMode = "off";
     this.#startAutoLimitTimer(ctx, undefined);
     this.#auto.configure("off", "tui");
     this.#refreshBridgeStatus(ctx);
     this.#omp.notify(ctx, HOST_TEXT.autochatOff, "info");
     return;
    }

    if (requested === "unlimited") {
     this.#autoTuiMode = "unlimited";
     this.#startAutoLimitTimer(ctx, undefined);
     this.#auto.configure("unlimited", "tui");
     this.#refreshBridgeStatus(ctx);
     this.#omp.notify(ctx, HOST_TEXT.autochatUnlimitedTui, "info");
     this.#notifyUnlimited(ctx);
     return;
    }

    // limited [phút]: omitted = no expiry; values above 480 are clamped.
    let minutes: number | undefined;
    const rawMinutes = parts[2];
    if (rawMinutes !== undefined) {
     const parsed = rawMinutes.match(/^\d+$/) === null ? Number.NaN : Number(rawMinutes);
     if (!Number.isInteger(parsed) || parsed <= 0) {
      this.#omp.notify(
       ctx,
       HOST_TEXT.autochatBadMinutes,
       "warning",
      );
      return;
     }
     minutes = parsed;
     if (minutes > AUTOCHAT_LIMITED_MAX_MINUTES) {
      minutes = AUTOCHAT_LIMITED_MAX_MINUTES;
      this.#omp.notify(
       ctx,
       HOST_TEXT.autochatMinutesClamped(AUTOCHAT_LIMITED_MAX_MINUTES),
       "warning",
      );
     }
    }

    const config = await loadConfig(resolveDirs().configFile, { fresh: true });
    const limits = this.#snapshotAutoLimits(ctx, config);
    this.#autoTuiMode = "limited";
    this.#auto.configure("limited", "tui", { limits, resetQuota: true });
    this.#startAutoLimitTimer(ctx, minutes);
    this.#refreshBridgeStatus(ctx);
    this.#omp.notify(
     ctx,
     HOST_TEXT.autochatLimitedTui(minutes),
     "info",
    );
    return;
   }
   case "clear":
    this.#consult.clearWidget(ctx);
    this.#omp.notify(ctx, HOST_TEXT.widgetCleared, "info");
    return;
   default:
    this.#omp.notify(
     ctx,
     HOST_TEXT.commandUsage,
     "warning",
    );
  }
 }

 /** One heartbeat: reconcile status/capabilities, then rewrite the record if changed or 60 s elapsed. */
 async heartbeat(): Promise<void> {
  const active = this.#active;
  if (active === undefined) return;

  if (active.status !== "waiting") {
   active.status = this.#omp.isIdle(active.ctx) ? "idle" : "busy";
  }
  const config = await loadConfig();
  const capabilities = capabilitiesFor(this.#omp, active.ctx, config);
  const model = this.#omp.model(active.ctx);
  const now = Date.now();
  const statusChanged = active.status !== active.lastWrittenStatus;
  const modelChanged = !sameModel(model, active.lastWrittenModel);
  const capabilitiesChanged = !sameCapabilities(capabilities, active.lastWrittenCapabilities);
  if (!statusChanged && !modelChanged && !capabilitiesChanged && now - active.lastWriteAt < RECORD_REFRESH_MS) {
   return;
  }

  active.model = model;
  active.capabilities = capabilities;
  active.heartbeatAt = now;
  if (capabilitiesChanged) this.#setBridgeStatus(active);
  const record = recordOf(active);
  await writeRecord(record, active.token);
  if (this.#active !== active) {
   // A switch/shutdown landed while the write was in flight.
   await removeRecord(active.sessionId, active.instanceId).catch(() => undefined);
   return;
  }
  active.lastWrittenStatus = active.status;
  active.lastWrittenModel = model;
  active.lastWrittenCapabilities = [...capabilities];
  active.lastWriteAt = now;
 }

 /** Report the first failure for this extension instance; never throws. */
 notifyError(ctx: OmpContextLike, error: unknown): void {
  if (this.#warned) return;
  this.#warned = true;
  this.#omp.notify(ctx, HOST_TEXT.error(errorMessage(error)), "warning");
 }

 /** §7.2: warn once, then disable hosting without affecting OMP. */
 fail(ctx: OmpContextLike, error: unknown): void {
  this.notifyError(ctx, error);
  void this.pause(ctx).catch(() => undefined);
 }

 async #showStatus(ctx: OmpContextLike): Promise<void> {
  const active = this.#active;
  let sessionId = active?.sessionId;
  if (sessionId === undefined) {
   try {
    sessionId = this.#omp.sessionId(ctx);
   } catch {
    sessionId = "unknown";
   }
  }
  let cwd = active?.cwd;
  if (cwd === undefined) {
   try {
    cwd = await canonicalCwd(this.#omp.cwd(ctx));
   } catch {
    cwd = process.cwd();
   }
  }
  const config = await loadConfig();
  const allowed = projectAllowed(config.projects, active?.git?.worktree ?? cwd);
  const status = active?.status ?? (this.#enabled ? "offline" : "off");
  const auto = this.#auto;
  const autoText =
   auto.mode === "off"
    ? "off"
    : auto.mode === "limited"
     ? HOST_TEXT.autochatLimitedState(auto.used, auto.quota ?? 0, autoSourceLabel(auto.source))
     : HOST_TEXT.autochatUnlimitedState(auto.used, autoSourceLabel(auto.source));
  const lines = HOST_TEXT.statusLines({
   endpoint: active?.endpoint,
   sessionId,
   status,
   projectAllowed: allowed,
   consent: config.consult.consent,
   trusted: this.#trusted,
   autochat: autoText,
   requests: active?.requests ?? 0,
  });
  this.#omp.notify(ctx, lines.join("\n"), "info");
 }

 #activeFor(ctx: OmpContextLike): ActiveSession | undefined {
  const active = this.#active;
  if (active === undefined) return undefined;
  if (active.ctx === ctx) return active;
  try {
   return this.#omp.sessionId(ctx) === active.sessionId ? active : undefined;
  } catch {
   return undefined;
  }
 }

 #setBridgeStatus(active: ActiveSession): void {
  const base = HOST_TEXT.statusBar(
   active.capabilities.includes("consult") || active.capabilities.includes("chat"),
  );
  this.#omp.setStatus(
   active.ctx,
   bridgeStatusText(base, this.#auto, active.capabilities.includes("chat")),
  );
 }

 #refreshBridgeStatus(ctx: OmpContextLike): void {
  const active = this.#activeFor(ctx);
  if (active !== undefined) this.#setBridgeStatus(active);
 }

 #clearAutoTimer(): void {
  this.#autoTimerEpoch += 1;
  const timer = this.#autoTimer;
  const ctx = this.#autoTimerCtx;
  this.#autoTimer = undefined;
  this.#autoTimerCtx = undefined;
  if (timer !== undefined && ctx !== undefined) {
   try {
    this.#omp.clearTimer(ctx, timer);
   } catch {
    // Best-effort cleanup; the epoch already invalidates the callback.
   }
  }
 }

 /** TUI limited duration; omitted minutes means no expiry. */
 #startAutoLimitTimer(ctx: OmpContextLike, minutes: number | undefined): void {
  this.#clearAutoTimer();
  if (minutes === undefined) return;
  const epoch = this.#autoTimerEpoch;
  try {
   const timer = this.#omp.setTimeout(
    ctx,
    () => {
     try {
      if (epoch !== this.#autoTimerEpoch) return;
      this.#autoTimer = undefined;
      this.#autoTimerCtx = undefined;
      if (this.#auto.mode !== "limited") return;
      this.#autoTuiMode = "off";
      this.#auto.configure("off", "tui");
      const target = this.#active?.ctx ?? ctx;
      this.#refreshBridgeStatus(target);
      this.#omp.notify(target, HOST_TEXT.autochatExpired, "info");
     } catch (error) {
      this.notifyError(ctx, error);
     }
    },
    minutes * 60_000,
   );
   this.#autoTimer = timer;
   this.#autoTimerCtx = ctx;
  } catch (error) {
   this.notifyError(ctx, error);
  }
 }

 #snapshotAutoLimits(ctx: OmpContextLike, config: Config): AutoChatLimits {
  const { limits, clamped } = clampAutoChatLimits(config.chat);
  if (clamped && !this.#autoLimitWarned) {
   this.#autoLimitWarned = true;
   this.#omp.notify(ctx, autoLimitClampWarning(), "warning");
  }
  return limits;
 }

 #notifyUnlimited(ctx: OmpContextLike): void {
  this.#omp.notify(ctx, AUTO_UNLIMITED_WARNING, "warning");
 }

 #onAutoSent(ctx: OmpContextLike): void {
  this.#omp.notify(ctx, autoSentMessage(this.#auto.used, this.#auto.quota), "info");
  this.#refreshBridgeStatus(ctx);
 }

 /**
  * T12b: read `chat.autoApprove` exactly once, at main-TUI session_start.
  * Priority is TUI override > CLI flag > config. Config is trusted only when
  * its real file is outside every allowlisted project and this cwd/worktree,
  * is 0600, and is owned by the current uid. TUI/CLI choices are explicit and
  * intentionally bypass that file-location gate.
  */
 async #snapshotAutoChat(ctx: OmpContextLike): Promise<void> {
  if (this.#autoSnapshotTaken) return;
  if (!this.#omp.isRootTui(ctx)) return;
  this.#autoSnapshotTaken = true;

  try {
   if (this.#autoTuiMode !== undefined) {
    // A pre-start TUI command already snapshotted limits/quota and any timer.
    this.#auto.configure(this.#autoTuiMode, "tui");
    if (this.#autoTuiMode !== "off") {
     this.#omp.notify(
      ctx,
      HOST_TEXT.autochatModeTui(this.#autoTuiMode),
      "info",
     );
    }
    return;
   }

   const dirs = resolveDirs();
   const flag = readAutoApproveFlag(this.#omp.getFlag?.(AUTOCHAT_FLAG));
   if (flag.present && flag.mode !== undefined) {
    if (flag.mode === "limited") {
     const config = await loadConfig(dirs.configFile, { fresh: true });
     if (!this.#autoSnapshotTaken) return;
     if (this.#autoTuiMode !== undefined) {
      this.#auto.configure(this.#autoTuiMode, "tui");
      return;
     }
     const limits = this.#snapshotAutoLimits(ctx, config);
     this.#auto.configure("limited", "cli", { limits });
    } else {
     this.#auto.configure(flag.mode, "cli");
    }
    if (flag.mode !== "off") {
     this.#omp.notify(
      ctx,
      HOST_TEXT.autochatModeCli(flag.mode, AUTOCHAT_FLAG),
      "info",
     );
    }
    if (flag.mode === "unlimited") this.#notifyUnlimited(ctx);
    return;
   }
   if (flag.present && flag.invalid !== undefined) {
    this.#omp.notify(
     ctx,
     HOST_TEXT.autochatBadFlag(AUTOCHAT_FLAG, flag.invalid),
     "warning",
    );
   }

   const config = await loadConfig(dirs.configFile, { fresh: true });
   if (config.chat.autoApprove === "off") {
    this.#auto.configure("off", "config");
    return;
   }

   const cwd = await canonicalCwd(this.#omp.cwd(ctx));
   const git = await gitInfo(cwd);
   const inspection = await inspectConfigAutoApprove({
    config,
    configPath: dirs.configFile,
    cwd,
    ...(git !== undefined ? { worktree: git.worktree } : {}),
   });
   // A shutdown may have reset this snapshot while fs work was in flight.
   if (!this.#autoSnapshotTaken) return;
   // A TUI command issued during the awaits has the highest priority.
   if (this.#autoTuiMode !== undefined) {
    this.#auto.configure(this.#autoTuiMode, "tui");
    return;
   }
   if (inspection.kind === "enabled") {
    if (inspection.mode === "limited") {
     const limits = this.#snapshotAutoLimits(ctx, config);
     this.#auto.configure("limited", "config", { limits });
    } else {
     this.#auto.configure("unlimited", "config");
    }
    this.#omp.notify(
     ctx,
     autoConfigEnabledMessage(inspection.mode, inspection.path),
     "info",
    );
    if (inspection.mode === "unlimited") this.#notifyUnlimited(ctx);
   } else if (inspection.kind === "warning") {
    this.#auto.configure("off", "config");
    this.#omp.notify(
     ctx,
     autoConfigWarningMessage(inspection.reason, inspection.path),
     "warning",
    );
   } else {
    this.#auto.configure("off", "config");
   }
  } catch (error) {
   if (!this.#autoSnapshotTaken) return;
   if (this.#autoTuiMode !== undefined) {
    this.#auto.configure(this.#autoTuiMode, "tui");
    return;
   }
   this.#auto.configure("off", "config");
   this.#omp.notify(
    ctx,
    HOST_TEXT.autochatConfigUnchecked(errorMessage(error)),
    "warning",
   );
  }
 }

 #setStatus(ctx: OmpContextLike, status: AgentStatus): void {
  const active = this.#active;
  if (active === undefined) return;
  if (active.ctx !== ctx) {
   try {
    if (this.#omp.sessionId(ctx) !== active.sessionId) return;
   } catch {
    return;
   }
  }
  active.status = status;
 }

 async #start(ctx: OmpContextLike, generation: number): Promise<void> {
  const omp = this.#omp;
  const sessionId = omp.sessionId(ctx);
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("empty session id");

  const dirs = await ensureRuntimeDirs(resolveDirs());
  const cwd = await canonicalCwd(omp.cwd(ctx));
  const [git, procStart] = await Promise.all([gitInfo(cwd), getProcStart(process.pid)]);
  const instanceId = randomUUID();
  const endpoint = endpointFor(dirs.runtimeDir, instanceId);
  const token = randomBytes(32).toString("base64url");
  const tokenFile = `omp-${sessionId}.token`;
  const socketFile = socketFileOf(endpoint);
  const config = await loadConfig();
  const capabilities: Capability[] = capabilitiesFor(omp, ctx, config);
  const status: AgentStatus = omp.isIdle(ctx) ? "idle" : "busy";
  const now = Date.now();

  const active: ActiveSession = {
   ctx,
   sessionId,
   instanceId,
   agentVersion: this.#agentVersion,
   extensionVersion: this.#extensionVersion,
   token,
   endpoint,
   tokenFile,
   tokenPath: join(dirs.sessionsDir, tokenFile),
   recordFile: join(dirs.sessionsDir, `omp-${sessionId}.json`),
   socketFile,
   cwd,
   procStart,
   capabilities,
   status,
   startedAt: now,
   heartbeatAt: now,
   lastWriteAt: now,
   lastWrittenStatus: status,
   lastWrittenCapabilities: [...capabilities],
   requests: 0,
  };
  const sessionName = omp.getSessionName();
  // Shown to Claude in result headers; the registry rejects absurd lengths.
  if (typeof sessionName === "string" && sessionName.length > 0) {
   active.sessionName = sessionName.slice(0, MAX_SESSION_NAME_CHARS);
  }
  if (git !== undefined) active.git = git;
  active.model = omp.model(ctx);
  active.lastWrittenModel = active.model;

  this.#active = active;
  try {
   const server = await startServer({
    endpoint,
    token,
    identity: (serverNonce) => this.#hello(active, serverNonce),
    onRequest: (env, io) => this.#onRequest(active, env, io),
    onAuthFail: () => {
     this.#auditAuthFail(active);
    },
   });
   active.server = server;
   if (!this.#isCurrent(active, generation)) {
    await this.#discard(active);
    return;
   }

   await writeRecord(recordOf(active), token);
   if (!this.#isCurrent(active, generation)) {
    await this.#discard(active);
    return;
   }

   await this.#sweepStale().catch(() => 0);
   if (!this.#isCurrent(active, generation)) {
    await this.#discard(active);
    return;
   }

   active.timer = omp.setInterval(
    ctx,
    () => {
     try {
      void this.heartbeat().catch((error: unknown) => this.fail(ctx, error));
     } catch (error) {
      this.fail(ctx, error);
     }
    },
    HEARTBEAT_MS,
   );
   this.#setBridgeStatus(active);
  } catch (error) {
   await this.#discard(active);
   throw error;
  }
 }

 #isCurrent(active: ActiveSession, generation: number): boolean {
  return this.#enabled && this.#generation === generation && this.#active === active;
 }

 #hello(active: ActiveSession, serverNonce: string): HelloResult {
  try {
   const hello: HelloResult = {
    sessionId: active.sessionId,
    instanceId: active.instanceId,
    agentVersion: this.#agentVersion,
    extensionVersion: this.#extensionVersion,
    protocol: PROTOCOL_VERSION,
    capabilities: [...active.capabilities],
    status: active.status,
    serverNonce,
   };
   const model = this.#omp.model(active.ctx) ?? active.model;
   if (model !== undefined) hello.model = model;
   return hello;
  } catch (error) {
   this.notifyError(active.ctx, error);
   throw error;
  }
 }

 /** §7.3: audit failed authentication. No token, no caller identity is known here. */
 #auditAuthFail(active: ActiveSession): void {
  void (async () => {
   const config = await loadConfig();
   await appendAudit(
    {
     event: "auth_fail",
     id: newId(),
     from: { agent: "claude-code", sessionId: "unknown" },
     to: { sessionId: active.sessionId },
     project: active.git?.worktree ?? active.cwd,
     outcome: "unauthorized",
    },
    {
     stateDir: resolveDirs().stateDir,
     maxBytes: config.audit.maxBytes,
     content: config.audit.content,
    },
   );
  })().catch((error: unknown) => this.notifyError(active.ctx, error));
 }

 async #onRequest(active: ActiveSession, env: Envelope, io: RequestIO): Promise<void> {
  try {
   active.requests += 1;
   // A caller that is OMP itself (or related by ancestry) must never reach
   // consent/config/audit paths. Status stays available for diagnostics.
   if ((env.type === "consult" || env.type === "chat") && env.from.pid !== undefined) {
    const selfTarget = await isSelfTarget(env.from.pid, {
     selfPid: this.#selfPid,
     readParentPid: this.#readParentPid,
    });
    if (selfTarget) {
     io.send(
      errorEnvelope(
       active,
       env.id,
       new ProtocolError("denied", "caller is the OMP process itself or related by process ancestry", {
        reason: "self_target",
       }),
      ),
     );
     return;
    }
   }
   // Reached from the IPC socket handler, never from an OMP event handler:
   // `runEphemeralTurn` inside a handler is aborted when the handler ends
   // (01 §7.4 note; GATE T0 G1 drew the reply from this callback).
   if (env.type === "consult") {
    const result = await this.#consult.handle({
     ctx: active.ctx,
     sessionId: active.sessionId,
     project: active.git?.worktree ?? active.cwd,
     requestId: env.id,
     from: env.from,
     body: env.body as ConsultBody,
     model: this.#omp.model(active.ctx) ?? active.model,
     signal: io.signal,
     isTrusted: () => this.#trusted,
     trustSession: () => {
      this.#trusted = true;
     },
     sendProgress: (body) => {
      io.send(progressEnvelope(active, env.id, body));
     },
     reportError: (error) => {
      this.notifyError(active.ctx, error);
     },
    });
    io.send(resultEnvelope(active, env.id, result));
    return;
   }
   if (env.type === "chat") {
    // Chat never consults `#trusted`: every message needs its own consent.
    const result = await this.#chat.handle({
     ctx: active.ctx,
     sessionId: active.sessionId,
     project: active.git?.worktree ?? active.cwd,
     requestId: env.id,
     from: env.from,
     body: env.body as ChatBody,
     model: this.#omp.model(active.ctx) ?? active.model,
     signal: io.signal,
     autoApprove: (message, config) => this.#auto.decide(message, config),
     autoSent: () => this.#onAutoSent(active.ctx),
     sendProgress: (body) => {
      io.send(progressEnvelope(active, env.id, body));
     },
     reportError: (error) => {
      this.notifyError(active.ctx, error);
     },
     sendError: (error) => {
      io.send(errorEnvelope(active, env.id, error));
     },
    });
    io.send(resultEnvelope(active, env.id, result));
    return;
   }
   if (env.type !== "status") {
    throw new ProtocolError("unsupported_capability", `unsupported request type ${env.type}`);
   }
   const result = await this.#statusResult(active);
   io.send(resultEnvelope(active, env.id, result));
  } catch (error) {
   if (error instanceof ProtocolError) throw error;
   this.notifyError(active.ctx, error);
   throw new ProtocolError("internal", errorMessage(error).slice(0, 500));
  }
 }

 async #statusResult(active: ActiveSession): Promise<StatusResult> {
  const config = await loadConfig();
  const capabilities = capabilitiesFor(this.#omp, active.ctx, config);
  active.capabilities = capabilities;
  this.#setBridgeStatus(active);
  const model = this.#omp.model(active.ctx) ?? active.model;
  const result: StatusResult = {
   sessionId: active.sessionId,
   instanceId: active.instanceId,
   agentVersion: this.#agentVersion,
   extensionVersion: this.#extensionVersion,
   capabilities: [...capabilities],
   status: active.status,
   cwd: active.cwd,
   pendingMessages: this.#omp.hasPendingMessages(active.ctx),
   policy: {
    projectAllowed: projectAllowed(config.projects, active.git?.worktree ?? active.cwd),
    consultConsent: config.consult.consent,
   },
  };
  if (model !== undefined) result.model = model;
  if (active.git !== undefined) result.git = active.git;
  return result;
 }

 async #stop(): Promise<void> {
  const active = this.#active;
  this.#active = undefined;
  this.#chat.cancelAll("session switched");
  this.#consult.clearWidget(active?.ctx);
  if (active === undefined) return;

  // Let the IPC handler write the cancellation error before sockets close.
  await new Promise<void>((resolve) => {
   try {
    this.#omp.setTimeout(active.ctx, () => resolve(), 0);
   } catch {
    resolve();
   }
  });

  this.#omp.clearTimer(active.ctx, active.timer);
  try {
   await active.server?.close();
  } catch {
   // transport shutdown is best-effort
  }
  await removeRecord(active.sessionId, active.instanceId).catch(() => undefined);
  this.#omp.setStatus(active.ctx, undefined);
 }

 async #discard(active: ActiveSession): Promise<void> {
  this.#chat.cancelAll("session switched");
  this.#omp.clearTimer(active.ctx, active.timer);
  try {
   await active.server?.close();
  } catch {
   // ignore
  }
  await removeRecord(active.sessionId, active.instanceId).catch(() => undefined);
  if (this.#active === active) this.#active = undefined;
 }

 /** Mirrors `removeRecord` synchronously, guarded by the record's instanceId. */
 #removeOwnRecordSync(active: ActiveSession): void {
  try {
   const parsed: unknown = JSON.parse(readFileSync(active.recordFile, "utf8"));
   if (typeof parsed !== "object" || parsed === null) return;
   if ((parsed as { instanceId?: unknown }).instanceId !== active.instanceId) return;
   rmSync(active.recordFile, { force: true });
   rmSync(active.tokenPath, { force: true });
  } catch {
   // missing/corrupt record: leave it to sweepStale on the next launch
  }
 }

 #enqueue(task: () => Promise<void>): Promise<void> {
  const run = this.#queue.then(task, task);
  this.#queue = run.catch(() => undefined);
  return run;
 }
}
