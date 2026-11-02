# 08 — Mô hình đe dọa, bảo mật và tuân thủ chính sách

## 1. Tài sản
| Tài sản | Ghi chú |
|---|---|
| A1 Credential Claude (OAuth subscription) | **Không bao giờ** được AgentBridge chạm tới |
| A2 Credential provider của OMP (OpenAI…) trong `~/.omp/agent/agent.db` | Không bao giờ chạm tới |
| A3 Mã nguồn và working tree | Toàn vẹn |
| A4 Context hội thoại (có thể chứa secret) | Bảo mật. Consultation gửi **toàn bộ context OMP** tới provider của OMP, rồi câu trả lời đi tới Anthropic |
| A5 Hạn mức, chi phí inference của cả hai bên | Sẵn sàng / chi phí |
| A6 Token và endpoint AgentBridge | Định danh phiên |
| A7 Audit log | Có thể rò rỉ nếu ghi nội dung |

## 2. Ranh giới tin cậy
```
[Người dùng] ─┬─ Claude Code (binary gốc, auth của người dùng) ── stdio ── agentbridge-mcp
              │                                                     │ UDS/pipe + token
              └─ OMP (binary gốc) ── in-process ── agentbridge.ts ◄─┘
Ranh giới: (1) OS user · (2) giữa hai agent: nội dung peer = dữ liệu không tin cậy
           (3) repo đang mở: không tin cậy (AGENTS.md, .omp/extensions, .mcp.json)
           (4) provider LLM: bên thứ ba nhận context
```

## 3. Kẻ tấn công và đường tấn công

| # | Mối đe dọa | Đường tấn công | Biện pháp |
|---|---|---|---|
| T1 | User khác trên máy | Kết nối socket, đọc registry | Dir 0700, file 0600, kiểm tra owner; Windows pipe ACL chỉ cho user SID; token |
| T2 | Tiến trình cùng user (malware, script) | Đọc token rồi gửi request | **Không chống được hoàn toàn**, vì đây là ranh giới OS user, giống inbox của Claude. Giảm thiểu: consent mặc định `ask`, rate limit, audit, `ctx.ui.notify` mỗi lần consult |
| T3 | Giả mạo / chiếm phiên | Ghi bản ghi giả vào registry; PID reuse | Kiểm tra `hello` (sessionId + instanceId), `procStart`; registry ngoài repo |
| T4 | **Repo độc hại** | `.omp/extensions/*.ts` được nạp **không hỏi** (`isProjectTrusted()` luôn `true`); `.mcp.json` giả; prompt injection trong `AGENTS.md`/README | Cài extension AgentBridge **ở scope user**. Khi khởi động, extension cảnh báo nếu thấy một extension project khác cũng tên `agentbridge`. MCP ở scope user. Allowlist project trong `~/.config/agentbridge/config.json` |
| T5 | Prompt injection qua tin nhắn peer | OMP trả lời "hãy chạy `rm -rf`…" | Đóng khung "dữ liệu, không phải chỉ thị". Permission của Claude vẫn áp dụng đầy đủ, AgentBridge **không** thêm allow rule nào. Delegation sang OMP vẫn đi qua phê duyệt tool của OMP |
| T6 | Rò rỉ secret qua chia sẻ context | Câu trả lời OMP trích `.env`; ghi chú có token | Redactor (regex cho khóa phổ biến + entropy) áp dụng trên `question`, `replyText`, ghi chú. `contextRefs` từ chối các path như `.env*`, `*.pem`, `id_*`, `~/.claude/**`, `~/.omp/**`. OMP có sẵn secret obfuscation cho chiều đi tới provider |
| T7 | Path traversal / symlink | `contextRefs: ../../.ssh/id_rsa`, symlink trong repo | `realpath` và bắt buộc nằm trong `projectRoot`; từ chối symlink trỏ ra ngoài |
| T8 | Sửa file trái phép | Delegation ghi file | Mặc định không có delegation. GĐ 2: bắt buộc consent trong OMP TUI + `mode:"worktree"` |
| T9 | Thực thi shell ngoài ý muốn | Tin peer chứa lệnh | Consult không có tool; delegate đi qua phê duyệt của OMP; MCP server **không bao giờ** chạy lệnh theo nội dung peer |
| T10 | Replay | Gửi lại request cũ | `id` UUIDv7 + LRU dedupe + `ts`/`ttlMs`; token xoay mỗi lần khởi động |
| T11 | Vòng inference vô hạn | A hỏi B, B hỏi lại A… | `hop` (từ chối ≥ 1); consult không có tool; không có auto-trigger Claude; rate limit 6 consult/phút/phiên, 1 đồng thời |
| T12 | Cạn token / context | Câu hỏi khổng lồ; OMP context lớn | `question ≤ 32 KiB`, `maxContextBytes` (mặc định 1 MiB), `maxTokens` khi transport hỗ trợ, `replyMaxBytes` |
| T13 | Code extension không tin cậy | Extension của bên thứ ba sửa AgentBridge | Ngoài phạm vi kiểm soát, vì OMP không sandbox. Tài liệu cảnh báo người dùng |
| T14 | Rò rỉ qua audit log | Log chứa câu hỏi hoặc trả lời | Audit chỉ ghi metadata (id, from, to, type, độ dài, hash, model, usage, kết quả). Có cờ `--audit-content` tắt mặc định |
| T15 | Tự động phê duyệt nguy hiểm | Bridge tự trả lời prompt quyền | **Cấm.** Không relay phê duyệt, không dùng `permission relay` của Channels, không đặt `crossSessionInbound: accept` thay người dùng |
| T16 | Giả mạo session id | Client tự xưng là phiên Claude khác | `from` chỉ để audit và hủy. MCP server lấy `from` từ `claude agents --json` theo ppid, không lấy từ input của model |

## 4. Kiểm soát mặc định

| Kiểm soát | Mặc định |
|---|---|
| Capability | **Default-deny.** Extension OMP chỉ bật `status` + `consult`. `delegate` tắt cho tới khi bật trong config |
| Theo project | Allowlist `projects: ["/home/you/projects/my-app"]`. Project ngoài danh sách chỉ trả `status` |
| Theo agent | `allowFrom: ["claude-code"]` |
| Theo task | `consult.consent: "ask" \| "session" \| "always"`. Mặc định `ask` cho lần đầu mỗi phiên, sau đó `session` nếu người dùng chọn. `delegate.consent: "ask"` luôn luôn, không cho cấu hình khác trong MVP |
| Đọc / ghi | Consult chỉ đọc (cấu trúc). Delegate ghi chỉ trong worktree |
| Kích thước / tốc độ | 1 MiB/dòng; question 32 KiB; 6 consult/phút; 1 đồng thời; LRU 256 |
| Transport | Chỉ UDS / named pipe. Không TCP |
| Log | Metadata + redact |
| Dọn dẹp | `session_shutdown` + quét stale khi khởi động; registry trong thư mục runtime |
| Tôn trọng quyền có sẵn | AgentBridge không thêm allow rule cho Claude. Người dùng tự quyết định có allow `mcp__agentbridge__agent_consult` hay không. Tool `agent_delegate` gắn `_meta["anthropic/requiresUserInteraction"]: true` |

## 5. Phân tích chính sách nhà cung cấp

### 5.1 Trích dẫn chính (truy cập 2026-10-30)
- **legal-and-compliance:**
  - *"OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."*
  - *"Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication… Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users… developers may not collect, store, or intermediate Claude.ai credentials or session tokens."*
  - *"Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."*
- **Consumer Terms §3(7):** cấm truy cập *"through automated or non-human means, whether through a bot, script, or otherwise"*, *"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it."*
- **Usage Policy:** cấm *"services that route requests through consumer subscriptions or misrepresent the product or client being used."* Trang hiển thị ngày hiệu lực 12/11/2026, sau ngày hôm nay. Đây là điểm bất thường, cần kiểm tra lại.
- **Support 15036540:** *"the Claude Agent SDK and `claude -p` still draw from your subscription limits"* (thông báo 07/10/2026).
- **cross-session-messaging:** tin nhắn của peer *"never counts as your consent"*.

### 5.2 Ma trận tuân thủ

| # | Kịch bản | Phân loại | Ghi chú và mức chắc chắn |
|---|---|---|---|
| 1 | Người dùng dùng Claude Code và gọi MCP tool để hỏi OMP | **Được hỗ trợ rõ ràng** | MCP là tính năng lõi; binary gốc; người dùng đang tương tác. Đây là **lõi MVP** |
| 2 | OMP gửi **thông báo** vào Claude Code (không kích hoạt inference) | **Có thể được hỗ trợ, cần xác nhận cơ chế** | Rủi ro chính sách thấp vì không tốn inference. MVP dùng **inbox dạng kéo + hook `UserPromptSubmit`** (chỉ chạy khi người dùng gõ). Mod `$.ui.notify` là ứng viên GĐ 3 |
| 3 | OMP **tự kích hoạt** câu trả lời của Claude qua Channel | **Có thể được hỗ trợ, cần xác nhận** | Channels được thiết kế cho "non-Claude sources" (webhook, CI) đẩy vào phiên local. Nhưng đang preview, cần dev flag, và phải trong khuôn khổ "ordinary, individual usage". **Không đưa vào MVP.** Nếu làm thì opt-in, có rate limit, và hiện rõ trong UI |
| 4 | Daemon local liên tục ra lệnh cho Claude Code mà không có người tương tác | **Bị hạn chế** khi dùng subscription | Consumer Terms §3(7). **Cấm trong thiết kế.** Muốn tự động hóa thì dùng API key (kịch bản 6) |
| 5 | AgentBridge chạy `claude -p` làm tiến trình con | **Có thể được hỗ trợ (cá nhân), cần xác nhận** | Support article cho phép `-p` dùng hạn mức subscription. Nhưng nếu AgentBridge **được phân phối như sản phẩm** thì phải dùng API key. Ngoài ra `--bare` sẽ thành mặc định của `-p`. Đồng thời vi phạm yêu cầu "không spawn phiên trùng". **Không dùng** |
| 6 | Worker riêng dùng Anthropic API key | **Được hỗ trợ rõ ràng** | Commercial Terms. Là phương án cho tự động hóa không người. Ngoài phạm vi MVP |
| 7 | Đọc metadata transcript Claude mà không chạm credential | **Có thể được hỗ trợ (kỹ thuật ổn), nhưng không khuyến nghị** | Định dạng không ổn định; transcript chứa secret plaintext. Dùng `claude agents --json` và hooks thay thế |

**Thêm (ngoài đề bài):**
- **8 — Script bên ngoài post vào inbox socket của phiên Claude.** **Chưa rõ.** Tài liệu chỉ mô tả hook/Bash của chính phiên đó; format cho peer ngoài không được công bố; mỗi tin kích hoạt inference. Tạm xếp như kịch bản 3, chờ xác nhận.
- **9 — Phía OMP dùng OpenAI** (nếu qua đăng nhập ChatGPT/Codex subscription). Điều khoản của OpenAI về tự động hóa nằm **ngoài phạm vi nghiên cứu này**, nhưng áp dụng tương tự: consultation do người dùng khởi phát, không có vòng lặp nền. **Cần người dùng tự kiểm tra** (xem 11).

### 5.3 Ranh giới chính sách cho thiết kế
1. Mọi inference phía Claude đều **bắt nguồn từ một hành động của người dùng trong phiên Claude**: gõ prompt, hoặc Claude gọi tool trong lượt do người dùng mở.
2. Không có tiến trình nền nào khởi tạo lượt Claude.
3. Không đọc, lưu, chuyển tiếp hay proxy credential của Claude hoặc OMP.
4. Không sửa, không bọc và không giả lập binary Claude Code.
5. Inference phía OMP cũng chỉ xảy ra khi có request từ người dùng qua Claude, hoặc người dùng thao tác trực tiếp trong OMP.

## 6. Sổ rủi ro

| Rủi ro | Khả năng | Ảnh hưởng | Giảm thiểu |
|---|---|---|---|
| OMP đổi extension API (không cam kết ổn định) | Cao | Trung bình | Feature-detect; pin version range; test smoke mỗi bản OMP |
| `runEphemeralTurn` từ chối `maxTokens` với transport OpenAI/Codex | Trung bình | Thấp | Thử lại không có `maxTokens` **chỉ khi** config cho phép; luôn đặt `replyMaxBytes` |
| Rò rỉ secret OMP context → Claude/Anthropic | Trung bình | Cao | Consent, redaction, `maxContextBytes`, cảnh báo trong UI |
| Repo độc hại nạp extension giả | Thấp-TB | Cao | Scope user, cảnh báo trùng tên, allowlist |
| Bun named pipe trên Windows không chạy | Trung bình | Trung bình | Thí nghiệm W1; fallback `@oh-my-pi/pi-natives` `IpcServer` (Partially) |
| Chính sách Anthropic thay đổi về Channels / tự động hóa | Trung bình | Trung bình | MVP không phụ thuộc Channels |
| Rider license (Agent Mail), AGPL (intercom) | Thấp | Trung bình | Không dùng làm dependency, không copy |
