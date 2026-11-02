# Track C — Existing solutions for AgentBridge (Claude Code <-> Oh My Pi)

Accessed: 2026-10-30. Method: shallow clones (read-only, nothing executed or installed) under
`<scratchpad>/ext/`, plus official docs via WebFetch. Each claim has a source row at the end. "Unverified" means I read it in docs or a README but did not confirm it in code.

## 0. Headline findings (read first)

1. **Claude Code now ships native cross-session messaging.** `ListAgents` and `SendMessage` work over a per-session inbox socket: a UDS on Linux/macOS and a named pipe on Windows. The minimum version is v2.1.224 on macOS/Linux/WSL2 and v2.1.234 on native Windows. Sessions register in `~/.claude/sessions/<pid>.json`, which carries `messagingSocketPath`, `peerProtocol`, and `peerFeatures`. Idle sessions wake into a new turn. Messages that arrive during a turn are read between tool calls. Inbound messages are labelled as coming from another session, can't approve prompts, and are governed by `crossSessionInbound` (accept/hold/refuse).
   - **Third-party wire format:** the docs cover script posting (an optional `{"type":"auth","token":...}` first line on Linux, required on Windows). They do not publish a full peer frame schema.
   - **Local evidence:** the user's machine runs CC 2.1.314 and shows `peerProtocol: 1`, `peerFeatures: [notify_idle, reply_across_default_dirs, artifact_yield]`, and sockets at `/run/user/1000/cc-socks/<pid>.sock` with mode 0600.
   - **Why it matters:** this is the cleanest documented way to push a message into an already-running, interactive Claude Code session without credentials. It is not polling.
2. **Herdr's mention of an OMP integration is real, but it reports state only.** `herdr integration install omp` drops a TS hook that sends `pane.report_agent` over herdr's socket. Separately, herdr's socket API has `agent.prompt`, which types text plus Enter into the pane's PTY (bracketed paste), with `agent.wait` for idle/blocked. You get prompting into a live OMP TUI, but only if OMP was started inside a herdr pane, and the transport is a keystroke injection, not a structured RPC.
3. **OMP already has a structured live-session control plane: `/collab`.**
   - **Discovery:** `omp collab list --json` enumerates every live local host (pid, sessionId, cwd, model, `busy`) through a private per-user registry. Each host gets a UDS on Linux or a named pipe on Windows.
   - **Control:** `omp collab link <id>` mints a full-control link. A guest holding that link can `prompt`, `abort`, and drive subagents, and receives AES-256-GCM-encrypted session events.
   - **Catch:** frames go through a relay. The default relay is `wss://my.omp.sh`. The production relay's source is not published, and only a dev stand-in exists (`packages/collab-web/scripts/local-relay.ts`).
   - **Viability:** it is technically viable as an OMP-side ingress, but the protocol is internal and unversioned for third parties, and the hosted relay is a network dependency unless you self-run the dev relay.
4. **The closest existing cross-harness product is the "Agent Intercom" family, which grew out of nicobailon/pi-intercom (MIT).** The dataforxyz fork (AGPL-3.0, protocol v3) has a Claude Code adapter with a "native" transport that bridges to Claude Code's cross-session UDS, version-gated and fail-closed. It also has MCP and Monitor fallbacks. It targets Pi, not OMP. Whether OMP loads it through its `legacy-pi-compat` loader is **unverified**.
5. **MCP Agent Mail is an async mailbox only.** Agents must call `fetch_inbox`, or a hook or `am check-inbox` can poll it. It does not reach into live sessions. The Python repo is superseded by a Rust version. **License risk:** both repos use "MIT with OpenAI/Anthropic Rider", which voids rights for Anthropic and anyone acting "for the benefit of" Anthropic. That needs legal review before any adoption.

## 1. Per-solution notes

### 1.1 MCP Agent Mail (Python, `Dicklesworthstone/mcp_agent_mail`) and its Rust successor
- **What it is:** an HTTP-only FastMCP server on port 8765. It provides memorable agent identities, inbox/outbox, threads, search, and advisory file reservations (TTL, exclusive or shared, glob) with an optional pre-commit/pre-push guard. Storage is a Git archive (human-auditable) plus SQLite FTS5.
- **Live sessions:** it can't push into them. Delivery is pull-based: `fetch_inbox(..., unread_only)`, `resource://inbox/{name}`. The Rust version adds `am check-inbox` (hook-friendly poll) and `am inbox-events` / `fetch_inbox_events` (a restart-safe cursor). An agent sees mail only when it, or a hook in its harness, asks.
- **Status:**
  - The Python README says "Superseded… no longer maintained". It needs Python ≥3.12 (the README suggests 3.14 plus uv) and the last commit was 2026-10-26.
  - Rust: last commit 2026-10-29. It has Windows x86_64 MSVC binaries and `install.ps1`, and it explicitly supports OMP (`am setup run --agent omp` writes `.omp/mcp.json`).
  - Rust limitations stated in the README: single machine; advisory only (`--no-verify` bypasses the guard); nightly Rust; slow reservations at swarm scale.
- **Security:** a bearer token or JWT on the HTTP server and localhost binding. Contact policies (`auto` and others) gate unsolicited messages.
- **License:** MIT plus a rider that grants no rights to OpenAI, Anthropic, their affiliates, or anyone acting on their behalf or for their benefit. The rider's definition of "use" includes "executing… analyzing". **Flag for legal.**
- **Fit:** good as a reference design for reservations and an audit log. It is the wrong primitive for consulting a live TUI session.

### 1.2 Claude Code Agent Teams (official, experimental)
- Enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The lead spawns new Claude Code instances as teammates, either in-process or as tmux/iTerm2 split panes.
- Mailbox: `~/.claude/teams/{team}/inboxes/{agent}.json`. Tasks: `~/.claude/tasks/{team}/`. Task claiming uses file locks.
- **Can't include non-Claude agents and can't adopt existing sessions.** Teammates are "Separate Claude Code instances". There is one team per session, no nesting, and the config "holds runtime state… don't edit it by hand or pre-author it". Mailbox entries that fail validation are removed.
- **Fit:** no for OMP. The `TeammateIdle`, `TaskCreated`, and `TaskCompleted` hooks are only a pattern to copy.

### 1.3 Claude Code cross-session messaging (official, GA)
See headline 1. Other relevant details:
- **Script posting:** `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are exported to hooks and Bash. A message posted from the session's own child process is "own-child" and is delivered by default.
- **Foreign messages:** messages from other processes go through the inbound controls. By default they are delivered unless the receiver is in bypass mode, in which case they are held for approval.
- **Limits:** about 1M-character cap, burst limits, a 50-message queue, loop throttling, and plain text only.
- **Isolation boundaries:** WSL2 and native Windows can't reach each other, and neither can a container and its host.
- **Fit for the OMP→Claude direction:** a high-value primitive. An AgentBridge daemon can write to a Claude session's socket without any Anthropic credential.
- **Caveat:** the general peer frame format isn't fully documented. agent-intercom-claude implements it as `msgV: 1` / `type: "user"` frames (derived from "pi-claude-link", MIT; I could not locate that repo). Treat it as version-sensitive.

### 1.4 Claude Code Channels (brief; another track covers detail) and community bridges
- **Mechanism:** an MCP stdio server declares `experimental["claude/channel"]` and pushes `notifications/claude/channel`, which appears as a `<channel>` block in the live session.
- **Known community implementations:**
  - `aaronn/claude-channel-cli` (MIT, 2026-07-19): "asks a live Claude Code session questions from Codex, Claude Code, or any local shell and returns Claude's response". Requires CC ≥2.1.80, Channels enabled, and a launch via `claude-channel start` (session-scoped MCP config).
  - `umairulh2001/aiAgentBridge` (MIT, Python 3.13, 2026-10-03): a hub on 127.0.0.1:8765. Claude receives pushes as channel blocks; Codex/OpenCode long-poll `wait_for_message`. States support for Windows, macOS, and Linux.
  - `rennerdo30/agent-bridge` (MIT, 2026-10-29): broker daemon on a named pipe or UDS, plugins for Claude, Codex, opencode, Antigravity, and Muse. Claude idle wake uses channel, wake module, or Stop hooks. Supports spawning jobs in worktrees, a dashboard on 127.0.0.1:4777, and paired PCs over TLS. **No Pi/OMP adapter.**
  - `umum-ai/claude-codex-bridge` (MIT, 2026-10-15): Claude plugin that runs Codex agents. Not inspected in depth.
- **Common limitation:** all of them require Claude Code to be **launched with** the channel MCP server. None of them attach to an arbitrary already-running session. agent-intercom-claude's docs claim channel delivery is "best-effort" with drop bugs; that is their claim, unverified here.

### 1.5 herdr (`ogulcancelik/herdr`; README badges now point at `herdrdev/herdr`)
- Rust "agent multiplexer", v0.9.5, Apache-2.0, last commit 2026-10-29. Supports Linux, macOS, and a Windows preview (PowerShell install).
- **Protocol:** newline-delimited JSON over `~/.config/herdr/herdr.sock` (UDS) or a named pipe on Windows. Windows pipe access uses a security descriptor (`src/ipc.rs`, `src/session.rs`).
- **Methods:**
  - `agent.list/get/read/prompt/wait/send_keys/start`
  - `pane.send_text/send_input/read/wait_for_output/report_agent`
  - `events.subscribe`
  - `worktree.create/open/remove`
- **Prompting:** `agent prompt` writes text then a delayed Enter through the PTY (bracketed paste). It refuses with `agent_blocked` when the agent is on an approval UI. With `--wait` it waits for `idle|done|blocked`. The docs say it "does not track individual turns".
- **OMP integration:** `src/integration/assets/omp/herdr-agent-state.ts` reports state (and the session ID for resume) and does nothing else. Agents are detected by process name and screen heuristics, with hooks as an optional reliability upgrade.
- **Fit:** pragmatic and works today on both harnesses as a bidirectional typing bridge, provided both sessions run inside herdr. Downsides: it is screen-scraping and keystroke-based, results come back as terminal text, and adoption means replacing the user's terminal or multiplexer.

### 1.6 pi / pi-mono / OMP ecosystem
- **pi-mono** (`badlogic/pi-mono`, MIT, 2026-10-30): pi has `--mode rpc` (JSONL over stdio), an SDK, and an MCP *client* (`docs/mcp.md`). No MCP-server mode was found.
- **OMP** (`can1357/oh-my-pi`, MIT, 2026-10-29):
  - Entry points: `omp` TUI, `-p`, `--mode rpc` / `rpc-ui`, and `omp acp` (Agent Client Protocol).
  - Built-in subagents: the `task` tool, `agent://` URLs, an IRC-style DM between peer subagents, and Agent Hub. All of these are in-process; I found no cross-process peer messaging.
  - `/collab` (headline 3).
  - A legacy-pi loader rewrites `@mariozechner/*` and `@earendil-works/*` imports, so pi extensions *may* load. Not verified for the intercom packages.
  - It inherits MCP config from `.claude` and other locations.
- **nicobailon/pi-intercom** (MIT, v0.18.1, 2026-10-29):
  - Local broker over a UDS or Windows named pipe (TCP opt-in with a secret), protocol v1.
  - `list/send/ask/reply`, idle wake (`noWake` opt-out), a `busyDelivery` steer policy, `/handover`, cross-machine relay over SSH (unverified identity), Herdr pane awareness, and a `pi-intercom` CLI.
  - Pi only.
- **dataforxyz/agent-intercom-pi** (AGPL-3.0, relicensed from MIT on 2026-07-14; v0.10.0; 2026-10-05) and **agent-intercom-claude** (AGPL-3.0, v0.11.0, 2026-08-21):
  - Protocol v3. Adapters for Pi, Codex, Claude Code, and OpenCode.
  - The Claude side offers three modes: `claude-intercom-mcp` (pull with `intercom_pending`); `cci` (spawns headless `claude -p --resume`, so a new process rather than your live TUI); and `cci --tui` / native transport (wakes a live session that was **launched by `cci`**, via Monitor or the CC cross-session socket).
  - It can't adopt an arbitrary existing Claude session it didn't launch, except through the native socket.
  - Pi/OMP side: Pi only.
- **nicobailon/pi-messenger** (MIT, v0.15.2, 2026-10-30): file-based, serverless "chat room" with file reservations, a stuck-agent detector, and a planner/worker "crew". Pi only.
- **nicobailon/pi-subagents** (MIT, v0.84.0, 2026-10-30): child agents spawned by Pi. It integrates with pi-intercom's `contact_supervisor`.
- **Claude Code ↔ pi/OMP integrations found:**
  - The intercom family (Claude ↔ Pi).
  - Paseo (spawns both).
  - `ramarivera/pi-claude-cli`: routes Pi LLM calls through the `claude` CLI. That is a credential-sharing pattern, not a bridge, and should be avoided per the requirements.
  - Nothing found that targets OMP specifically, except Agent Mail Rust's OMP MCP config writer and herdr's OMP state hook.

### 1.7 Paseo (`getpaseo/paseo`, paseo.sh)
- Apache-2.0, last commit 2026-10-30.
- **What it is:** a daemon on 127.0.0.1:6767 (optional password) plus desktop, web, and mobile clients and a CLI.
- **Providers:** Claude Code (through `@anthropic-ai/claude-agent-sdk` 0.3.246, using the CLI's existing login), Codex (app-server), Pi (JSONL RPC), Copilot, OpenCode, and any ACP agent. OMP could in principle be added as an ACP custom provider (`omp acp`), but that is unverified.
- **Orchestration:** agents can launch other agents and send them prompts by ID, with worktrees, schedules, and heartbeats. The user's machine has Paseo skills installed.
- **Spawns new sessions only.** `paseo attach <id>` streams Paseo-managed agents. I found no import or adoption of a TUI session started outside Paseo.
- **Credentials:** uses each CLI's own subscription login, so no credential sharing.

### 1.8 Other multiplexers and orchestrators (all spawn NEW sessions)
- **claude-squad** (`smtg-ai/claude-squad`, AGPL-3.0, last commit 2026-08-20): tmux plus a git worktree per agent; supports Claude, Codex, Gemini, and others. Unix with tmux.
- **agent-deck** (`asheshgoplani/agent-deck`, MIT, Go, 2026-10-25): tmux-based. `agent-deck session send <id> --message-file` queues a message for a busy Claude session. Has a "conductor" session pattern and MCP attach. Runs on macOS, Linux, and WSL.
- **ccmanager** (`kbwo/ccmanager`, MIT, 2026-10-27): no tmux; its own PTY management with worktrees. Supports Claude, Gemini, Codex, Cursor, Copilot, Cline, OpenCode, and Kimi. Has a Windows path (`%APPDATA%`). No Pi/OMP.
- **Conductor** (conductor.build, Melty Labs, closed source): macOS Apple-silicon app that runs Claude Code and Codex in worktrees with the user's own logins. Not usable on Windows or Linux.
- **tmux send-keys bridges:** the same class as herdr `agent.prompt`. Fragile: no turn tracking, and approval UIs can swallow input.

### 1.9 Protocols and "second opinion" servers
- **A2A** (`a2aproject/A2A`, Apache-2.0, Linux Foundation, 2026-10-29): an HTTP agent-to-agent protocol (Agent Cards, tasks, streaming). Neither Claude Code nor OMP exposes an A2A endpoint natively, as far as I found. Could serve as an envelope or schema reference, but it is heavyweight for local IPC.
- **ACP** (Agent Client Protocol): OMP (`omp acp`) and Paseo support it. It lets a client drive an agent it **spawns** over stdio, not an existing TUI.
- **PAL MCP / formerly Zen MCP** (`BeehiveInnovations/pal-mcp-server`, Apache-2.0, last commit 2025-12-15, so stale):
  - Consult-other-model tools. Calls provider APIs with **your API keys** (Gemini, OpenAI, OpenRouter, and others).
  - `clink` spawns **new** CLI subprocesses (Codex, Gemini, Claude).
  - No live-session access.

## 2. Comparison matrix

Legend: Y = yes, P = partial, N = no, ? = unverified. "Existing" means it can attach to a session the user already started, as opposed to spawning one.

| Solution | Active session discovery | Direct comms w/ EXISTING sessions | Bidirectional | Shared context | Task delegation | File reservations | Worktrees | Auth isolation (no cred sharing) | Windows / Linux | Last commit | License | Security model | Integration complexity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **CC cross-session messaging** (official) | Y (`~/.claude/sessions/*.json`, `ListAgents`) | **Y** (push into live CC, wakes idle) | Y among CC; a foreign peer can post; replies to a foreign peer ? | N (text only) | P (message-driven) | N | N (worktree-agnostic) | Y (local socket, no creds) | Y (≥2.1.234) / Y | rolling (CC 2.1.314 local) | Proprietary (CC) | 0600 UDS / Windows token; inbound accept/hold/refuse; can't grant consent | Low for posting; medium-high for a full peer (frame format not fully public) |
| **CC Channels** (official, preview) | N | P (only sessions launched with the channel server) | Y (reply tool) | N | P | N | N | Y | ?/Y | rolling | Proprietary | MCP stdio, allowlist/org flag | Medium |
| **CC Agent Teams** | Y (team only) | N (teammates are spawned) | Y within team | N | Y (task list) | P (task-claim lock) | N | Y | in-process Y; split panes not in Windows Terminal | rolling | Proprietary | per-team, lead approves | N/A for OMP |
| **MCP Agent Mail** (Py→Rust) | P (registered identities, not liveness of the TUI) | **N** (async pull) | Y (mailbox) | P (threads, archive) | P (via messages and Beads) | **Y** (advisory TTL + git guard) | P | Y | Rust Y / Y; Py ? | 2026-10-29 (Rust) | MIT + **anti-Anthropic/OpenAI rider** | bearer/JWT, localhost, contact policy | Medium (server, MCP config per agent, hooks for polling) |
| **herdr** | Y (`agent.list`, state hooks incl. OMP) | **Y** if session runs in a herdr pane (PTY typing) | Y | N | P (`agent.prompt --wait`) | N | Y (`worktree.*`) | Y | Y (preview) / Y | 2026-10-29 | Apache-2.0 | local socket / ACL'd named pipe | Low to call; high adoption cost (must run agents in herdr) |
| **OMP `/collab`** | Y (`omp collab list --json`) | **Y** (guest prompt/abort/subagent control on live OMP) | P (OMP host only; no CC side) | Y (full replicated transcript) | P | N | N | Y | Y / Y | 2026-10-29 | MIT (relay closed) | AES-256-GCM, link = capability; relay (hosted or dev stand-in) | Medium-high (internal protocol, relay dependency) |
| **pi-intercom** (nicobailon) | Y | Y (Pi only; idle wake/steer) | Y | P (`/handover` summary) | Y (ask/reply) | N | N | Y | Y / Y | 2026-10-29 | MIT | same-machine IPC, IDs not auth | Medium (needs OMP compat or port) |
| **Agent Intercom** (dataforxyz pi + claude) | Y | P: Pi live Y; CC live only if launched via `cci` or native socket | Y | P | Y | N | N | Y (spawns `claude -p` with user's own login) | Y / Y | 2026-10-05 / 2026-08-21 | **AGPL-3.0** | same-machine, rate limits, fail-closed config | Medium-high; AGPL; Pi not OMP |
| **pi-messenger** | Y | Y (Pi only) | Y | P | Y (crew) | **Y** | N | Y | ? / Y | 2026-10-30 | MIT | file-based, same-user | Medium |
| **claude-channel-cli** | P (registry of channel-launched sessions) | P (launched via `claude-channel start`) | P (ask→answer) | N | P | N | N | Y | ? / Y | 2026-07-19 | MIT | local | Low-medium |
| **aiAgentBridge** | Y (hub registry) | P (CC launched with adapter) | Y | N | P | N | N | Y | Y / Y | 2026-10-03 | MIT | localhost hub, webhook | Medium (Python hub) |
| **rennerdo30/agent-bridge** | Y | P (plugins in each CLI; no Pi/OMP) | Y | Y (history ingestion) | Y (`spawn`) | N | Y | Y | Y / Y | 2026-10-29 | MIT | pipe/UDS broker; TLS pairing | High (large surface) |
| **Paseo** | Y (own agents only) | N (spawns) | Y | P | Y | N | Y | Y (each CLI's login) | ? / Y | 2026-10-30 | Apache-2.0 | daemon on localhost:6767 + password | Medium (adopt daemon) |
| **claude-squad / agent-deck / ccmanager** | own sessions only | N (spawn); agent-deck `session send` to its own tmux sessions | P | N | P | N | Y | Y | N / WSL / Y(ccmanager) | 2026-08 / 10-25 / 10-27 | AGPL / MIT / MIT | tmux / PTY | Low (but wrong model) |
| **Conductor** | own only | N | N | N | Y | N | Y | Y | N (mac) | n/a | Proprietary | — | N/A |
| **A2A** | via Agent Cards (HTTP) | N (neither harness speaks it) | Y | P | Y | N | N | depends | Y / Y | 2026-10-29 | Apache-2.0 | HTTP auth schemes | High |
| **PAL MCP (clink)** | N | N (spawns CLIs or calls APIs) | N | P (conversation threading) | P | N | N | **N** (API keys) | ? / Y | 2025-12-15 | Apache-2.0 | env API keys | Low, but violates the no-credentials goal |

## 3. Recommendation: compose, with a thin purpose-built core (do not adopt a framework wholesale)

**Why not adopt any existing product as-is:**
- Nothing found does "discover and consult an *already running* OMP TUI from an *already running* Claude Code TUI, with no shared credentials, on Windows and Linux".
- The orchestrators (Paseo, claude-squad, agent-deck, ccmanager, Conductor, Agent Teams) all spawn their own sessions.
- Agent Mail is pull-only and carries a license rider hostile to Anthropic.
- The Intercom family is the nearest match, but it is Pi-only on the pi side, AGPL in its cross-harness form, and on the Claude side it either spawns `claude -p` or needs the session launched by its wrapper.
- herdr needs both agents inside herdr and works by keystroke injection.

**Compose these documented or first-party primitives:**
1. **OMP→Claude ingress:** Claude Code's native cross-session inbox socket.
   - It is first-party, works on Windows and Linux, needs no credentials, wakes idle sessions, and has built-in consent and permission guards.
   - Use the documented script-post path first. Implement the full peer frame (`msgV:1`, as seen in agent-intercom-claude) behind a version gate, fail closed.
   - Channels is the fallback for sessions launched with the AgentBridge MCP server.
2. **Claude→OMP ingress:** an **OMP extension** that AgentBridge owns (MIT ecosystem; `ExtensionAPI` from `@oh-my-pi/pi-coding-agent`).
   - It registers the session in a per-user registry, listens on a 0600 UDS or a token-ACL'd named pipe, and injects inbound messages with wake and steer semantics. pi-intercom's `idle-wake` and `busyDelivery` are MIT-licensed references to study or port.
   - Treat `/collab` (structured, E2E-encrypted, already has `collab list`) and herdr `agent.prompt` as optional adapters, not the core. `/collab` depends on a relay and an internal protocol; herdr depends on PTY typing and the user adopting herdr.
3. **Claude-side tools:** a small stdio MCP server (or plugin) with `list_peers`, `consult`, `delegate`, and `reply`. It talks to the same local broker and doesn't need the session to be relaunched for outbound sends.
4. **Coordination extras, later:** advisory file reservations and an audit log modelled on Agent Mail and pi-messenger (TTL, exclusive or shared globs, optional git guard), implemented natively rather than taking Agent Mail as a dependency, because of the rider.
5. **Envelope:** keep it A2A- or ACP-shaped (task ID, from/to, reply-to, status) so it can be bridged later, but use local IPC (UDS or named pipe) and no network.

**Main risks:**
- Claude Code peer-frame stability (it's undocumented for foreign peers; mitigate with a version gate and the documented script-post path).
- OMP extension API churn (a fast-moving fork).
- Prompt-injection and consent boundaries: messages must never be treated as user approval. Mirror CC's "can't approve or change config" rule on the OMP side.
- AGPL contamination if Intercom code is copied. Use the MIT nicobailon upstream or a clean-room implementation.

## SOURCES

| # | URL | Path / symbol | Version / commit | Finding | Accessed | Confidence |
|---|---|---|---|---|---|---|
| 1 | https://github.com/Dicklesworthstone/mcp_agent_mail | README.md L3,L9-13,L1667-1715; LICENSE L1-40; pyproject `requires-python>=3.12` | 426d4f3 (2026-10-26) | Superseded, pull-based inbox, advisory leases, git+SQLite, anti-OpenAI/Anthropic rider | 2026-10-30 | High |
| 2 | https://github.com/Dicklesworthstone/mcp_agent_mail_rust | README.md L17, L313-363, L492-563, L695-805, Limitations; install.ps1 | 6bbadb7 (2026-10-29) | Rust successor; Windows MSVC binary; OMP setup; `check-inbox`/`inbox-events`; same rider | 2026-10-30 | High |
| 3 | https://code.claude.com/docs/en/cross-session-messaging | whole page | live docs | ListAgents/SendMessage, UDS/named pipe, wake semantics, inbound controls, token auth, limits | 2026-10-30 | High |
| 4 | local `~/.claude/sessions/<pid>.json`, `/run/user/1000/cc-socks/` | keys `messagingSocketPath`, `peerProtocol`, `peerFeatures` | Claude Code 2.1.314 | Registry and 0600 sockets exist on the user's machine | 2026-10-30 | High |
| 5 | https://code.claude.com/docs/en/agent-teams | Architecture, Limitations | live docs | Experimental; teammates are spawned Claude instances; mailbox/task paths; one team per session | 2026-10-30 | High |
| 6 | https://github.com/ogulcancelik/herdr (→ herdrdev/herdr) | docs/versions/0.9.5/.../socket-api.mdx L93-116, L605-700; cli-reference.mdx L341-367; src/integration/assets/omp/herdr-agent-state.ts; src/ipc.rs | v0.9.5, ee5bfb5 (2026-10-29) | NDJSON socket/named pipe; `agent.prompt`/`wait`; OMP hook reports state only; Apache-2.0 | 2026-10-30 | High |
| 7 | https://github.com/can1357/oh-my-pi | docs/collab.md; README.md L165-173, L498-560; docs/rpc.md; docs/extension-loading.md L23-47, L277-280 | 338d2ce (2026-10-29) | `/collab` live control + `collab list`; RPC/ACP modes; in-process subagents; legacy-pi loader; MIT | 2026-10-30 | High (docs); compat for intercom ? |
| 8 | https://github.com/badlogic/pi-mono | packages/coding-agent/docs/{rpc,mcp,extensions}.md | 908aa7b (2026-10-30) | RPC mode, MCP client only; MIT | 2026-10-30 | Medium-High |
| 9 | https://github.com/nicobailon/pi-intercom | README.md L89-148, L295-310, L493-497, L628-640, L685-695; broker/paths.ts `INTERCOM_PROTOCOL_VERSION=1` | v0.18.1, 4b387e8 (2026-10-29) | Pi live messaging, wake/steer, IPC, MIT | 2026-10-30 | High |
| 10 | https://github.com/dataforxyz/agent-intercom-pi | README.md L7-21, L74-115; LICENSE_TRANSITION.md; broker/paths.ts (v3) | v0.10.0, 62ba698 (2026-10-05) | Cross-harness broker, AGPL since 2026-07-14 | 2026-10-30 | High |
| 11 | https://github.com/dataforxyz/agent-intercom-claude | README.md L15-90; docs/wake-mechanisms.md; claude/native-protocol.ts L1-60 | v0.11.0, 7de76e5 (2026-08-21) | MCP pull / `claude -p` worker / Monitor / native CC socket bridge (`msgV:1` frames) | 2026-10-30 | High (code read, not run) |
| 12 | https://pi.dev/packages/@dataforxyz/agent-intercom-pi | package page | 0.10.0 | Transport, Windows pipe, delivery semantics summary | 2026-10-30 | Medium |
| 13 | https://github.com/nicobailon/pi-messenger | README.md L7, L47, L69-73 | v0.15.2, a704e72 (2026-10-30) | File-based chat + reservations; MIT (package.json) | 2026-10-30 | High |
| 14 | https://github.com/nicobailon/pi-subagents | README.md | v0.84.0, a37a288 (2026-10-30) | Pi child agents; MIT | 2026-10-30 | Medium |
| 15 | https://github.com/getpaseo/paseo | README.md; public-docs/{providers,custom-providers,supported-providers,cli,connectivity,orchestration}.md; packages/server/package.json | e299b21 (2026-10-30) | Spawns agents incl. Pi (RPC) and ACP; Claude via Agent SDK and existing login; daemon 127.0.0.1:6767; Apache-2.0 | 2026-10-30 | High |
| 16 | https://github.com/aaronn/claude-channel-cli | README.md L1-60 | 851c4c5 (2026-07-19) | Channels-based ask-a-live-CC CLI; requires launch via wrapper | 2026-10-30 | High |
| 17 | https://github.com/umairulh2001/aiAgentBridge | README.md L1-134 | 24a68f3 (2026-10-03) | Python hub; CC via channel push; Win/mac/Linux | 2026-10-30 | High |
| 18 | https://github.com/rennerdo30/agent-bridge | README.md L1-133 | e09a819 (2026-10-29) | Cross-CLI broker (no Pi/OMP), spawn, worktrees, dashboard | 2026-10-30 | High |
| 19 | https://github.com/umum-ai/claude-codex-bridge | README (not deeply read) | df078b1 (2026-10-15) | Claude plugin running Codex agents via channels; MIT | 2026-10-30 | Low-Medium |
| 20 | https://github.com/smtg-ai/claude-squad | README.md L49, L147-152; LICENSE | ce1ffb4 (2026-08-20) | tmux + worktrees; AGPL-3.0 | 2026-10-30 | High |
| 21 | https://github.com/asheshgoplani/agent-deck | README.md L22-45, L111-191 | 967e2fa (2026-10-25) | tmux sessions, `session send`, conductor; MIT; macOS/Linux/WSL | 2026-10-30 | High |
| 22 | https://github.com/kbwo/ccmanager | README.md L1-36, L275 | b0948dd (2026-10-27) | PTY manager with worktrees, no tmux; MIT | 2026-10-30 | High |
| 23 | https://www.conductor.build/ (via search results) | — | n/a | macOS-only, spawns CC/Codex in worktrees, closed source | 2026-10-30 | Medium |
| 24 | https://github.com/BeehiveInnovations/pal-mcp-server | README.md L1-54 | 7afc7c1 (2025-12-15) | Formerly Zen; API-key model consult; `clink` spawns CLIs; Apache-2.0 | 2026-10-30 | High |
| 25 | https://github.com/a2aproject/A2A | README.md, LICENSE | d924e07 (2026-10-29) | A2A spec, Apache-2.0; not natively spoken by CC/OMP | 2026-10-30 | Medium |
| 26 | https://github.com/AndrewJacop/pi-herdr (search result only) | — | — | Pi extension driving herdr panes via its CLI | 2026-10-30 | Low |
| 27 | https://github.com/ramarivera/pi-claude-cli (search result only) | — | — | Routes Pi LLM calls via `claude` CLI (credential-sharing pattern; avoid) | 2026-10-30 | Low |
