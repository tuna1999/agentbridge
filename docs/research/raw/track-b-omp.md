# Track B — Oh My Pi (OMP) source study for AgentBridge

Research only. Source cloned (shallow, read-only, nothing executed) into
`<scratchpad>/omp-src`.

| Ref | SHA | Commit date |
|---|---|---|
| tag `v18.13.3` (matches installed `omp/18.13.3`) | `413d278a87a69b453efabf8d1fedb9940385e8c6` | 2026-10-28 |
| `main` HEAD at time of study | `338d2ce6658dfdbfba19efe0f006f0d5a8edd66d` | 2026-10-29 |

All line numbers below are at **v18.13.3** unless marked otherwise. Paths are relative to the repo root;
`CA/` = `packages/coding-agent/src/`.

---

## TL;DR for AgentBridge

1. **An extension is the only supported way into a running TUI session's runtime.** It runs in-process
   (no sandbox) and can open its own `node:net` server/client (as herdr does). There is no built-in
   local IPC/RPC endpoint that lets an outside process prompt an already-running TUI session.
   The one exception is **Collab** (`/collab`, `collab.autoStart`), which lets a guest prompt and interrupt
   a running session, but only through a WebSocket relay (default `wss://my.omp.sh`) using an E2E-encrypted
   protocol (see Q7).
2. **`pi.sendUserMessage()` is fire-and-forget (`void`).** When idle it starts a turn. When busy it queues
   as a **steer** (default), `followUp`, or `aside`. Explicit `steer`/`followUp` while idle only queues and
   does **not** start a turn. The message is persisted like a typed prompt. You cannot await completion; you
   pick up the reply from `message_end` / `turn_end` / `agent_end` events.
3. **`ctx.runEphemeralTurn()` exists in 18.13.3** (optional member, present in TUI/RPC/print/ACP hosts). It is
   the `/btw` side-turn pipeline. It uses the session's **current model** (cannot be overridden) and
   **current history plus in-flight streaming text**. It can run while the main agent is busy, never executes
   tools, does not write to session history or session usage, streams through `onTextDelta`, and supports
   `AbortSignal`, `maxTokens` and `maxContextBytes`. It returns `{ replyText, assistantMessage }`. It is the right
   primitive for "ask OMP a question without disturbing it".
4. **RPC (`--mode rpc`) always builds its own `AgentSession` in its own process over stdio. It cannot attach to a
   running TUI.** Resuming the same session file from a second process does not share live state: a
   cross-process session lease makes the second writer continue in a *new* sibling file with a new
   session id.
5. **No model-change event for extensions** (`model_changed` is deliberately not mapped to extensions).
   Read `ctx.model` / `ctx.models.current()` lazily, or watch `before_provider_request`, `turn_start` and
   `retry_fallback_applied`.
6. **Watch out for the 30-second handler budget.** Don't block inside event handlers waiting for the agent. Use
   `ctx.setTimeout`/`setInterval` or detached work that you guard yourself.

---

## Q1. Extension system

### Discovery / load paths — Confirmed
- `CA/discovery/builtin.ts:61` `getConfigDirs()` returns **project first, then user**:
  - project: `<cwd>/.omp` (only if non-empty, and **skipped when cwd == $HOME**, lines 64-67), then
  - user: `ctx.agentDir ?? getAgentDir()` (default `~/.omp/agent`, profile-scoped `~/.omp/profiles/<name>/agent`).
- `CA/discovery/builtin.ts:494` `loadExtensionModules()` scans `<dir>/extensions` for each config dir (line 516) and
  reads legacy `<dir>/settings.json#extensions`.
- `CA/extensibility/extensions/loader.ts:582` `discoverExtensionPaths()` order:
  1. native auto-discovered modules (project `.omp/extensions`, then `~/.omp/agent/extensions`)
  2. JS/TS hook factories (`.omp/hooks/pre|post`, `<agentDir>/hooks/pre|post`)
  3. installed-plugin entries (`getAllPluginExtensionPaths`)
  4. explicitly configured paths (CLI `-e/--extension`, `--hook`, then settings `extensions:`)
  - Duplicates are removed by **realpath** key (lines 597-605). First occurrence wins.
- Disable controls: `--no-extensions`, `--trusted-extension <abs>` (exact allowlist), and
  `disabledExtensions: [extension-module:<name>]` (docs/extension-loading.md).

### TS loading — Confirmed
- `loader.ts:420` `withHostGuard(() => loadLegacyPiModule(resolvedPath))`. Bun imports `.ts` natively from the realpath
  with an `?mtime` cache-buster on POSIX. On Windows the loader uses `file://` specifiers, which ignore the query string,
  so reload re-import doesn't apply there (docs/extension-loading.md).
- `loader.ts:64` `getExtensionFactory(module)` uses the module itself if it is a function, otherwise `module.default`.
- Bare imports of `@oh-my-pi/pi-{agent-core,ai,catalog,coding-agent,natives,tui,utils}` (and the legacy
  `@mariozechner/*`, `@earendil-works/*` scopes) are rewritten onto the **host-bundled in-process copies**
  (`CA/extensibility/plugins/legacy-pi-compat.ts:814-825`). So an extension can `import { IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives"`.
  This is Partially verified: resolution is confirmed in code, but using it from an extension was not tested.

### Lifecycle — Confirmed
1. Modules are imported concurrently. Factories run **sequentially** in path order (`loader.ts:453`).
2. During the factory call only `register*`, `on`, `events`, `getFlag` and `exec` work. Action methods throw
   `ExtensionRuntimeNotInitializedError` until `ExtensionRunner.initialize(...)` runs (TUI:
   `CA/modes/controllers/extension-ui-controller.ts:354`, `initialize(..., "tui")`).
3. `session_start` fires. Then agent/tool events follow, and `session_shutdown` fires on exit (2 s budget).
4. **TUI deferred load** (`CA/extensibility/extensions/startup-deferral.ts`): an extension that registers no providers,
   shortcuts, composer shapes or file fallbacks may load *after* the composer accepts input, once a previous launch
   recorded that. Its `session_start` still fires, but **events emitted before it binds are not replayed**
   (docs/extensions.md "Session lifecycle").
5. Factories are **rebound for every subagent session** (task tool, eval `agent()`, `/tan`). Module globals are shared
   across those bindings. Use `ctx.agent.kind === "main"` to act only in the root session.

### Trust / isolation — Confirmed
- Same process, same Bun runtime, **no sandbox**. One shared `EventBus` and one `ExtensionRuntime`
  (docs/extension-loading.md "Runtime isolation model").
- `ctx.isProjectTrusted()` always returns `true` (`types.ts:747-754`, `runner.ts` createContext `isProjectTrusted: () => true`).
  **Project-level `.omp/extensions` load unconditionally.** That is a security note for AgentBridge: any repo can ship one.
- Handler exceptions are caught. Handler timeout is `EXTENSION_HANDLER_TIMEOUT_MS = 30_000`
  (`CA/extensibility/extensions/runner.ts:133`) and `SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000` (`runner.ts:157`).
  A raw `setTimeout`/`setInterval`/detached promise that throws is a **process-fatal uncaughtException**. Use
  `ctx.setInterval`/`ctx.setTimeout` (managed, `unref`'d, auto-cleared on shutdown).

### `pi` (ExtensionAPI) surface — Confirmed (`CA/extensibility/extensions/types.ts:1703-2045`)
- Modules: `logger`, `typebox`, `arktype`, `zod`, `pi` (the whole pi-coding-agent export surface).
- `on(event, handler)` (lines 1727-1798; full list below). `events: EventBus` (line 2044). `EventBus` is a trivial
  in-process pub/sub, `CA/utils/event-bus.ts:3`: `emit(channel, data)`, `on(channel, h) => unsubscribe`.
- Registration: `registerTool` (1805), `registerFileWriteFallback`, `registerFileDeleteFallback`, `registerCommand` (1869),
  `registerShortcut`, `registerFlag`, `getFlag`, `setLabel`, `registerMessageRenderer`,
  `registerAssistantThinkingRenderer`, `registerComposerShape`, `registerProvider`, `unregisterProvider`.
- Actions: `sendMessage` (1941), `sendUserMessage` (1949), `appendEntry`, `exec(command, args, opts)` (1955),
  `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `setModel(model): Promise<boolean>` (1970),
  `getThinkingLevel`, `setThinkingLevel`, `getServiceTiers`, `setServiceTier`, `getSessionName`, `setSessionName`.
- Methods keep their binding when destructured (doc comment on the interface).

### `ctx` (ExtensionContext) surface — Confirmed (`types.ts:680-831`)
`ui`, `mode` (`"tui"|"rpc"|"json"|"print"`, line 521; ACP reports `"rpc"`), `getContextUsage()`, `getAsyncJobSnapshot()`,
`compact()`, `hasUI`, `cwd`, `sessionManager` (ReadonlySessionManager), `modelRegistry`, `localProtocolOptions?`,
`model` (getter), `models` (`list/current/resolve/family`, line 500), `isIdle()` (706), `abort()`, `hasPendingMessages()`,
`shutdown()`, `resolvePlanReview()`, `getPendingPlanReview()`, `openPlanReview()`, `sessionModes?` (TUI only),
`agent` (`{kind:"main"|"sub", id, name, depth, parentId?}`), `isProjectTrusted()`, `getSystemPrompt()`,
**`runEphemeralTurn?()`** (764), `memory?`, `annotations`, `setInterval`/`setTimeout`/`clearTimer`,
`addAdditionalContext?` (only during a tool execute), `invokeTool?` (only when re-registering a built-in).

`ExtensionCommandContext` (`types.ts:834`, command handlers only) adds `waitForIdle()` (839), `newSession`, `branch`,
`navigateTree`, `switchSession`, `reload`.

`ReadonlySessionManager` (`CA/session/session-manager.ts:726`) = Pick of `getCwd, getRecordedCwd, getSessionDir,
getSessionId, getSessionFile, getSessionName, getArtifactsDir, ensureOnDisk, getArtifactManager, allocateArtifactPath,
saveArtifact, getArtifactPath, getLeafId, getLeafEntry, getEntry, getLabel, getBranch, getHeader, getEntries, getTree,
getUsageStatistics, putBlob, putBlobSync`. **The herdr usages `getSessionId()` and `getSessionFile()` are confirmed.**

### Event names (`types.ts:1727-1798`; union `ExtensionEvent` at 1547) — Confirmed
Payloads are in `CA/extensibility/shared-events.ts` and `types.ts`:

| Event | Payload (key fields) | Returnable result |
|---|---|---|
| `resources_discover` | `cwd, reason:"startup"|"reload"` | `{skillPaths,promptPaths,themePaths}` |
| `session_start` | `{}` (shared-events.ts:30) | — |
| `session_before_switch` / `session_switch` | `reason:"new"|"resume"|"fork"`, `targetSessionFile?` / `previousSessionFile` (:44) | `{cancel}` |
| `session_before_branch` / `session_branch` | `reason:"branch"|"fork"|"btw"`, `entryId` | `{cancel, skipConversationRestore}` |
| `session_before_compact` / `session.compacting` / `session_compact` | preparation, branchEntries, signal / sessionId, messages / compactionEntry | cancel/customize |
| `session_before_tree` / `session_tree` | preparation / newLeafId, oldLeafId | cancel/summary |
| `session_shutdown` | `{}` (:105) | — |
| `session_stop` | `messages, turn_id, last_assistant_message?, session_id, session_file?, stop_hook_active, signal` (:110) | `{continue, additionalContext}` / `{decision:"block", reason}` |
| `context` | `messages` (deep copy) | `{messages}` |
| `cache_warming_decision` | warm economics | `{action}` |
| `before_provider_request` | `payload` | replacement payload |
| `after_provider_response` | `status, headers, requestId?, metadata?` | — |
| `before_agent_start` | `reason:"prompt"|"revive", prompt, images?, systemPrompt[]` | `{message?, systemPrompt?}` |
| `before_subagent_spawn` | `agent, invocationKind, modelRole?, patterns, spawnKey?` | `{model?, block?, reason?, note?}` |
| `agent_start` | `{}` (:201) | — |
| `agent_end` | `messages: AgentMessage[]` (new messages of that run), `willContinue?`, `awaitingAsyncWork?` (:206) | — |
| `turn_start` | `turnIndex, timestamp` | — |
| `turn_end` | `turnIndex, message, toolResults` (:231) | — |
| `message_start` / `message_update` / `message_end` | `message` (+ `assistantMessageEvent` for update) | — |
| `assistant_message` | `message` (finalized assistant) | `{content}` (text-only rewrite) |
| `tool_call` | `toolCallId, toolName, input` | block / revise input / additionalContext |
| `tool_result` | `toolCallId, toolName, input, content, isError, details` | patch |
| `tool_execution_start/update/end` | `toolCallId, toolName, args, intent? / partialResult / result, isError` | — |
| `tool_approval_requested` / `_resolved` | `sessionId, toolCallId, toolName, reason?, approvalMode` / `approved` (types.ts ~1295) | — |
| `plan_review_requested` / `_resolved` | reviewId, planContent, options… | — |
| `mode_changed` | `previous, state` | — |
| `auto_compaction_start/end`, `auto_retry_start/end`, `retry_fallback_applied` (`from,to,role,reason?`), `retry_fallback_succeeded`, `ttsr_triggered`, `todo_reminder`, `goal_updated`, `credential_disabled` | reliability signals | — |
| `input` | `text, images?, source:"interactive"|"rpc"|"extension"` | `{handled?, text?, images?}` |
| `user_bash` / `user_python` | command/code, cwd | `{result}` |
| `mcp_notification` | `server, method, params` | — |

The events herdr uses (`session_start`, `session_switch`, `agent_start`, `agent_end`, `tool_approval_requested`,
`tool_approval_resolved`, `tool_execution_start`, `tool_execution_end`, `session_shutdown`) are all confirmed. So are
`pi.events.on`, `ctx.hasUI` and `ctx.isIdle()`.

### docs/extensions.md vs code — discrepancies found
- **Dedup:** docs/extension-loading.md says "De-duplication does not use realpaths", but `loader.ts:597-605` keys on
  `fs.realpath` ("so a symlink and its target load once"). The code is authoritative.
- **Project dir when cwd == $HOME:** the docs say project root is `<cwd>/.omp`. The code skips it when cwd equals home
  (`builtin.ts:64-67`). Minor.
- `isProjectTrusted` is declared twice in `ExtensionContext` (types.ts ~747 and ~823). This is harmless duplication.
- `ExtensionHandler` handlers for `tool_approval_*` are documented as "emitted by wrapper.ts only when a tool requires
  approval **and an approval handler is registered**". So these events may not fire in every mode. Partially verified.
- Otherwise the docs (`runEphemeralTurn`, delivery semantics, timeouts) match the code closely.

---

## Q2. `pi.sendUserMessage()` / `pi.sendMessage()` — Confirmed

**Signatures** (`types.ts:1941-1949`; options at `CA/session/agent-session-types.ts:513`):
```ts
sendMessage<T>(message: CustomMessagePayload<T>,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" }): void;
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): void;

export interface SendUserMessageOptions {
  /** Queue behavior; omitted starts a turn when idle and steers while streaming. */
  deliverAs?: "steer" | "followUp" | "aside";
  attribution?: MessageAttribution;   // "user" (default) | "agent"
}
```

**Behavior** (`CA/session/agent-session.ts:10230` `AgentSession.sendUserMessage`):
```ts
if (options?.deliverAs === "aside") {
  if (this.isStreaming) { await this.#queueUserMessage(text, images, "aside", …); return; }
  deliveredAsAside = true;                    // idle: fall through and start a turn
} else if (options?.deliverAs === "followUp") { await this.#queueUserMessage(…, "followUp", …); return; }
  else if (options?.deliverAs === "steer")    { await this.#queueUserMessage(…, "steer", …);    return; }
await this.prompt(text, { attribution, expandPromptTemplates: false, images,
                          streamingBehavior: deliveredAsAside ? "aside" : "steer" });
```
| State | `deliverAs` omitted | `"steer"` | `"followUp"` | `"aside"` |
|---|---|---|---|---|
| idle | starts a turn | **queued only, no turn** | **queued only, no turn** | starts a turn |
| busy | steer (interrupts the remaining tool batch) | steer | queued after the run | injected at the next step boundary without aborting tools; ends an interruptible `wait` |

- **No slash-command or template expansion** (`expandPromptTemplates: false`). `/foo` is sent as literal text.
  `input` hooks are not fired for programmatic sends (docs/extensions.md "External input interception").
- **Returns `void`.** The host wrapper fires the promise and reports errors.
  - TUI: `extension-ui-controller.ts:1461` `#sendExtensionUserMessage`. If the TUI is a **collab guest**,
    `#rejectGuestExtensionTurn()` drops the send.
  - Headless (RPC/print/subagent): `CA/modes/runtime-init.ts:107`.
- **Persistence:** the message goes through the normal `prompt()` → agent loop → `message_end` path and is appended to the
  session JSONL (`agent-session.ts:4117` `#appendSessionMessage` → `sessionManager.appendMessage`). Confirmed path,
  Partially verified for every queue variant.
- **Awaiting completion / capturing the reply:** this is not possible through the API (no promise, no message id). The
  recommended pattern:
  ```ts
  // 1) send
  pi.sendUserMessage(text, { attribution: "agent" });           // or deliverAs:"followUp" when busy
  // 2) capture
  pi.on("message_end", (e) => { if (e.message.role === "assistant") lastAssistant = e.message; });
  pi.on("agent_end", (e, ctx) => {
    if (e.willContinue) return;                                   // not a terminal settle
    const finals = e.messages.filter(m => m.role === "assistant"); // messages of THIS run only
    reply(textOf(finals.at(-1)));
  });
  ```
  `agent_end.messages` is the run's new messages (`packages/agent/src/agent-loop.ts:754-764`, `buildAgentEndEvent(newMessages…)`).
  A steer folds into the *current* run, so correlation is "the run that was active, or the next one". Track
  `turn_end`/`message_end` order if you need precision. `session_stop` (`shared-events.ts:110`) carries
  `last_assistant_message` and is awaited before settle, but it fires only for the main session. Its handler may
  *request continuation*, so keep it read-only.

---

## Q3. `ctx.runEphemeralTurn()` — EXISTS in 18.13.3 — Confirmed

**Declaration:** `types.ts:764` `runEphemeralTurn?(options: EphemeralTurnOptions): Promise<EphemeralTurnResult>;`
It is **optional**, so feature-detect it. It is wired in every host: TUI (`extension-ui-controller.ts:258,490`),
RPC/print/subagent (`runtime-init.ts:149`), and ACP (`modes/acp/acp-agent.ts:3022`).

**Options / result** (`CA/session/agent-session-types.ts:622-651`):
```ts
interface EphemeralTurnOptions {
  promptText: string;
  promptImages?: ImageContent[];
  history?: readonly Message[];      // detached prior side-turn msgs (structuredClone'd, never persisted)
  conversationKey?: string;          // provider-lineage key for a series of side turns; rotate after failure
  tools?: false;                     // omit tool defs + toolChoice "none" (rejected on Cursor)
  maxTokens?: number;                // positive safe int; some transports reject
  minimizeEffort?: boolean;
  maxContextBytes?: number;          // UTF-8 cap on serialized provider context, checked pre-inference
  onTextDelta?: (delta: string) => void | Promise<void>;   // awaited in order
  signal?: AbortSignal;
  dedupeReply?: boolean;             // default true: collapses >3 repeated lines, caps reply
  replyMaxBytes?: number;            // default 4 KiB; Infinity keeps whole answer
}
interface EphemeralTurnResult { replyText: string; assistantMessage: AssistantMessage; }
```

**Implementation:** `AgentSession.runEphemeralTurn` at `CA/session/agent-session.ts:12598`. Key facts:
- **Model:** `const model = this.model`, the **current session model and thinking level**. It is **not overridable**
  through options. If the model or session changes before dispatch it throws `"Active model changed during ephemeral turn; retry."`
  or `"Active session changed…"` (lines 12604-12615). If there is no model it throws `"No active model on session"`.
- **Context snapshot:** `#buildEphemeralSnapshot` (12809) = `[...this.messages]` + **in-flight streaming assistant
  text/thinking** (`this.agent.state.streamMessage`) + a developer "no tools" reminder (`sideChannelNoToolsReminder`) +
  `history` + the user prompt. It then runs `convertMessagesToLlm` and `agent.buildSideRequestContext`, so the
  `context` / provider hooks still run. The system prompt is the session's.
- **While main agent is busy:** allowed. "The side request does not block on, or interfere with, any in-flight main
  turn" (doc comment at 12585-12596). It uses a separate provider session id `${sessionId}:side:<snowflake>` so
  OpenAI/Codex append-only state isn't shared. The prompt-cache key is shared.
- **Tools:** tool definitions are sent by default (for cache reuse), but **tool calls are never executed**. They are stripped
  from the returned message (`content.filter(b => b.type !== "toolCall")`).
- **Streaming:** `onTextDelta` receives deobfuscated deltas. A delivery error aborts the provider request.
- **Cancellation:** `signal`, combined in the extension wrapper with the active handler's signal and the tool-registration scope
  (`runner.ts:1512-1537`). So **a call made inside an event handler is cancelled when that handler ends or times out (30 s)**.
  Call it from a detached task or a command/tool context if it may run long.
- **Nesting:** `runner.ts:1514-1516`. A call reached *within* a running side turn's hooks throws
  `"runEphemeralTurn cannot be called recursively from an ephemeral turn hook"`. Concurrent independent side turns are not
  blocked by any lock (no mutex found; Partially verified).
- **Size limits:** `maxContextBytes` and `maxTokens`. Both must be positive safe integers, else it throws.
- **Errors:** provider `error` events throw `Error(errorMessage || "Ephemeral turn failed")`. It also throws
  `"Ephemeral turn ended without a final message"`.
- **Usage accounting:** the function does **not** append usage to the session (contrast `#recordCacheWarmUsage` →
  `sessionManager.appendModelUsage` at 5932). Usage is available on `result.assistantMessage.usage`. Confirmed by absence in the
  function body.
- **Persistence:** "The session's history is NOT modified by this call". One exception: a snapcompact archive view may be
  cached on its compaction entry.
- **Secret obfuscation** is applied to the outgoing context and reversed on the reply.
- Docs explicitly cite an agent-bridge use case ("a Synadia/NATS bridge can answer another agent's question… without
  injecting a live user message") and ask for consent, auth and audit (docs/extensions.md:381-407).

---

## Q4. Model / provider detection — Confirmed
- `ctx.model` (getter, `types.ts:702`) and `ctx.models.current()` (`types.ts:500-517`; read lazily) return a `Model` with
  `provider`, `id`, `api`, `name`, `contextWindow`, `maxTokens`, `thinking`, and so on. `ctx.models.list()`,
  `resolve(spec)` and `family(model)` are also available. `pi.getThinkingLevel()` returns the thinking level.
- Inside `before_provider_request` / `after_provider_response` handlers, `ctx.model` is the model used *for that request*.
- **There is no `model_select` / `model_change` extension event.** `agent-session.ts:12183`: "`model_changed` has no
  extension-facing hook (`#emitExtensionEvent` never maps it)". It is emitted only on the internal session bus (RPC/TUI/ACP).
  Workarounds: poll on `turn_start`/`agent_start`, `before_provider_request`, and `retry_fallback_applied` (`from,to,role`).
  `model_change` *does* exist as a **session JSONL entry type** (`ModelChangeEntry`), readable through
  `ctx.sessionManager.getEntries()`.
- The same holds on main HEAD: no new model event.

---

## Q5. Busy / idle / waiting detection — Confirmed
- `ctx.isIdle()` = `!session.isStreaming` (`runtime-init.ts:143`, `extension-ui-controller.ts:247`). `isStreaming` =
  `agent.state.isStreaming || #promptInFlightCount > 0` (`agent-session.ts:6806`).
- `ctx.hasPendingMessages()` = `queuedMessageCount > 0`. `ctx.getAsyncJobSnapshot()` reports background jobs.
- `ExtensionCommandContext.waitForIdle()` (`agent.waitForIdle()`) is available in command handlers only.
- Events: `agent_start`; `agent_end` with `willContinue` (a continuation is scheduled) and `awaitingAsyncWork`; `turn_start/end`;
  `session_stop` (just before the main-session settle); `auto_retry_*`; `auto_compaction_*`.
- "Waiting for the human": `tool_approval_requested/resolved`, `tool_execution_start/end` with `toolName === "ask"`
  (the herdr heuristic), `plan_review_requested/resolved`, and `ctx.getPendingPlanReview()`.
- External (no extension): the Collab registry snapshot exposes `busy` (only when collab hosting is on; see Q7).

---

## Q6. RPC / headless / SDK: can a client attach to a running TUI? **No.** — Confirmed

- Mode dispatch: `CA/main.ts:2766-2776`. **`createAgentSession` runs before the mode branch.** RPC receives that fresh
  in-process session:
  ```ts
  if (mode === "rpc" || mode === "rpc-ui") {
      const runRpcMode: RunRpcMode = (await import("./modes/rpc/rpc-mode")).runRpcMode;
      …
      await runRpcMode(session, { setToolUIContext: …, headless: parsedArgs.noUi === true,
                                  subagentEventBus, mcpManager, input: rpcInput });
  } else if (isInteractive) { … await runInteractiveMode(session, …) }
  else { … runPrintMode(session, …) }
  ```
  `runRpcMode(session: AgentSession, …)` is at `CA/modes/rpc/rpc-mode.ts:1387`. The transport is **stdio JSONL only**
  (docs/rpc.md: "RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio"). There is no socket/attach
  option. `--mode acp` and `-p`/`--mode json` (print) are likewise their own process and session.
- The SDK (`createAgentSession`, docs/sdk.md) is an in-process embedding. "If you need cross-language/process isolation, use RPC
  mode instead." It has no attach either.
- **Resuming the same session from another process is not attaching.** `SessionStorage.claimSession`
  (`CA/session/session-storage.ts:1300`) takes an OS lease ("abstract socket, named mutex, or flock sidecar under
  ~/.omp/run/session-owners"). A second writer goes through `SessionManager.#moveOffSessionFile`
  (`session-manager.ts:~1279`), which continues in a **new sibling file with a new session id** and `continuationOf`. So
  `omp --mode rpc --resume <file>` would fork the conversation, not share the live TUI's state.
- RPC has useful commands to mirror in AgentBridge: `prompt`, `steer`, `follow_up`, `abort`, `btw` (side turn,
  `CA/modes/rpc/rpc-btw.ts`), `get_state` (`isSettled`), `get_last_assistant_text`, `get_messages_page`. But they only apply
  to the RPC process's own session.
- main HEAD adds only `live_connect` (voice) to RPC. Attach semantics are unchanged.

---

## Q7. Native collaboration / multi-agent / IPC

### `~/.omp/run/daemons/<hash>/` broker — Confirmed: it is a process supervisor, not a session bus
- Path: `packages/utils/src/dirs.ts:1121-1131`.
  `getDaemonRuntimeDir(projectDir) = <root>/run/daemons/<wyhash(path.resolve(projectDir)).hex16>`. Callers canonicalize with
  realpath first (`CA/launch/paths.ts` `canonicalProjectDir`).
- Created by `CA/launch/broker.ts`:
  - `TOKEN_FILE = "broker.token"` and `PID_FILE = "broker.pid"` (~lines 66-67).
  - `scope.json` is written by `writeDaemonScopeMeta` (`launch/paths.ts`).
  - `clients/` is per-omp-process presence (`launch/presence.ts:7` `CLIENTS_DIR`).
  - `daemons/<name>/{meta,spec}.json` hold supervised processes.
  - The socket is `ipcEndpoint(runtimeDir, "broker")` → `broker.sock` (`launch/paths.ts:86`).
- Protocol (`CA/launch/protocol.ts:31-67`): `ping | start | list | logs | wait | send | stop | restart | mode | describe | cancel | shutdown`.
  All operations concern **supervised background processes** (proc:// services, `wait`, shared LSP, shared browser), are
  token-authenticated, and are not exported as an extension API. **It has no prompt/session operations, so it is unusable
  for AgentBridge messaging.** Don't piggyback on it.
- `omp ps` reads these (`packages/tui/src/apps/ps-data.ts`).

### Collab (`/collab`, `omp join`, `omp collab list|link`) — Confirmed (docs/collab.md, `CA/collab/*`)
- This is the **only built-in way for another party to prompt or interrupt a running TUI session**. A "full-control" guest can
  prompt (the prompt goes into the host transcript), interrupt, answer select/editor dialogs, and steer subagents.
- Transport: a WebSocket **relay** (default `wss://my.omp.sh`; `/collab ws://localhost:7475` is accepted). AES-256-GCM
  E2E encryption, keyed from the link. The production relay is not distributed. A dev stand-in exists at
  `packages/collab-web/scripts/local-relay.ts`.
- Local registry `~/.omp/run/collab-hosts` (`CA/collab/registry.ts:162` `collabHostsRuntimeDir`, `publishCollabHost` at :417):
  - It contains per-host metadata plus a private Unix socket or named pipe with a bearer token.
  - Two operations are supported: `snapshot` (pid, sessionId, cwd, model, `busy`, `inputRequired`, …) and `link` (returns a join URL).
  - `omp collab list --json` and `omp collab link <id>` are offered for "third-party dashboards and bridges".
  - Hosts are published only when `collab.autoStart` is `view` or `control`, or when `/collab` has been run.
- For AgentBridge this is a heavyweight fallback. It requires a relay (cloud by default) and implementing the encrypted
  collab protocol as a guest. Prompts land in the transcript like user prompts.

### Subagents / task / IRC — Confirmed (in-process only)
- `CA/irc/bus.ts:1-10` `IrcBus` is a "Process-global mailbox bus for agent-to-agent messaging". It is backed by the
  `AgentRegistry` in the same process. Busy agents receive messages as an aside, idle agents are woken.
- The Agent Hub, `agent://`, and `history://` (docs/agent-hub.md) are all in-process.
- `before_subagent_spawn` lets an extension reroute or block subagent models.

### MCP — Confirmed client only
- OMP is an MCP **client** (`CA/mcp/*`; `.omp/mcp.json`, `~/.omp/agent/mcp.json`, and `.claude/.cursor/.vscode` configs).
  docs/mcp-server-tool-authoring.md describes consuming servers. No MCP-server mode was found (no server transport and
  no `serve` subcommand in `main.ts`/`sdk.ts`).
- **Relevant channel:** the `mcp_notification` event (docs/extensions.md:602-620) delivers any server-pushed JSON-RPC
  notification to extensions. The docs' own example turns `notifications/peer_message` from a `peer-bus` MCP server into
  `pi.sendUserMessage(…, {deliverAs:"steer", attribution:"agent"})`. An AgentBridge MCP server that both Claude Code and OMP
  connect to could therefore push messages into OMP with **no custom socket**. The reply path still needs an extension, or
  OMP calling a tool on that server.

---

## Q8. Session storage — Confirmed
- Root: `getSessionsDir()` = `dirs.agentSubdir(agentDir, "sessions", "data")` (`packages/utils/src/dirs.ts:998`), which is
  `~/.omp/agent/sessions` by default (an XDG data dir may apply) and is profile-scoped.
- Dir name: `getDefaultSessionDirName` (`CA/session/session-paths.ts:78`), canonical cwd via `resolveEquivalentPath`:
  - inside `os.tmpdir()`: `-tmp-<rel with / \ : → ->`
  - inside `$HOME`: `-<rel with / \ : → ->`, so `/home/you/projects/agentbridge` → **`-projects-agentbridge`**
    (matches the `~/.omp/agent/sessions` listing on this machine)
  - otherwise `--<abs with / \ : → ->--` (`encodeLegacyAbsoluteSessionDirName`, :46)
  - Note the lossy encoding: `a-b/c` and `a/b-c` collide.
- File: `<fileSafeTimestamp(ISO with :/. → ->)>_<sessionId>.jsonl` (`session-manager.ts:2079`).
  Session id = `Bun.randomUUIDv7()` (`session-manager.ts:144` `mintSessionId`).
- Format: JSONL. The first line is the `SessionHeader` (`CA/session/session-entries.ts:41`), with
  `type:"session", version (CURRENT_SESSION_VERSION=3), id, title?, timestamp, cwd, parentSession?, continuationOf?, …`.
  Entries are a union (`session-entries.ts:341`) of `message`, `model_usage`, `thinking_level_change`, `model_change`,
  `service_tier_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `title_change`, `ttsr_injection`,
  `session_init`, `mode_change`, `credential_pin`, `reset_boundary`. Entries form a tree (`id`/`parentId`, leaf).
  Subagent transcripts live at `<session>/<agentId>.jsonl`. Artifacts sit beside the session file.
- Single-writer lease: see Q6 (`~/.omp/run/session-owners`).

---

## Q9. Windows / Bun APIs for extensions
- Extensions run inside the omp **Bun** runtime (compiled binary; CHANGELOG 18.13.3 says "Bun engine requirement ≥1.4.4").
  So `Bun.*`, `node:net`, `node:fs`, etc. are available (Confirmed by runtime model). `pi.exec()` is also available.
- OMP's own IPC (broker, collab registry, session lease) uses **native Rust IPC** from `@oh-my-pi/pi-natives`, not `node:net`:
  - `crates/pi-natives/src/ipc/mod.rs:141-158` `ipcEndpoint(dir, name)`. On Unix it is `<dir>/<stem>.sock`, falling back to
    `/tmp/omp-<euid>/<hash16>.sock` when the path is too long. On Windows it is
    `\\.\pipe\omp-<stem>-<hash16(lowercase(resolve(dir)))>`.
  - `IpcServer` / `IpcConnection` support `lines` framing.
  - `CA/launch/broker.ts:2` comment: "node:net only serves the TCP readiness probe".
  - Extensions can import these via the host-package rewrite (Q1). This is Partially verified; it is not a documented
    extension API, so treat it as unstable.
- `node:net` with `\\.\pipe\…` (the herdr approach) depends on Bun's Windows named-pipe support. That support was **not
  verified from OMP source** (Unverified), and OMP's choice of native IPC hints it was not relied on. Unix socket path
  length (108/104 bytes) is a real constraint. Mirror `ipcEndpoint`'s hash fallback.
- Windows caveats from the docs: the extension reload cache-buster doesn't work (`file://` query ignored). The collab
  registry on Windows inherits the config root ACL.

---

## Q10. Compatibility / stability
- No semver or extension-API stability policy was found in README, CONTRIBUTING, AGENTS or CHANGELOG (grep for semver,
  stability or "stable API" returned nothing relevant). The release cadence is very fast: 18.13.0 to 18.13.3 shipped in 3 days.
- The CHANGELOG has `### Breaking Changes` sections that **do** touch the extension surface. For example, "Extension
  `ui.approve()` hosts … answer `"once"`, `"session"`, or `"deny"` instead of a boolean" (`packages/coding-agent/CHANGELOG.md:628-630`).
- Mitigations OMP itself uses:
  - optional members (`runEphemeralTurn?`, `sessionModes?`, `invokeTool?`) to feature-detect
  - `willContinue` (an added `agent_end` field) noted as "Older builds omit the field" in herdr
  - legacy-pi shims
- Design AgentBridge to feature-detect every call and pin a tested OMP version range.
- Tag→main delta for the APIs studied is **additive only**:
  - `ctx.startLive?`, `ui.rerenderMessage`, `ui.getLinkClicksAvailable`
  - `pi.registerAssistantTextRenderer`, `pi.registerLinkScheme`, the `link_activate` event, RPC `live_connect`
  - No change to `runEphemeralTurn`, `sendUserMessage`, session paths, or RPC attach semantics (`git diff v18.13.3 origin/main`).

---

## Recommended AgentBridge shape (derived)
- An OMP extension in `~/.omp/agent/extensions/agentbridge.ts` (or project `.omp/extensions`), active only when
  `ctx.agent.kind === "main" && ctx.hasUI`:
  - On `session_start`/`session_switch`, bind an IPC endpoint keyed by project/session and write discovery metadata
    (`sessionId`, `sessionFile`, `cwd`, `ctx.model`) to a private, owner-only dir. Use the herdr pattern, but make the
    extension the *server*.
  - **ask** (non-intrusive) → `ctx.runEphemeralTurn({promptText, tools:false, maxTokens, maxContextBytes, onTextDelta, signal})`.
    Stream deltas back over IPC. Not persisted.
  - **tell/delegate** (intrusive) → `pi.sendUserMessage(text, {attribution:"agent", deliverAs: idle ? undefined : "followUp"|"aside"})`.
    Collect the reply from `message_end`/`agent_end` (skip `willContinue`).
  - **status** → `isIdle()`, `hasPendingMessages()`, approval/ask/plan-review state, `ctx.model`.
  - Run long work outside event handlers (30 s budget, and the handler signal cancels side turns). Use `ctx.setTimeout`/`setInterval`.
  - Require consent and authentication: project-level extensions load without trust prompts, and side turns ship the full
    transcript to the provider.

---

## SOURCES

| URL / path | Symbol | Tag/SHA | Finding | Confidence |
|---|---|---|---|---|
| github.com/can1357/oh-my-pi tags | `v18.13.3` | 413d278a | tag matches installed 18.13.3; main HEAD 338d2ce6 | Confirmed |
| CA/extensibility/extensions/types.ts:680-831 | `ExtensionContext` | 413d278a | full ctx surface incl. `runEphemeralTurn?` (764), `isIdle` (706) | Confirmed |
| CA/extensibility/extensions/types.ts:1703-2045 | `ExtensionAPI` | 413d278a | `on` overloads, register*, sendMessage (1941), sendUserMessage (1949), events (2044) | Confirmed |
| CA/extensibility/extensions/types.ts:1547 | `ExtensionEvent` | 413d278a | event union; no model-change event | Confirmed |
| CA/extensibility/shared-events.ts:30-235 | Session/Agent/Turn events | 413d278a | payloads for session_*, agent_end(willContinue), turn_end | Confirmed |
| CA/session/agent-session-types.ts:513,622,647 | `SendUserMessageOptions`, `EphemeralTurnOptions`, `EphemeralTurnResult` | 413d278a | exact option shapes | Confirmed |
| CA/session/agent-session.ts:10230 | `AgentSession.sendUserMessage` | 413d278a | idle/busy/deliverAs routing; no template expansion | Confirmed |
| CA/session/agent-session.ts:12598,12809 | `runEphemeralTurn`, `#buildEphemeralSnapshot` | 413d278a | current model, in-flight snapshot, tools discarded, not persisted, no usage append | Confirmed |
| CA/session/agent-session.ts:12183 | `setModel` comment | 413d278a | `model_changed` not exposed to extensions | Confirmed |
| CA/session/agent-session.ts:6806 | `isStreaming` | 413d278a | basis of `ctx.isIdle()` | Confirmed |
| CA/extensibility/extensions/runner.ts:133,157 | handler timeouts | 413d278a | 30 s / 2 s shutdown | Confirmed |
| CA/extensibility/extensions/runner.ts:1467-1540 | `createContext` | 413d278a | runEphemeralTurn wrapper: recursion guard, signal merging | Confirmed |
| CA/modes/runtime-init.ts:107,143,149 | headless actions | 413d278a | sendUserMessage fire-and-forget; isIdle; runEphemeralTurn wired | Confirmed |
| CA/modes/controllers/extension-ui-controller.ts:247,258,354,1461 | TUI bindings | 413d278a | TUI wiring, guest rejection | Confirmed |
| CA/extensibility/extensions/loader.ts:420,453,582-680 | `discoverExtensionPaths`, `loadExtensions` | 413d278a | load order, realpath dedup, host guard | Confirmed |
| CA/discovery/builtin.ts:61,494 | `getConfigDirs`, `loadExtensionModules` | 413d278a | project then user; skip project when cwd==home | Confirmed |
| CA/extensibility/plugins/legacy-pi-compat.ts:814-825 | `PI_PACKAGE_NAMES` | 413d278a | extensions resolve host-bundled `@oh-my-pi/pi-natives` etc. | Partially |
| docs/extensions.md:310-407 | delivery semantics, runEphemeralTurn | 413d278a | matches code; bridge use case documented | Confirmed |
| docs/extension-loading.md | dedup statement | 413d278a | says no realpath dedup — contradicts loader.ts | Confirmed (discrepancy) |
| CA/main.ts:2766-2776 | mode dispatch | 413d278a | RPC gets freshly created session; stdio only | Confirmed |
| CA/modes/rpc/rpc-mode.ts:1387 | `runRpcMode` | 413d278a | takes own `AgentSession` | Confirmed |
| docs/rpc.md:1-30 | RPC protocol | 413d278a | stdio JSONL, no attach | Confirmed |
| CA/session/session-storage.ts:1300 | `claimSession` | 413d278a | cross-process session lease | Confirmed |
| CA/session/session-manager.ts:~1279 | `#moveOffSessionFile` | 413d278a | contested file → new sibling session id | Confirmed |
| CA/session/session-paths.ts:46-120 | `getDefaultSessionDirName` | 413d278a | cwd encoding rules | Confirmed |
| CA/session/session-manager.ts:144,2079 | `mintSessionId`, file naming | 413d278a | UUIDv7; `<ts>_<id>.jsonl` | Confirmed |
| CA/session/session-entries.ts:16,41,341 | header/entry types | 413d278a | JSONL v3 format | Confirmed |
| packages/utils/src/dirs.ts:998,1121-1131 | `getSessionsDir`, `getDaemonRuntimeDir` | 413d278a | sessions root; daemon hash = wyhash(path) | Confirmed |
| CA/launch/broker.ts, paths.ts:86, presence.ts:7, protocol.ts:31-67 | daemon broker | 413d278a | creates broker.sock/pid/token, scope.json, clients/; process-supervision ops only | Confirmed |
| CA/collab/registry.ts:162,417; docs/collab.md | Collab host registry | 413d278a | only built-in remote prompt/interrupt; relay-based; `omp collab list/link` | Confirmed |
| CA/irc/bus.ts:1-40 | `IrcBus` | 413d278a | process-global in-process agent messaging | Confirmed |
| docs/extensions.md:602-620 | `mcp_notification` | 413d278a | MCP push → sendUserMessage bridge pattern | Confirmed |
| CA/mcp/* | MCP manager | 413d278a | client only; no MCP server mode found | Partially (absence) |
| crates/pi-natives/src/ipc/mod.rs:141-158 | `ipcEndpoint` | 413d278a | Unix socket / Windows pipe naming | Confirmed |
| CA/utils/event-bus.ts:3 | `EventBus` | 413d278a | in-process only | Confirmed |
| packages/agent/src/agent-loop.ts:754-764,1152 | `buildAgentEndEvent` | 413d278a | agent_end carries run's new messages | Confirmed |
| packages/coding-agent/CHANGELOG.md:628-630 | Breaking Changes | 413d278a | extension API breaks happen (ui.approve) | Confirmed |
| git diff v18.13.3..origin/main | types.ts, rpc-types.ts | 338d2ce6 | additive: startLive, registerLinkScheme, link_activate, live_connect | Confirmed |
| ~/.omp/agent/extensions/herdr-omp-agent-state.ts | herdr ext | local | uses verified APIs; node:net client with `\\.\pipe\` on win32 | Confirmed (usage) / Unverified (Bun pipe support) |
