# 03 — Oh My Pi (OMP): nội bộ và API

> Phiên bản cài trên máy: `omp/18.13.3`. Đây là binary Bun đã biên dịch, nên mã nguồn được đọc từ GitHub.
> Tag `v18.13.3` = `413d278a87a69b453efabf8d1fedb9940385e8c6` (2026-10-28) · `main` HEAD = `338d2ce6658dfdbfba19efe0f006f0d5a8edd66d` (2026-10-29).
> Chênh lệch tag → main cho các API dưới đây **chỉ là bổ sung** (`ctx.startLive?`, `pi.registerLinkScheme`, sự kiện `link_activate`, RPC `live_connect`). `runEphemeralTurn`, `sendUserMessage`, đường dẫn phiên và ngữ nghĩa RPC **không đổi**.
> Ký hiệu `CA/` = `packages/coding-agent/src/`. Mọi số dòng tính tại tag `v18.13.3`.

## 1. Tóm tắt

| Câu hỏi | Kết luận | Độ tin cậy |
|---|---|---|
| Có cách nào để tiến trình ngoài **gắn vào phiên TUI đang chạy**? | **Không có sẵn** (trừ `/collab` qua relay WebSocket). Cách duy nhất phù hợp là **extension tự mở IPC** | Confirmed |
| RPC (`--mode rpc`) gắn vào TUI đang chạy? | **Không.** RPC luôn tạo `AgentSession` mới, chỉ dùng stdio | Confirmed |
| Hỏi model hiện tại mà không đổi lịch sử? | **Có:** `ctx.runEphemeralTurn()` | Confirmed |
| Gửi việc vào phiên chính? | **Có:** `pi.sendUserMessage()`, nhưng trả về `void` và phải bắt kết quả qua event | Confirmed |
| Phát hiện model / provider | `ctx.model`, `ctx.models.current()`. **Không có** event đổi model cho extension | Confirmed |
| Busy / idle | `ctx.isIdle()`, `ctx.hasPendingMessages()`, các event `agent_start/agent_end` | Confirmed |
| Discovery mặc định từ bên ngoài | **Không có.** `omp collab list --json` trả `{"hosts": []}` dù đang có 2 phiên OMP chạy (đã chạy trên máy) | Confirmed (thực nghiệm) |
| Ổn định API | **Không có chính sách ổn định.** Changelog có "Breaking Changes" chạm tới extension API | Confirmed |

## 2. B1 — Hệ thống extension

### 2.1 Discovery và load
- `CA/discovery/builtin.ts:61` `getConfigDirs()` trả về **project trước, user sau**:
  - Project: `<cwd>/.omp`, bỏ qua khi `cwd == $HOME` (dòng 64-67).
  - User: `~/.omp/agent`.
- `CA/extensibility/extensions/loader.ts:582` `discoverExtensionPaths()` xét theo thứ tự:
  1. Thư mục `extensions/` (project, rồi user).
  2. Hooks (`.omp/hooks/pre|post`).
  3. Plugin đã cài.
  4. `-e/--extension` và `extensions:` trong settings.
- Khử trùng lặp theo **realpath** (`loader.ts:597-605`). Điều này **mâu thuẫn** với `docs/extension-loading.md` ("De-duplication does not use realpaths"); **code là chuẩn**.
- Có thể tắt bằng `--no-extensions`, `--trusted-extension <abs>`, `disabledExtensions`. `omp --help` trên máy xác nhận `-e, --extension` và `--no-extensions`.
- File TS được Bun import trực tiếp. Factory = `module.default` hoặc chính module (`loader.ts:64`).

### 2.2 Vòng đời
1. Factory chạy tuần tự (`loader.ts:453`). Trong factory chỉ dùng được `register*`, `on`, `events`, `getFlag`, `exec`. Các action ném `ExtensionRuntimeNotInitializedError` cho tới khi runner `initialize`.
2. `session_start` → các event agent/tool → `session_shutdown`. `session_shutdown` có ngân sách **2 s** (`runner.ts:157`).
3. **Deferred load trong TUI** (`startup-deferral.ts`): extension không đăng ký provider hoặc shortcut có thể được nạp **sau** khi composer đã nhận input. Các event phát ra trước đó **không được phát lại**. Extension của AgentBridge cần đọc trạng thái ban đầu bằng `ctx.isIdle()` khi `session_start`, giống cách herdr làm.
4. Factory được **gắn lại cho mỗi subagent** (task tool, `/tan`). Phải lọc bằng `ctx.agent.kind === "main"`, nếu không mỗi subagent sẽ mở một endpoint.

### 2.3 Ranh giới tin cậy (quan trọng cho bảo mật)
- Extension chạy **cùng tiến trình, không sandbox**.
- `ctx.isProjectTrusted()` **luôn trả `true`** (`types.ts:747-754`). **Extension ở cấp project (`.omp/extensions`) được nạp không hỏi.** Một repo độc hại có thể đặt extension giả mạo AgentBridge (xem 08).
- Timeout của handler là **30 s** (`EXTENSION_HANDLER_TIMEOUT_MS`, `runner.ts:133`). Exception trong `setTimeout` thô làm **sập tiến trình**. Phải dùng `ctx.setTimeout` / `ctx.setInterval`.

### 2.4 Bề mặt API (đã xác minh trong `types.ts`)
- `pi`:
  - `on(event, handler)`, `events` (EventBus trong tiến trình).
  - Đăng ký: `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`.
  - Hành động: `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`, `setModel`, `getThinkingLevel`, `getSessionName`…
- `ctx`:
  - Môi trường: `ui` (`confirm` :324, `select` :317, `input` :329, `notify` :349, `setStatus` :355, `setWidget` :361), `mode` (`tui|rpc|json|print`), `hasUI`, `cwd`, `agent {kind, id, depth}`.
  - Phiên và model: `sessionManager` (`getSessionId`, `getSessionFile`, `getEntries`…), `model`, `models.current()`.
  - Trạng thái và điều khiển: `isIdle()`, `hasPendingMessages()`, `abort()`, `getContextUsage()`.
  - Tiện ích: `runEphemeralTurn?()` (:764), `setTimeout`/`setInterval`.
- Event: `session_start`, `session_switch`, `session_shutdown`, `session_stop`, `agent_start`, `agent_end{messages, willContinue?}`, `turn_start/turn_end`, `message_end`, `tool_call`, `tool_execution_*`, `tool_approval_requested/resolved`, `plan_review_*`, `input`, `mcp_notification`, `before_provider_request`, `retry_fallback_applied`…
- **Prior art trên máy:** `~/.omp/agent/extensions/herdr-omp-agent-state.ts` (herdr v10) dùng đúng các API trên và tự mở client `node:net` tới socket ngoài. Đây là bằng chứng rằng mô hình "extension + IPC local" chạy được trong thực tế với 18.13.3.

## 3. B2 — Gắn vào phiên đang chạy

- **Không có endpoint IPC dựng sẵn để prompt một phiên TUI từ ngoài.**
- Broker `~/.omp/run/daemons/<wyhash(projectDir)>/broker.sock` là bộ **giám sát tiến trình nền** (proc services, LSP, browser). Giao thức của nó (`CA/launch/protocol.ts:31-67`: `ping|start|list|logs|wait|send|stop|…`) **không có thao tác prompt hay phiên**. **Không được dựa vào.**
- `clients/<pid>-<uuid>.json` (`launch/presence.ts`) cho biết sự hiện diện của tiến trình omp theo project. Có thể dùng làm gợi ý discovery, nhưng đây là file nội bộ.
- **Extension tự mở server IPC** là cách duy nhất vừa tài liệu hóa vừa local. Nó nhận yêu cầu, gọi `runEphemeralTurn` hoặc `sendUserMessage` **trong chính phiên đó**, rồi trả kết quả. **Không cần tạo thêm tiến trình OMP.**

## 4. B3 — `ctx.runEphemeralTurn()` (ưu tiên cao)

**Khai báo:** `types.ts:764` `runEphemeralTurn?(options: EphemeralTurnOptions): Promise<EphemeralTurnResult>`. Đây là thành viên **optional**, phải feature-detect. API được nối dây trong TUI (`extension-ui-controller.ts:258,490`), RPC/print (`runtime-init.ts:149`) và ACP.

```ts
interface EphemeralTurnOptions {          // CA/session/agent-session-types.ts:622
  promptText: string;
  promptImages?: ImageContent[];
  history?: readonly Message[];           // các side-turn trước, không lưu
  conversationKey?: string;
  tools?: false;                          // bỏ tool defs, toolChoice "none"
  maxTokens?: number;
  minimizeEffort?: boolean;
  maxContextBytes?: number;               // trần UTF-8 của context sau biến đổi
  onTextDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
  dedupeReply?: boolean;                  // mặc định true
  replyMaxBytes?: number;                 // mặc định 4 KiB
}
interface EphemeralTurnResult { replyText: string; assistantMessage: AssistantMessage; }
```

| Khía cạnh | Hành vi thực tế (`agent-session.ts:12598`) | Hệ quả cho AgentBridge |
|---|---|---|
| Model | `this.model`, tức **model hiện tại**, **không override được** | Đáp ứng đúng yêu cầu "OMP dùng model đang chọn" |
| Đổi model giữa chừng | Ném `"Active model changed during ephemeral turn; retry."` (:12611) | Báo lỗi `model_changed` và cho phép retry |
| Snapshot context | `[...this.messages]` + **text assistant đang stream** + nhắc "no tools" + `history` + prompt (`#buildEphemeralSnapshot` :12809). Hook `context`/provider vẫn chạy | Có cả nội dung đang dở. Xem mục Privacy |
| Khi agent chính bận | **Được phép**, không chặn hay can thiệp lượt chính. Dùng provider session id riêng `${sessionId}:side:<id>` | Consultation không làm gián đoạn OMP |
| Tool | Tool call **luôn bị loại bỏ, không thực thi** | **Cấu trúc read-only**: OMP không thể ghi file hay gọi ngược Claude trong consultation, nên không thể sinh vòng lặp |
| Giới hạn | `maxTokens`, `maxContextBytes` (số nguyên dương). **Transport không giữ được output limit thì từ chối `maxTokens` trước inference** (`ephemeralMaxTokensRejection`, :859; theo docs gồm Codex Responses, Cursor, Antigravity…) | **Rủi ro thực tế:** nếu OMP dùng OpenAI qua Codex transport, phải bỏ `maxTokens`, tức lượt không giới hạn output. Cần Thí nghiệm 2 |
| Kích thước reply | Mặc định **4 KiB** (`replyMaxBytes`), có dedupe | Đặt `replyMaxBytes` rõ ràng (ví dụ 64 KiB) |
| Streaming | `onTextDelta` được await tuần tự. Lỗi giao nhận sẽ hủy request | Chuyển thành MCP progress notification |
| Hủy | `signal`, **kết hợp với signal của event handler đang chạy** | **Không gọi trong event handler** (30 s rồi bị hủy). Gọi từ callback IPC, vốn không phải handler |
| Lồng nhau | Chỉ cấm khi gọi từ hook `context`/`before_provider_request`/`after_provider_response` *bên trong* side turn | Không có mutex. Extension phải tự giới hạn đồng thời |
| Usage | **Không** ghi vào usage của phiên. Chỉ có ở `assistantMessage.usage` | AgentBridge tự ghi audit usage |
| Lưu trữ | *"The session's history is NOT modified"* | Consultation không đổi transcript (cần Thí nghiệm 2 xác nhận) |
| Privacy | Gửi **toàn bộ snapshot hội thoại** tới provider của OMP. Secret obfuscation áp dụng cho chiều đi | Câu trả lời quay về Claude, tức về Anthropic. Cần consent và redaction (xem 08) |

Docs của OMP (`docs/extensions.md:381-407`) **nêu đích danh use-case bridge**: *"a Synadia/NATS bridge can answer another agent's question from the local context and stream the response back without injecting a live user message… Bridge extensions must obtain user consent where appropriate, authenticate and authorize callers, and audit every remote request."*

## 5. `pi.sendUserMessage()` so với `runEphemeralTurn()`

`sendUserMessage(content, { deliverAs?: "steer"|"followUp"|"aside", attribution?: "user"|"agent" }): void` (`types.ts:1949`, `agent-session.ts:10230`)

| Trạng thái | `deliverAs` bỏ trống | `"steer"` | `"followUp"` | `"aside"` |
|---|---|---|---|---|
| idle | bắt đầu lượt | **chỉ xếp hàng, không chạy** | **chỉ xếp hàng, không chạy** | bắt đầu lượt |
| busy | steer (cắt batch tool còn lại) | steer | chạy sau khi lượt hiện tại xong | chèn ở ranh giới bước, không hủy tool |

- Trả về `void`. Không có message id, không await được. Kết quả lấy từ `agent_end.messages`, bỏ qua khi `willContinue === true`. Tương quan giữa yêu cầu và lượt trả lời chỉ ở mức heuristic: "lượt đang chạy hoặc lượt kế tiếp".
- **Được lưu vào transcript** như một prompt gõ tay. Không mở rộng slash command.

| | **Consultation** | **Delegation** |
|---|---|---|
| API | `runEphemeralTurn` | `sendUserMessage` + bắt `agent_end` |
| Đổi lịch sử | Không | **Có** |
| Tool / ghi file | Không (tool bị loại) | Có, dùng tool bình thường **và vẫn qua cơ chế phê duyệt của OMP** |
| Khi OMP bận | Chạy song song | Xếp hàng `followUp` (khuyến nghị) |
| Tương quan kết quả | Chính xác (Promise) | Heuristic |
| Rủi ro | Thấp | Trung bình đến cao (ghi file, xung đột với Claude) |

→ **Phân biệt Consultation / Delegation trong đề bài là chính xác** và khớp với implementation.

## 6. B4 — Giao diện thay thế

| Giao diện | Gắn vào TUI đang chạy? | Ghi chú |
|---|---|---|
| `--mode rpc` / `rpc-ui` | **Không.** `main.ts:2766` tạo session mới rồi mới `runRpcMode(session)`. Chỉ stdio JSONL | Resume cùng file từ tiến trình thứ hai sẽ bị lease (`session-storage.ts:1300 claimSession`) đẩy sang **file mới với session id mới** (`#moveOffSessionFile`) |
| `-p` / `--mode json` | Không, chạy một lần | |
| `omp acp` | Không, server stdio do client spawn | |
| SDK (`createAgentSession`) | Không, nhúng trong tiến trình | |
| `/collab` | **Có**: guest prompt, abort, điều khiển subagent | Cần relay WebSocket (mặc định `wss://my.omp.sh`, mã đóng), giao thức nội bộ, link mã hóa E2E. Chỉ publish host khi bật `collab.autoStart` hoặc đã chạy `/collab`. **Vi phạm local-first nếu dùng relay mặc định** |
| `mcp_notification` | Gián tiếp | OMP là **MCP client**. Một MCP server dùng chung có thể đẩy notification vào OMP, rồi extension gọi `sendUserMessage`. Đường vào không cần socket riêng, nhưng vẫn cần extension |
| IrcBus / Agent Hub / subagents | Chỉ trong tiến trình | |

## 7. Phát hiện model và đổi model

- `ctx.model` / `ctx.models.current()` trả `{provider, id, api, name, contextWindow, …}`.
- **Không có event `model_changed` cho extension** (`agent-session.ts:12183`: *"`model_changed` has no extension-facing hook"*). Cách lấy model mới nhất:
  - **Đọc lười** tại thời điểm trả `status` hoặc nhận `consult`. Đây là cách đủ và đơn giản nhất.
  - Hoặc cập nhật ở `turn_start`, `before_provider_request`, `retry_fallback_applied`.
  - Hoặc đọc entry `model_change` trong `sessionManager.getEntries()`.

## 8. Lưu trữ phiên
- `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuidv7>.jsonl`. Encode cwd trong `$HOME`: `/home/you/projects/agentbridge` → `-projects-agentbridge`. Cách encode **mất thông tin** (`a-b/c` và `a/b-c` trùng nhau), nên **không dùng tên thư mục để suy ra project**.
- Session id là UUIDv7 (`mintSessionId`). Có lease ghi đơn tại `~/.omp/run/session-owners`.

## 9. Windows
- IPC nội bộ của OMP dùng Rust native (`crates/pi-natives/src/ipc/mod.rs:141` `ipcEndpoint`): Unix là `<dir>/<stem>.sock` (fallback `/tmp/omp-<euid>/<hash>.sock` khi path dài), Windows là `\\.\pipe\omp-<stem>-<hash16>`.
- Extension có thể import `@oh-my-pi/pi-natives` qua cơ chế rewrite (Partially, không phải API được tài liệu hóa cho extension).
- `node:net` với named pipe trên Bun Windows (cách herdr làm) **chưa được kiểm chứng** từ mã OMP. Cần Thí nghiệm W1 trên Windows.
- Reload extension trên Windows không có cache-buster.

## 10. Tương thích và ổn định
- Không có cam kết semver cho extension API. Nhịp phát hành rất nhanh (18.13.0 → 18.13.3 trong 3 ngày).
- **Khuyến nghị:**
  - Feature-detect mọi lời gọi (`typeof ctx.runEphemeralTurn === "function"`).
  - Ghi `omp` version range đã kiểm thử vào manifest.
  - Hiện cảnh báo trong TUI (`ctx.ui.notify`) khi gặp phiên bản lạ.

## Nguồn
Xem `SOURCES.md`, mục B.
