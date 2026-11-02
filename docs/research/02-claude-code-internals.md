# 02 — Claude Code: cơ chế tích hợp được hỗ trợ

> Phiên bản khảo sát: **Claude Code 2.1.314** (cài trên máy, Linux). Changelog chính thức mới nhất cũng là 2.1.314 (30/10/2026), nên tài liệu và binary khớp nhau.
> Ngày truy cập tài liệu: 2026-10-30.
> Độ tin cậy: **Confirmed** = văn bản chính thức nói trực tiếp hoặc đã quan sát trên máy · **Partially** = suy ra từ văn bản hoặc chỉ một phần · **Unverified** = không có bằng chứng.

## 1. Tóm tắt

| Cơ chế | Dùng cho AgentBridge | Trạng thái | Độ tin cậy |
|---|---|---|---|
| **stdio MCP server** (scope user/project) | Kênh **Claude → OMP** chính (tool `agent_*`) | GA | Confirmed |
| **`claude agents --json`** | Discovery phiên Claude từ bên ngoài (pid, sessionId, cwd, status) | GA từ 2.1.145 | Confirmed (đã chạy) |
| **Hooks** (SessionStart, UserPromptSubmit, Stop, PostModelSwitch…) | Theo dõi vòng đời, model; tiêm "có N ghi chú chưa đọc" vào lượt của người dùng | GA | Confirmed |
| **Cross-session messaging** (`ListAgents`/`SendMessage`, inbox socket) | Đẩy tin vào phiên Claude đang chạy (OMP → Claude) | GA từ 2.1.224 (Linux), 2.1.234 (Windows) | Confirmed. Frame format cho người gửi **không phải Claude** thì **không được tài liệu hóa** |
| **Channels** | Đẩy sự kiện vào phiên Claude, có reply tool | **Research preview** | Confirmed |
| **Mods** (`$.session.send`, `$.prompt.submit`, `$.ui.notify`) | Tiện ích trong tiến trình Claude, ứng viên cho thông báo không tốn inference | Đã tài liệu hóa | Confirmed (tồn tại), chưa prototype |
| `~/.claude/sessions/<pid>.json` | **Không dùng.** Là file nội bộ | Chỉ được mô tả là "phát hiện phiên đồng thời và crash" | Confirmed (fields không có tài liệu) |
| Transcript `~/.claude/projects/<proj>/<id>.jsonl` | Không dùng trong MVP | Định dạng không phải API ổn định, có thể chứa secret | Confirmed |

## 2. A1 — Vòng đời phiên và discovery

### 2.1 Nguồn định danh phiên

1. **`claude agents --json`** là nguồn chính thức. Trang agent-view viết: *"`claude agents --json` is the supported way to read session state from outside Claude Code."* (https://code.claude.com/docs/en/agent-view).
   - Kết quả chạy trên máy (2026-10-30):
     ```json
     [{"pid":3221216,"cwd":"/home/you/projects/agentbridge","kind":"interactive",
       "startedAt":1793352545312,"sessionId":"00000000-0000-4000-8000-000000000000",
       "name":"agentbridge-e6","status":"busy"}]
     ```
   - Tài liệu còn nêu `status ∈ {busy, waiting, idle}` và `waitingFor` (permission prompt, input needed…).
   - **Quan sát thực nghiệm:** socket `/run/user/1000/cc-socks/3105669.sock` còn sót lại dù tiến trình 3105669 đã chết, nhưng `claude agents --json` **không** liệt kê nó. Lệnh này tự kiểm tra liveness.
2. **Biến môi trường trong stdio MCP server:** `CLAUDE_CODE_SESSION_ID` và `CLAUDE_PROJECT_DIR` (env-vars).
   - **Bẫy:** *"An MCP server subprocess retains the ID it was spawned with… On `--continue` or `--resume` without an explicit ID it may receive the initial startup ID instead."* Sau `/clear`, ID trong MCP server có thể đã cũ.
   - Cách khắc phục: MCP server lấy pid của tiến trình cha (claude), rồi tra `claude agents --json` để có `sessionId` hiện tại. Giả định "MCP server là con trực tiếp của tiến trình `claude`" ở mức **Partially**, cần Thí nghiệm 1b.
3. **Hooks:** mọi hook nhận `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id` (https://code.claude.com/docs/en/hooks, "Common input fields").
4. **Resume:** `--resume`/`--continue` **giữ nguyên session ID**. Chỉ `--fork-session` tạo ID mới (cli-reference). `/clear` tạo phiên mới (`SessionStart.source = "clear"`).

### 2.2 Model hiện tại

- Hooks: *"Only `SessionStart` hooks can receive a `model` field, and Claude Code doesn't always include it… use a PostModelSwitch hook… There is no `$CLAUDE_MODEL` environment variable."* `PreModelSwitch`/`PostModelSwitch` có từ **2.1.251**. Confirmed.
- Statusline nhận `model.id` và `model.display_name`. Confirmed.
- **Kết luận:** OMP hiếm khi cần biết model của Claude. Khi cần, dùng hook `PostModelSwitch` ghi `to_model` vào registry của AgentBridge.

### 2.3 Busy / idle / waiting

| Tín hiệu | Ý nghĩa | Ghi chú |
|---|---|---|
| `claude agents --json` `.status` | busy / waiting / idle | Poll được, không cần hook |
| `UserPromptSubmit` → `Stop`/`StopFailure` | bắt đầu / kết thúc lượt | `Stop` không chạy khi người dùng ngắt |
| `Notification` (`permission_prompt` ~6 s, `idle_prompt` ~60 s) | chờ người | Có độ trễ |
| `PermissionRequest` | chờ phê duyệt, tức thời | |

### 2.4 Độ tin cậy của hook

- `SessionEnd` có ngân sách mặc định 1,5 s. Không có tài liệu nào đảm bảo `SessionEnd` chạy khi crash.
- Vì vậy **liveness phải dựa vào pid + thời điểm khởi động tiến trình + handshake**, không dựa vào `SessionEnd`.

### 2.5 Nhiều phiên Claude trong cùng thư mục

`claude agents --json` trả nhiều bản ghi cùng `cwd`. Định danh duy nhất là `sessionId` (và `pid`). MCP server của mỗi phiên là một tiến trình riêng: *"Claude Code reads your MCP config at startup and spawns each server as a subprocess"*. Như vậy **mỗi phiên Claude có một MCP server riêng và tự biết mình phục vụ phiên nào**. Đây là điểm mạnh then chốt cho thiết kế không cần daemon.

## 3. A2 — MCP

| Chủ đề | Sự thật | Nguồn | Độ tin cậy |
|---|---|---|---|
| Transport | stdio, HTTP, SSE, WebSocket | /mcp "Installing MCP servers" | Confirmed |
| Scope | local > project (`.mcp.json`) > user > plugin | /mcp "scopes" | Confirmed |
| Phê duyệt server project | Phiên interactive hỏi trước khi dùng server trong `.mcp.json` | /mcp | Confirmed |
| Quyền tool | `mcp__agentbridge__agent_consult`, `mcp__agentbridge__*` | /permissions | Confirmed |
| Ép phê duyệt từng lần | `_meta["anthropic/requiresUserInteraction"]: true`, hỏi mọi lần kể cả bypass mode | /mcp "Require approval for a specific tool" | Confirmed |
| Timeout khởi động | `MCP_TIMEOUT` = 30 000 ms | /env-vars | Confirmed |
| Timeout tool | `MCP_TOOL_TIMEOUT` (mặc định rất lớn). Idle timeout stdio 30 phút, được reset bởi **progress notification** | /mcp "Time limits" | Confirmed |
| Tự chuyển nền | Tool chạy > **2 phút** chuyển thành background task. Claude tiếp tục làm việc, kết quả về dưới dạng task notification (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`) | /mcp | Confirmed |
| Hủy | `Esc` / dừng task gửi yêu cầu hủy, *"doesn't guarantee the server stops"* | /mcp | Confirmed |
| Giới hạn output | Cảnh báo > 10k tokens; `MAX_MCP_OUTPUT_TOKENS` = 25 000; > 50 000 ký tự thì lưu ra file | /mcp | Confirmed |
| MCP tasks (server-side) | Beta từ 2.1.304, cần protocol 2026-07-28 | /mcp | Confirmed |

**Kết luận A2:** bộ tool sau khả thi bằng một stdio MCP server bình thường: `agent_list`, `agent_status`, `agent_consult` (gọi là `agent_ask` trong đề bài), `agent_delegate` (`agent_send`), `agent_task_status`, `agent_get_result`, `agent_cancel`.
- Consultation dài vẫn an toàn nhờ progress notification và cơ chế tự chuyển nền sau 2 phút.
- **Không cần Channels cho hướng Claude → OMP**, vì Claude chủ động gọi tool.

## 4. A3 — MCP Channels

Nguồn: https://code.claude.com/docs/en/channels , https://code.claude.com/docs/en/channels-reference

| Câu hỏi | Trả lời | Độ tin cậy |
|---|---|---|
| Channel local tự viết có được hỗ trợ chính thức? | Có ở mức **development**: `--dangerously-load-development-channels server:<name>`, hiện hộp thoại cảnh báo toàn màn hình **mỗi lần khởi động**. `--channels` chỉ nhận plugin trong allowlist của Anthropic hoặc `allowedChannelPlugins` của tổ chức. *"The community marketplace is not on the channel allowlist."* | Confirmed |
| Độ trưởng thành | **Research preview** từ 2.1.80. *"the `--channels` flag syntax and protocol contract may change"* | Confirmed |
| Gắn vào phiên đang chạy? | **Không.** Phiên phải được **khởi động với** cờ `--channels`/dev flag. Không gắn được vào phiên đã chạy sẵn | Confirmed |
| Đưa tin vào hội thoại thế nào? | Server khai báo `capabilities.experimental['claude/channel']` và gửi `notifications/claude/channel` `{content, meta}`. Model thấy `<channel source="…">…</channel>` | Confirmed |
| Có kích hoạt inference? | Có. Phiên idle bắt đầu lượt mới. Phiên busy thì sự kiện xếp hàng và được giao gộp ở lượt sau | Confirmed (qua ví dụ + câu quy tắc) |
| Trả lời về bên gọi? | Qua một MCP tool `reply` do server cung cấp, chịu quyền bình thường | Confirmed |
| ACK giao / xử lý / hoàn tất | **Không có.** *"Claude Code doesn't acknowledge notifications… resolves when the message is written to the transport"*. Server chưa được nạp làm channel thì sự kiện bị **drop im lặng** | Confirmed |
| Đang chờ phê duyệt | *"the session pauses until you respond"* | Confirmed |
| Buffer khi mất kết nối | Không có tài liệu về dung lượng hay TTL | Unverified |
| Nhiều channel / nhiều phiên | Truyền được nhiều channel. Mỗi phiên spawn server riêng nên mỗi phiên có channel riêng | Confirmed |
| Xác thực | claude.ai **hoặc** Console API key (từ 2.1.128). Không có trên Bedrock / Vertex / Foundry | Confirmed |
| `-p` / Agent SDK | Dev flag **bị bỏ qua** | Confirmed |
| Bẫy protocol | Server thương lượng MCP 2026-07-28 **không** được đăng ký làm channel. Dùng `MCP_PROTOCOL_NEGOTIATION=legacy` | Confirmed |

Phân biệt ba mức đảm bảo:

| Mức | Channels cung cấp? |
|---|---|
| **Delivery** (đã ghi vào transport) | Có, nhưng không ACK. Có thể bị drop im lặng |
| **Model processing** (model đã đọc) | Không có tín hiệu. Chỉ suy ra qua hook `Stop` / `UserPromptSubmit` |
| **Task completion** | Không có. Phải tự xây bằng reply tool |

**Kết luận A3:** Channels **không phù hợp làm kênh chính** cho MVP, vì:
1. Đang preview, cần dev flag kèm cảnh báo mỗi lần chạy.
2. Không gắn được vào phiên đã mở. Điều này mâu thuẫn trực tiếp với UX "mở `claude` như bình thường".
3. Không có ACK.
4. Mỗi sự kiện **kích hoạt inference trên subscription**, xem phân tích tuân thủ ở 08.

Channels chỉ đáng giữ làm **tùy chọn opt-in giai đoạn 3** cho hướng OMP → Claude.

## 5. Cross-session messaging (phát hiện bổ sung)

Nguồn: https://code.claude.com/docs/en/cross-session-messaging

- Mỗi phiên có một inbox socket: UDS 0600 trên Linux/macOS, named pipe trên Windows. Đường dẫn nằm trong `CLAUDE_CODE_MESSAGING_SOCKET`, xem được ở `/status` → "Peer address". Token xác thực tùy chọn là `CLAUDE_CODE_MESSAGING_TOKEN` (bắt buộc trên Windows).
- **Ngữ nghĩa giao nhận:**
  - Phiên busy đọc tin giữa các tool call.
  - Phiên idle **bắt đầu lượt mới**.
  - `UserPromptSubmit` được kích hoạt.
  - Tin nhắn được tính vào usage như prompt gõ tay.
- **An toàn:** tin của peer *"can't approve anything… can't change configuration… Commands don't run… Permission prompts still fire"*. Có `crossSessionInbound: accept|hold|refuse`. Giới hạn ~1 MB mỗi tin, 50 tin trong hàng đợi, 100 tin bị hold.
- **Giới hạn quan trọng:** tài liệu chỉ mô tả hook / Bash **của chính phiên đó** post vào socket của nó (gọi là "own-child"). **Wire format ngoài dòng auth không được công bố.** `agent-intercom-claude` (AGPL) tự suy ra frame `msgV:1`, nhưng đó không phải hợp đồng công khai.
- `~/.claude/sessions/<pid>.json` (có `peerProtocol`, `peerFeatures`, `messagingSocketPath`, `status`) **không có tài liệu về field**. Không được dựa vào.

**Kết luận:** về kỹ thuật, đây là đường "push vào phiên Claude đang chạy" tốt nhất. Nhưng với người gửi là OMP thì nó dựa vào hành vi không được tài liệu hóa, và mỗi tin kích hoạt inference. Phân loại: **chưa đưa vào MVP**, chờ xác nhận (xem 11-open-questions).

## 6. Hooks hữu ích cho AgentBridge (không tốn inference)

| Hook | Dùng để |
|---|---|
| `SessionStart` (`source`, `model?`) | Ghi bản ghi "Claude session" vào registry nếu muốn OMP thấy model của Claude |
| `PostModelSwitch` (`to_model`) | Cập nhật model |
| `UserPromptSubmit` → `additionalContext` | Khi **người dùng** gõ prompt, tiêm dòng "AgentBridge: có 2 ghi chú chưa đọc từ OMP (gọi `agent_inbox`)". Không tạo lượt inference mới |
| `Stop` (`last_assistant_message`) | (Tùy chọn) ghi nhận Claude đã xử lý xong |
| `SessionEnd` | Dọn registry, chỉ best-effort |

## 7. Hạn chế và rủi ro phía Claude Code

1. `CLAUDE_CODE_SESSION_ID` trong MCP server có thể cũ, nên phải đối chiếu theo pid.
2. Không có ACK cho Channels và inbox. Hoàn tất phải xác nhận ở tầng ứng dụng.
3. Tool MCP > 2 phút tự chuyển nền. Đây là ưu điểm (không chặn phiên) nhưng caller phải xử lý kết quả đến muộn.
4. Server project `.mcp.json` cần phê duyệt. Khuyến nghị cài ở **scope user**.
5. Tính năng thay đổi nhanh (2.1.80 → 2.1.314 trong vài tháng). Cần feature-detect theo phiên bản.

## Nguồn
Xem `SOURCES.md`, mục A.
