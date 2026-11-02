---
name: omp-extension-v18
description: Pinned reference for writing Oh My Pi (omp) extensions against v18.13–18.14 — the exact ExtensionAPI (`pi`) and ExtensionContext (`ctx`) surface, event names and payloads, runEphemeralTurn, sendUserMessage delivery semantics, UI dialogs, timers, lifecycle and loading rules. Use whenever writing, reviewing or debugging code in packages/omp-extension or any code that calls OMP extension APIs in the AgentBridge project.
---

# OMP extension API — pinned to v18.14.0

Source of truth: `can1357/oh-my-pi` tag `v18.14.0` (commit `31147f9d1a76608549821c3759f8487b4d66c72d`, MIT, see `references/OMP-LICENSE.txt`). The installed `omp` on this machine is 18.14.0 (GATE T0 ran on it). The `types.ts` diff from v18.13.3 is additive only (`rerenderMessage`, `getLinkClicksAvailable`, `startLive?`, `link_activate`, `registerAssistantTextRenderer`, `registerLinkScheme`), so line numbers below are approximate; grep by name. `extensions.md` and `extension-loading.md` are still the v18.13.3 copies. OMP has **no extension-API stability policy** and breaking changes do happen. Do not trust memory or third-party skills; verify every call against the references below.

## References (read the relevant part before coding)
- `references/extension-types.v18.14.0.ts.txt` is a verbatim copy of `packages/coding-agent/src/extensibility/extensions/types.ts`. It is the authoritative signatures.
  - `ExtensionUIContext` (`select`, `confirm`, `notify`, `setStatus`…) ~L300-370
  - `ExtensionUIDialogOptions` (`signal`, `timeout`) ~L202
  - `ExtensionContext` (`ctx`) L680-831; `runEphemeralTurn?` L764
  - `RegisteredCommand` L1677
  - `ExtensionAPI` (`pi`) L1703-2045; `on()` overloads L1727-1798; `registerCommand` L1869; `sendMessage`/`sendUserMessage` L1941-1949
- `references/extensions.md` is the official guide. Key sections: delivery semantics; "Ephemeral side turns (`ctx.runEphemeralTurn`)"; "Background work (`ctx.setInterval` / `ctx.setTimeout`)"; "MCP notifications"; "Session lifecycle".
- `references/extension-loading.md` covers discovery paths, load order and runtime isolation. Note one doc/code discrepancy: the doc says dedup does not use realpath, but the loader **does** dedupe by realpath (`loader.ts:597-605`).
- Research summary in this repo: `docs/research/03-omp-internals.md`. Spec of allowed APIs for AgentBridge: `docs/plan/01-design-spec.md` §7.1.

## Facts that are easy to get wrong
1. **Factory**: `export default function (pi) {}`. Inside the factory only `register*`, `on`, `events`, `getFlag` and `exec` work. Other actions throw until the runner initializes. Do no I/O there.
2. **Subagents re-run the factory.** Gate root-session logic with `ctx.agent?.kind === "main" && ctx.hasUI === true` (and `ctx.mode === "tui"` if TUI-only).
3. **Handler budget is 30 s** (`session_shutdown`: 2 s). An uncaught throw in a raw `setTimeout` or `setInterval` or a detached promise **crashes the omp process**. Use `ctx.setTimeout` / `ctx.setInterval` / `ctx.clearTimer`, and wrap every socket or IPC callback in try/catch.
4. **Deferred TUI load**: the extension may bind after input is accepted, and earlier events are not replayed. On `session_start`, read the current state (`ctx.isIdle()`).
5. **`ctx.runEphemeralTurn(opts)`** is optional, so feature-detect it.
   - Uses the **current model** (no override) and the current history plus in-flight text. Never persisted. Tool calls are discarded. Runs while the main agent is busy.
   - Options: `promptText`, `tools:false`, `maxTokens`, `maxContextBytes`, `replyMaxBytes` (default **4 KiB**), `dedupeReply`, `onTextDelta`, `signal`, `history`, `conversationKey`.
   - Throws `"Active model changed during ephemeral turn; retry."`. Throws `"… does not support maxTokens for ephemeral turns"` on transports that can't cap output (Codex Responses, Cursor, Antigravity…).
   - A call made inside an event handler is aborted when that handler ends.
6. **`pi.sendUserMessage(content, {deliverAs?, attribution?})` returns void** and is persisted to the transcript. When idle, `steer`/`followUp` only queue (no turn). When busy, the default is a steer, which interrupts the tool batch. Capture replies from `agent_end.messages` and skip `willContinue === true`. **Not allowed in AgentBridge MVP.**
7. **No model-change event** exists for extensions. Read `ctx.model` lazily.
8. **Project-level `.omp/extensions` load without any trust prompt** (`ctx.isProjectTrusted()` always returns true). Treat repo content as untrusted.
9. RPC (`--mode rpc`) always creates a new session. It can never attach to a running TUI.
10. Windows: OMP's own IPC uses the native `@oh-my-pi/pi-natives` `ipcEndpoint` / `IpcServer`. `node:net` named pipes inside OMP's Bun are unverified.

## Workflow
1. Before using any `pi.*` / `ctx.*` member, grep `references/extension-types.v18.14.0.ts.txt` for its exact signature.
2. If a member is optional (`?`) or not listed in `docs/plan/01-design-spec.md` §7.1, feature-detect it and provide a fallback.
3. Write code against a thin adapter interface (`OmpLike`) so unit tests use fakes. Never load the extension under development into the omp session you are working in.
4. If the installed `omp --version` is not 18.14.x, stop and report. The references may be stale.
