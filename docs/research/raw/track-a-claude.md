# Track A: Claude Code integration surface for AgentBridge

Accessed 2026-10-30. Installed Claude Code 2.1.314; the docs changelog's newest entry is also **2.1.314 (October 30, 2026)**, so these docs match the installed build.
Method: I downloaded the raw Markdown docs (`https://code.claude.com/docs/en/<page>.md`) and grepped them. I read the legal pages with WebFetch. I changed no configuration, read no credential files and connected to no sockets.

Confidence legend: **Confirmed** = the official doc text says it directly. **Partially** = it follows from official text or is only partly stated. **Unverified** = no official text found.

---

## A1. Session lifecycle and discovery

### A1.1 Hook stdin payloads

**Common fields** (hooks: "Common input fields"). Every hook event receives:
- `session_id`, `prompt_id` (absent until the first user input), `transcript_path`, `cwd`, `hook_event_name`.
- `scratchpad_dir` (v2.1.257+).
- `permission_mode`, but "Not all events receive this field".
- `effort.level` on tool-context events.
- `agent_id` / `agent_type` inside subagents and teammates, or with `--agent`.

Caveat on `transcript_path`: "The transcript file is written asynchronously and may lag the in-memory conversation… Hooks that need the final assistant text… should use `last_assistant_message` on Stop and SubagentStop." **Confirmed.**

Command hooks get this JSON on stdin. HTTP hooks get it as the POST body ("Hook lifecycle"). So an `http` hook can report session events straight to a local bridge daemon. **Confirmed.**

| Event | Event-specific input (quoted or paraphrased from hooks reference) | Notes |
|---|---|---|
| SessionStart | `source` (`startup`/`resume`/`clear`/`compact`/`fork`); optional `model`, `agent_type`, `session_title`; on resume/fork with ≥1 response, also `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` (v2.1.251+) | Only `command` and `mcp_tool` types. Runs in the background at interactive launch; Claude's first response waits for it |
| SessionEnd | `reason`: `clear`, `resume`, `logout`, `prompt_input_exit`, `other` (`bypass_permissions_disabled` removed in v2.1.234) | Default timeout is 1.5 s; the budget rises with per-hook `timeout` up to 60 s, or set `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`. No decision control |
| UserPromptSubmit | `prompt`, `session_title` | Also fires on scheduled-task fires, background-subagent reports, and "A message another session sends to your main conversation". Default timeout 30 s; blocks model processing |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` | Can block, allow or defer |
| PostToolUse | tool fields plus the result | Also `PostToolUseFailure` and `PostToolBatch` |
| Stop | `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` | Doesn't run on user interrupt. API errors fire `StopFailure` instead (`error`, `error_details`, `last_assistant_message`). Continuations are capped at 8 consecutive |
| SubagentStop | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` | Also fires for internal agents such as prompt suggestions and `/btw` |
| Notification | `message`, optional `title`, `notification_type` | Matchers: `permission_prompt` (~6 s), `idle_prompt` (~60 s after the response, only if the user hasn't typed), `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_*` (v2.1.234+), `plugin_notification`. Can't block |
| PreCompact | `trigger` (`manual`/`auto`), `custom_instructions` | Can block |
| PostCompact | (see doc) | |
| PreModelSwitch | `from_model`, `to_model`, `requested_model`, `source` (`command`/`picker`/`sdk`), `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing` | **v2.1.251+**. Can block. Not run for automatic switches |
| PostModelSwitch | same fields as PreModelSwitch, plus `source` values `auto` and `resume` | **v2.1.251+**. Runs on every model change, including fallback and resume restore |
| Others | Setup, InstructionsLoaded, UserPromptExpansion, MessageDisplay, PermissionRequest, PermissionDenied, SubagentStart, TaskCreated, TaskCompleted, TeammateIdle, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate/Remove, Elicitation, ElicitationResult | Full list in the "Hook lifecycle" table |

### A1.2 Is the current model exposed?

**Hooks:** "Only `SessionStart` hooks can receive a `model` field, and Claude Code doesn't always include it. `PreModelSwitch` and `PostModelSwitch` hooks receive `from_model` and `to_model` instead, so use a PostModelSwitch hook to follow the model as it changes during a session. There is no `$CLAUDE_MODEL` environment variable." **Confirmed.**

To track the model, combine SessionStart `model` (when present) with PostModelSwitch `to_model` (v2.1.251+).

**Statusline:** the stdin JSON includes `model.id`, `model.display_name`, `session_id`, `session_name`, `transcript_path`, `version`, `cwd`, `workspace.*` and `context_window.*` (statusline "Available data"). **Confirmed.**
- The script runs at session start and resume, then on each new assistant message, `/compact`, a permission-mode change, and so on. Updates are debounced at 300 ms.
- `refreshInterval` adds a timer. Without it, "The event-driven triggers can go quiet when the main session is idle."

**Mods** (plugins/mods/api): `$.session` exposes "the working directory, model, and more". **Partially** (exact field not read).

### A1.3 Busy and idle signals

There are four documented sources:

1. **`claude agents --json`**, added in 2.1.145. agent-view, "List sessions as JSON" and "Read session state from a script":
   - Fields: `pid`, `status` (`busy`/`waiting`/`idle`), `waitingFor` (`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`), `sessionId`, `name`, `cwd`, `kind` (`interactive`/`background`), `startedAt`, plus `id`/`state` for background sessions.
   - Quote: "`claude agents --json` is the supported way to read session state from outside Claude Code."
   - **Confirmed.**
2. **Hooks.** `UserPromptSubmit` marks a turn start. `Stop`/`StopFailure` mark a turn end. `Notification` `idle_prompt` and `permission_prompt` are delayed (6 s / 60 s) and gated on the user being away. `PermissionRequest` fires immediately. **Confirmed.**
3. **Cross-session `notify_when_idle`** (v2.1.236+). "Idle here means the session finished a turn with nothing queued." **Confirmed.**
4. **Stop input** `background_tasks` / `session_crons` let a hook tell "done" apart from "paused waiting for background work". **Confirmed.**

### A1.4 Resume behavior and session_id

- CLI reference: `--fork-session` means "When resuming, create a new session ID instead of reusing the original (use with `--resume` or `--continue`)". So plain `--resume`/`--continue` **reuse the original session ID**. **Confirmed** (by implication of the flag's definition).
- SessionStart `source` = `resume`; `fork` for `--fork-session`, `/branch` and `/fork`. `/clear` starts a new session (`source: clear`; statusline cost "Resets to $0 when `/clear` starts a new session"). **Confirmed.**
- env-vars, `CLAUDE_CODE_SESSION_ID`: set in Bash/PowerShell tool subprocesses, hook subprocesses and **stdio MCP server subprocesses**. "For Bash, PowerShell, and hooks this matches the `session_id` field… and is updated on `/clear`. An MCP server subprocess retains the ID it was spawned with. On `--resume <session-id>` it receives the resumed ID… On `--continue` or `--resume` without an explicit ID it may receive the initial startup ID instead." **Confirmed.**
  - Design note: an MCP server's session ID can be stale after `/clear`, or wrong with `--continue`. Correlate it with hooks, or with `claude agents --json`, using the pid.
- Transcripts live at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the cwd with non-alphanumerics replaced by `-` (truncated and hashed above 200 characters) (sessions, "Where transcripts are stored"). **Confirmed.**

### A1.5 Reliability caveats

- **SessionEnd on crash:** not documented. claude-directory says `~/.claude/sessions/` holds "one small file per running session, used to detect concurrent sessions and crashes… Claude Code removes each file when its session exits and clears crash leftovers on the next launch." That implies no cleanup, and presumably no SessionEnd, on a crash. **Unverified/Partially.**
- SessionEnd has a 1.5 s default budget. Treat it as best-effort and use pid liveness as the authoritative signal.
- Async hooks in `-p` mode are killed at teardown with outcome `cancelled`. **Confirmed.**
- A failed or timed-out hook continues the action unless `"onFailure": "block"` is set. **Confirmed.**
- On disconnect, stdio MCP servers receive SIGINT, then SIGTERM 100 ms later, then SIGKILL 400 ms after that (Linux/macOS). **Confirmed.**

### A1.6 Environment variables

| Variable | Fact | Confidence |
|---|---|---|
| `CLAUDE_PROJECT_DIR` | Set for hooks and in the stdio MCP server environment; "the stable project root" (mcp "Option 3") | Confirmed |
| `CLAUDE_CODE_SESSION_ID` | See A1.4. There is **no `CLAUDE_SESSION_ID`** | Confirmed |
| `CLAUDE_ENV_FILE` | Available only to SessionStart, Setup, CwdChanged and FileChanged hooks | Confirmed |
| `CLAUDE_CODE_MESSAGING_SOCKET` | Inbox socket path, exported to hooks and Bash; v2.1.224+ | Confirmed |
| `CLAUDE_CODE_MESSAGING_TOKEN` | Per-session token for the auth line; v2.1.228+ | Confirmed |
| `$CLAUDE_MODEL` | "There is no `$CLAUDE_MODEL` environment variable" | Confirmed |

---

## A2. MCP

| Topic | Finding | Source | Confidence |
|---|---|---|---|
| Transports | stdio, HTTP, SSE and WebSocket (`claude mcp add --transport …`) | mcp "Installing MCP servers" | Confirmed |
| Scopes | Local (default, `~/.claude.json` under the project path), Project (`.mcp.json`, shared), User (`~/.claude.json`, all projects). Precedence: local > project > user > plugin > claude.ai connectors. Managed `managedMcpServers` ranks above all (v2.1.259+) | mcp "MCP installation scopes" | Confirmed |
| Project approval | "Claude Code prompts for approval in interactive sessions before using project-scoped servers from `.mcp.json`". In `-p`, the Agent SDK and some cloud sessions, it "loads project-scoped servers without asking". Committed approvals are ignored in an untrusted folder. `disabledMcpjsonServers` blocks everywhere | mcp "Project scope", "Project server approvals and workspace trust" | Confirmed |
| Permission rules | `mcp__<server>__<tool>`, `mcp__<server>__*`, or bare `mcp__<server>`. Allow globs only after a literal `mcp__<server>__` prefix. `.` and spaces in a server name become `_`. Plugin servers use `mcp__plugin_<plugin>_<server>__*` | permissions | Confirmed |
| Forced approval | `_meta["anthropic/requiresUserInteraction"]: true` means a prompt on every call, even in bypass mode | mcp "Require approval for a specific tool" | Confirmed |
| Startup timeout | `MCP_TIMEOUT`, default 30000 ms | env-vars | Confirmed |
| Tool timeout | `MCP_TOOL_TIMEOUT` (default 100000000 ms ≈ 28 h), or per-server `"timeout"` in `.mcp.json`. Progress notifications don't extend the wall-clock limit. Idle timeout `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (stdio default 30 min); a response **or progress notification** resets the idle timer. Stdio has no per-request timer | mcp "Time limits on MCP tool calls" | Confirmed |
| Output limits | Warning above 10,000 tokens. `MAX_MCP_OUTPUT_TOKENS` defaults to 25,000. A text result over 50,000 chars is saved to a file in `tool-results/` unless the tool declares `_meta["anthropic/maxResultSizeChars"]` (max 500,000). Error text over ~11k chars is trimmed to the first 5k and last 5k | mcp "MCP output limits and warnings" | Confirmed |
| Blocking | A main-conversation call still running after **2 minutes** moves to a background task; "Claude receives the task ID immediately and keeps working, and the result arrives as a task notification". Change with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (`0` = off). Never backgrounded: subagent calls, and `-p` calls unless `CLAUDE_AUTO_BACKGROUND_TASKS=1` | mcp "Automatic backgrounding of long tool calls" | Confirmed |
| Cancellation | Stopping a background task in `/tasks` "cancels the call and tells Claude that no result is coming… Stopping doesn't guarantee the server stops". For MCP tasks, `Esc` while waiting "ends the call, and Claude Code asks the server to cancel the task" | mcp | Confirmed |
| MCP tasks (server-side long jobs) | Public beta, **v2.1.304+**. Needs protocol revision 2026-07-28 (v2 runtime). The result arrives later; "If Claude is idle when the result arrives, Claude starts on it unprompted" | mcp "MCP tasks that run on the server" | Confirmed |
| Elicitation | Supported in form and URL modes. Claude Code declares `elicitation: {form:{}, url:{}}` to user-configured stdio/http servers (v2.1.287+). An `Elicitation` hook can auto-respond. In `-p`, a task that requests input is cancelled | mcp "Respond to MCP elicitation requests" | Confirmed |
| Spawned per session? | "Claude Code reads your MCP config at startup and spawns each server as a subprocess". Channels reference: "Claude Code spawns it as a subprocess and communicates over stdio". Each stdio server also gets `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR`, and is stopped when the session ends | channels-reference, mcp, env-vars | **Confirmed**: one stdio process per Claude Code session, and it knows its session ID (with the `/clear`/`--continue` caveat in A1.4) |
| Runtime caveat | The v2 runtime (MCP TS SDK 2.0, protocol 2026-07-28) is the default on 2.1.232+ in flag-fetching sessions. **A channel server that negotiates 2026-07-28 isn't registered as a channel.** Use an older-protocol server, or `MCP_PROTOCOL_NEGOTIATION=legacy` | mcp "MCP client runtimes", "Push messages with channels" | Confirmed |

---

## A3. Channels (full detail)

**Docs:** https://code.claude.com/docs/en/channels and https://code.claude.com/docs/en/channels-reference

### What a channel is

"A channel is an MCP server that pushes events into your running Claude Code session." It runs locally as a stdio subprocess spawned by Claude Code. Channels can be one-way, or two-way via a reply tool. "Events only arrive while the session is open." **Confirmed.**

### Status and versions

- Research preview. `--channels` was added in **2.1.80**. Permission relay was added in **2.1.81**. `AskUserQuestion` and plan tools were disabled with `--channels` in **2.1.83**; interactive plan tools were fixed back in **2.1.126**. The `allowedChannelPlugins` setting was added in **2.1.84**. Console API-key support arrived in **2.1.128**. Relay goes only to registered channels, and `false` is honored, from **2.1.234**. Relay ID-reuse was fixed in **2.1.290** (changelog). **Confirmed.**
- "the `--channels` flag syntax and protocol contract may change based on feedback." Neither flag appears in `claude --help`. **Confirmed.**

### Authentication

"They require Anthropic authentication through claude.ai or a Console API key, and are not available on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry."

So **API keys are supported** (Console API key; changelog 2.1.128: "`--channels` now works with console (API key) authentication"). The premise that channels require claude.ai login and reject API keys is **outdated**. **Confirmed.**

### Flags and allowlist

- `--channels plugin:<name>@<marketplace>` (several entries, space-separated).
  - During the preview it accepts only the Anthropic-maintained allowlist (the `claude-plugins-official` channel plugins), or the org's `allowedChannelPlugins`.
  - "The community marketplace is not on the channel allowlist."
- `--dangerously-load-development-channels plugin:<n>@<mkt>` or `server:<name>` (a bare `.mcp.json` server).
  - Bypasses the allowlist per entry, after a **full-screen confirmation dialog** at every launch.
  - "If you pass it in non-interactive mode with `-p` or through the Agent SDK, Claude Code ignores the flag and the channel doesn't register."
- "Being in `.mcp.json` isn't enough to push messages: a server also has to be named in `--channels`."
- **Confirmed** for all of the above.

### Org policy

- `channelsEnabled` is the master switch (managed setting). `allowedChannelPlugins` replaces the Anthropic list.
- claude.ai Team/Enterprise: blocked until an Owner enables it. Console: allowed unless the org deploys managed settings.
- "Pro and Max users without an organization skip these checks entirely."
- **Confirmed.**

**Implication for AgentBridge.** A custom AgentBridge channel can run on Pro/Max only through the dev flag, which shows an interactive warning each launch, unless:
- it gets an official-marketplace listing ("If you are working with an Anthropic partner contact…"), or
- an Enterprise/Team admin allowlists it.

**Partially** (inferred from the rules above).

### Wire contract

- **Capability:** `capabilities.experimental['claude/channel'] = {}` (required). Optional `capabilities.experimental['claude/channel/permission'] = {}`. `tools: {}` for two-way. An `instructions` string is "delivered to Claude as context when the server connects".
- **Push (server → Claude Code):** notification method **`notifications/claude/channel`**, params `{content: string, meta?: Record<string,string>}`.
  - `meta` keys must be identifiers (`[A-Za-z0-9_]`). "Keys containing hyphens or other characters are silently dropped."
  - The event reaches the model as `<channel source="<server-name>" k="v">content</channel>`. The terminal shows `← <name>: …`.
- **Reply:** an ordinary MCP tool, such as `reply(chat_id, text)`. It is subject to normal permission rules, and the first reply may prompt.
- **Permission relay:**
  - Claude Code → server: `notifications/claude/channel/permission_request` with `{request_id (5 letters a–z minus l), tool_name, description, input_preview}`. Text is sanitized and capped at 3,500 code points (v2.1.211+); credentials are masked (v2.1.234+).
  - Server → Claude Code: `notifications/claude/channel/permission` with `{request_id, behavior: 'allow'|'deny'}`.
  - The local terminal dialog stays live; the first answer wins. "Project trust and MCP server consent dialogs don't relay."
- **Confirmed.**

### Delivery vs. processing vs. completion

- **Delivery.** "Claude Code doesn't acknowledge notifications. The `await` on `mcp.notification()` resolves when the message is written to the transport, not when Claude has processed it. If the session hasn't loaded your server as a channel, or the organization policy blocks it, Claude Code drops the events silently and returns no error." **Confirmed.**
- **Model processing and turn triggering.** In the webhook walkthrough, after a POST, "You'll then see Claude start responding". An event arriving at an idle session starts a turn. **Confirmed** (by example; no normative sentence).
  - "Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn and Claude handles them as a group. To process independent event streams concurrently, run separate sessions." **Confirmed.**
- **Waiting for approval.** "If Claude hits a permission prompt while you're away from the terminal, the session pauses until you respond." Events sent meanwhile queue (by the rule above). **Partially** (the behavior of events arriving during a pending prompt isn't stated separately).
- **Completion.** There is no completion signal. "If you need delivery confirmation, track event state in your server and expose a reply tool that Claude can call to report status back." You can also observe `Stop` hooks. **Confirmed.**
- **Buffering limits.** No documented cap or TTL for channel queues. **Unverified.**
- **One channel per session?** No. "You can pass several plugins to `--channels`." **Confirmed.**
- **`-p` with channels.** "When you run channels in non-interactive mode with `-p`, tools that need terminal input… are disabled". Only allowlisted (`--channels`) channels work there, because the dev flag is ignored in `-p`. **Confirmed.**
- **Security.** "An ungated channel is a prompt injection vector." Gate on the sender identity before emitting. **Confirmed.**
- **Whether `UserPromptSubmit` fires on channel-started turns.** Not listed among the non-typed triggers. **Unverified.**

### Intended use (from the docs)

"Chat bridge", "Webhook receiver" (CI, error tracker, deploy pipeline): "pushing events from non-Claude sources into your already-running local session". A local agent pushing into Claude Code is architecturally the webhook-receiver pattern.

---

## A4. Policy

### Key texts

1. **legal-and-compliance, "Authentication and credential use":**
   - "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
   - "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication… Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
   - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription."
   - "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
2. **legal-and-compliance, "Acceptable use":** "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
3. **legal-and-compliance, "Can customers offer Claude Code in their products?":** the binary must not be modified, and customers must not intermediate or resell usage; "Each end user must authenticate with their own…" credentials.
4. **Agent SDK overview:** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…"
5. **Consumer Terms** (effective Oct 8, 2025), §3 item 7. It prohibits accessing the Services "through automated or non-human means, whether through a bot, script, or otherwise", with the exception "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it." §2: "You may not share your Account login information… with anyone else."
6. **Usage Policy** (page shows "Effective Nov 12, 2026", which is after today's date; noted as an anomaly), "Do Not Abuse Our Platform": "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used." It also says "Agentic use cases must comply with the Usage Policy."
7. **Commercial Terms** (effective Jun 17, 2025), A.1: permission "to power products and services Customer makes available to its own customers and end users". D.4: no competing product and no resale without approval.
8. **Explicit permission for scripted subscription use.** These texts amount to "where we otherwise explicitly permit it":
   - **authentication doc:** `claude setup-token` makes a one-year OAuth token "For CI pipelines, scripts, or other environments where interactive browser login isn't available… This token authenticates with your Claude subscription".
   - **support article "Use the Claude Agent SDK with your Claude plan"** (support.claude.com/en/articles/15036540, Oct 7, 2026 notice): "when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits". An earlier planned change was paused (June 15, 2026 notice).
   - **Caveat (headless doc):** `--bare` "doesn't use your subscription login" and "will become the default for `-p` in a future release".
9. **Cross-session messaging** (official feature) treats peer messages as non-user: "a message from another session never counts as your consent… can't change configuration… Commands don't run".

### Compliance matrix

| # | Scenario | Classification | Basis |
|---|---|---|---|
| 1 | The human uses Claude Code and calls an MCP tool that consults another local agent | **Explicitly supported** | MCP is a core feature ("Claude queries it during a task"). The binary is unmodified, the user's own login is used, and the user is interacting. The consulted agent's own LLM usage is governed by that agent's provider terms |
| 2 | The other agent sends a notification into Claude Code (shown, no model turn) | **Potentially supported, needs confirmation** | No documented "display-only" path for an external process. Options: Channels (but they inject into model context), a mod `$.ui.notify`/toast (mods API), or an MCP elicitation or log. Non-model display adds no extra usage, so the policy risk is low; the mechanism is the open question |
| 3 | The other agent triggers a Claude response via a Channel | **Potentially supported, needs confirmation** | Channels exist precisely to let "non-Claude sources" push into a running local session, and webhooks and CI qualify. Restrictions: research preview; a custom server needs `--dangerously-load-development-channels` (interactive only, warning dialog) unless allowlisted; the protocol may change. Policy-wise this is the user's own session and binary. "Ordinary, individual usage" bounds apply. Gate senders |
| 4 | A local daemon repeatedly instructs Claude Code with no user interaction | **Unsupported/restricted** on a subscription (high risk); OK on an API key | Consumer Terms §3(7) prohibits automated access "except… via an Anthropic API Key or where we otherwise explicitly permit it". Pro/Max limits "assume ordinary, individual usage". Channels' *occasional* event-driven turns are explicitly offered, but a continuous instruction loop goes beyond that. Built-in safeguards point the same way: peer messages are rate-limited and loops "stop on their own". Use an API key for unattended loops |
| 5 | The bridge launches `claude -p` as a child process on the user's subscription | **Potentially supported, needs confirmation** | The official support article says `claude -p` on a plan draws from subscription limits, and `setup-token` is documented for scripts. So personal, user-initiated use by the subscriber on their own machine is permitted. If AgentBridge is distributed as a product, "should use API key authentication" applies and it must not route other users' requests through plan credentials. Future risk: `--bare` default for `-p` drops subscription login |
| 6 | A separate Anthropic API-key worker | **Explicitly supported** | "Developers… should use API key authentication through Claude Console". Consumer Terms exempt API-key access from the automation ban. Commercial Terms govern it |
| 7 | Reading transcript metadata in `~/.claude/projects/*.jsonl` without credentials | **Potentially supported, needs confirmation** (technically fine; format not a stable API) | The docs describe the location and contents (claude-directory, sessions). The SDK docs explain how to locate session files. Note "Transcripts… are not encrypted at rest… If a tool reads a `.env` file… that value is written" to the JSONL, so treat it as sensitive. Format stability is undocumented. Prefer hooks (`transcript_path`, `last_assistant_message`) and `claude agents --json` |

---

## A5. Session registry and peer-to-peer messaging

**Yes. Claude Code officially documents peer messaging between sessions:** https://code.claude.com/docs/en/cross-session-messaging ("Message your other Claude Code sessions").

### Feature summary

- **Versions:** v2.1.224+ on macOS/Linux (changelog 2.1.224: "Added cross-session `SendMessage`… with `ListAgents` to discover them"). v2.1.234+ on Windows. "When a session meets the requirements, messaging is on with nothing to enable." **Confirmed.**
- **Tools:** `ListAgents` and `SendMessage` (model tools). `/list-agents` (alias `/peers`). `@name` mentions (v2.1.232+). `notify_when_idle` (v2.1.236+). **Confirmed.**
- **Transport:** "On this machine: Over a per-session socket on macOS and Linux… never through Anthropic servers". Other machines and cloud sessions go via Remote Control (claude.ai sign-in required). **Confirmed.**

### Delivery semantics

- "The receiving Claude reads the message between tool calls during an active turn… When the receiving session is idle, Claude Code starts a new turn with the message." **Confirmed.**
- Outcomes are Delivered, Held or Refused. **Confirmed.**
- Delivered messages count toward usage like a typed prompt. **Confirmed.**
- `UserPromptSubmit` fires for them. **Confirmed.**

### Inbound controls

- The `crossSessionInbound` setting takes `accept`, `hold` or `refuse`.
- When unset, the default depends on the two sessions' permission-mode classes: a prompting receiver delivers, unless the sender identifies as bypassing; a bypassing receiver holds.
- `dialogExpiry` defaults to 5 min. At most 100 held messages; at most 50 queued accepted messages.
- Rate limits and duplicate drops apply. Size cap is ~1,048,576 characters.
- **Confirmed.**

### Safety semantics

- A peer message "can't approve anything", "can't change configuration", "Commands don't run", and "Permission prompts still fire". **Confirmed.**

### The inbox socket

- "Read this section when… you want a script or hook to post into a session."
- Path: `/status` "Peer address" row (`uds:` prefix), and the `CLAUDE_CODE_MESSAGING_SOCKET` env var exported to hooks and Bash. It falls back to `/tmp/cc-socks-<uid>`.
- Restricted to the OS user.
- Optional first line `{"type":"auth","token":"$CLAUDE_CODE_MESSAGING_TOKEN"}` on Linux (required on Windows).
- Connections without a complete line within 30 s are closed.
- **Own-child messages** (hooks or Bash of that session) are delivered when no `crossSessionInbound` value applies. On Linux this is verified by process evidence.
- `-p` sessions bind a socket too; `--bare` sessions don't.
- **Confirmed.**
- **The message wire format (beyond the auth line) is NOT documented.** **Confirmed absence.** The format is not a public contract.

### Registry

- **`~/.claude/sessions/<pid>.json`:** documented only as "one small file per running session, used to detect concurrent sessions and crashes". There is **no documentation of its fields** (`peerProtocol`, `peerFeatures`, `messagingSocketPath`, `status`, …) and no searchable mention of `peerProtocol` or `peerFeatures` in the docs or changelog. Treat it as an internal, unstable file. **Confirmed** (undocumented).
- **Supported registry instead:** `claude agents --json`, which agent-view calls "the supported way to read session state from outside Claude Code". It gives `pid`, `sessionId`, `name`, `cwd`, `kind`, `status` (`busy`/`waiting`/`idle`) and `waitingFor`. Similarly: "The files under `~/.claude/jobs/<id>/` are not a stable interface." **Confirmed.**

### Mods

A mod (plugins/mods/api) can call:
- `$.session.send({to:{sessionId}, text})`, "the same delivery the SendMessage tool makes"
- `$.prompt.submit({text})`, which starts a turn when the session goes idle; Claude sees the mod named as the sender
- `$.process.spawn`, `$.http.fetch` and `$.ui.notify`
- the `session.receive` hook for inbound peer messages

This is an officially documented in-process extension point that AgentBridge could use instead of raw sockets. **Confirmed** (exists). Its suitability needs prototyping.

### Third-party use: allowed or expected?

- The docs explicitly invite scripts and hooks **of the same session** to post to its socket, via the own-child path.
- They do not document a public protocol for arbitrary external processes, and peer semantics ("Claude writes to another Claude") assume a Claude Code sender.
- An external daemon posting to the socket would be treated as an unverified peer. That is technically delivered to a prompting session by default, but it relies on an undocumented format.
- Classification: **Potentially supported, needs confirmation.** Prefer the documented options: Channels (external → Claude), a mod using `$.prompt.submit`/`$.session.send`, or a hook or Bash child posting to its own session's socket.

### Agent teams

Experimental, enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. A lead plus teammates that share tasks and messages. Claude-only, so it isn't an integration point for a foreign agent. **Confirmed.**

---

## SOURCES

| URL | Section | Finding | Accessed | Confidence |
|---|---|---|---|---|
| https://code.claude.com/docs/en/hooks | Hook lifecycle; Common input fields | Event list; common fields; no `$CLAUDE_MODEL`; model only on SessionStart and Pre/PostModelSwitch | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/hooks | SessionStart, SessionEnd, Stop, StopFailure, SubagentStop, Notification, PreCompact, Pre/PostModelSwitch, UserPromptSubmit | Per-event inputs, timeouts; UserPromptSubmit fires on peer messages | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/statusline | Available data; How status lines work | `model.id`/`display_name`, `session_id`, triggers, `refreshInterval` | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/env-vars | Variables | `CLAUDE_CODE_SESSION_ID` semantics; messaging socket/token; `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `MAX_MCP_OUTPUT_TOKENS`, idle timeout | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/cli-reference | CLI flags | `--fork-session` creates a new session ID instead of reusing the original | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/sessions | Where transcripts are stored; resume | JSONL path; resume restores model, mode; `-p --resume` to ask an existing session | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/claude-directory | sessions/; projects/ | `sessions/` = one file per running session for concurrency and crash detection; transcripts unencrypted | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/agent-view | List sessions as JSON; Read session state from a script | `claude agents --json` is the supported external state API; `status` busy/waiting/idle | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/mcp | Option 3 stdio; scopes; approvals; runtimes; time limits; backgrounding; MCP tasks; output limits; elicitation; channels | See A2 | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/permissions | MCP rule syntax | `mcp__server__tool` forms | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/channels | Whole page | Research preview; auth (claude.ai or Console key); allowlist; `channelsEnabled`; Pro/Max skip org checks; permission pause | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/channels-reference | Whole page | Capability, `notifications/claude/channel`, meta rules, no ack, queue-and-batch, reply tool, permission relay, dev flag ignored in `-p`/SDK | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/cross-session-messaging | Whole page | SendMessage/ListAgents, inbox socket, auth line, inbound controls, limits | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/errors | Cross-session errors | Size cap 1,048,576 chars; inbox-full drop | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/plugins/mods/api | Start a turn; Send and receive messages; Reach network | `$.prompt.submit`, `$.session.send`, `session.receive`, `$.http`, `$.process` | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/plugins/mods/overview | Overview | Mods run with user permissions; CLI, Desktop, VS Code | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/agent-teams | Intro | Experimental, env-flag gated | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/headless | Bare mode | `--bare` doesn't use subscription login; will become `-p` default | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/authentication | Generate a long-lived token | `setup-token` for CI and scripts, uses subscription | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/agent-sdk/overview | Note | No claude.ai login for third-party products unless approved | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/legal-and-compliance | Authentication and credential use; Acceptable use; Offer Claude Code in products | OAuth only for ordinary use; developers use API keys; no routing via plan credentials | 2026-10-30 | Confirmed |
| https://code.claude.com/docs/en/changelog (mirrors GitHub CHANGELOG.md) | 2.1.80, 2.1.81, 2.1.83, 2.1.84, 2.1.126, 2.1.128, 2.1.145, 2.1.224, 2.1.234, 2.1.236, 2.1.243, 2.1.290, 2.1.314 | Version history for channels, agents JSON and cross-session messaging | 2026-10-30 | Confirmed |
| https://www.anthropic.com/legal/consumer-terms | §2, §3 item 7 | Automated access banned except via API key or explicit permission; no credential sharing; effective Oct 8, 2025 | 2026-10-30 | Confirmed (paraphrase from fetch tool) |
| https://www.anthropic.com/legal/aup | Do Not Abuse Our Platform | No routing requests through consumer subscriptions; page shows effective Nov 12, 2026 (anomaly) | 2026-10-30 | Confirmed (date anomaly noted) |
| https://www.anthropic.com/legal/commercial-terms | A.1, D.4 | May power own products; no resale or competing product; effective Jun 17, 2025 | 2026-10-30 | Confirmed |
| https://support.claude.com/en/articles/15036540 | Oct 7, 2026 and Jun 15, 2026 notices | Agent SDK and `claude -p` on plan draw subscription limits; change paused | 2026-10-30 | Partially (dynamic page) |

## Open questions to confirm with Anthropic or by prototyping

1. Can a custom (non-allowlisted) channel be used daily by an individual on Pro/Max without the dev-flag warning? (The docs say no during the preview.)
2. Do channel-started turns fire `UserPromptSubmit`? What are the queue size and TTL for channel events?
3. Is posting to another session's inbox socket from a non-Claude process sanctioned, and is the line format stable?
4. Does a subscription-backed `claude -p` driven by a local bridge, for the subscriber's personal use, count as "ordinary, individual usage"?
