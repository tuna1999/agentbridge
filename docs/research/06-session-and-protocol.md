# 06 — Định danh phiên, discovery và giao thức

## 1. Bản ghi phiên (registry)

### 1.1 Vị trí (riêng cho từng user, không bao giờ nằm trong repo)

| OS | Thư mục | Quyền |
|---|---|---|
| Linux | `$XDG_RUNTIME_DIR/agentbridge/` (ví dụ `/run/user/1000/agentbridge/`), fallback `~/.local/state/agentbridge/run/` | dir `0700`, file `0600`. Kiểm tra owner == euid khi mở |
| Windows | `%LOCALAPPDATA%\agentbridge\run\` | ACL kế thừa từ profile user. Pipe: `\\.\pipe\agentbridge-<sha256(userSID)[:12]>-<sessionId>` với security descriptor chỉ cho user hiện tại (cần Thí nghiệm W1) |

Lý do dùng thư mục runtime: thư mục này bị xóa khi logout, nên ít rác stale. Lý do để ngoài repo: tránh symlink attack, tránh commit nhầm, tránh việc repo độc hại cài bản ghi giả.

### 1.2 Schema `sessions/omp-<sessionId>.json`

```json
{
  "schema": "agentbridge.session/1",
  "agent": "omp",
  "agentVersion": "18.13.3",
  "extensionVersion": "0.1.0",
  "instanceId": "01J…(uuidv7, sinh mỗi lần extension khởi động)",
  "sessionId": "0199…(ctx.sessionManager.getSessionId())",
  "sessionName": "…",
  "pid": 1876236,
  "procStart": "linux:/proc/<pid>/stat field 22 | win:CreationTime",
  "cwd": "/home/you/projects/my-app",
  "projectRoot": "<realpath(git rev-parse --show-toplevel) || realpath(cwd)>",
  "gitCommonDir": "<realpath(git rev-parse --git-common-dir)>",
  "worktree": "<realpath(git rev-parse --show-toplevel)>",
  "branch": "feature/x",
  "model": { "provider": "openai", "id": "gpt-…" },
  "status": "idle|busy|waiting",
  "capabilities": ["status", "consult"],
  "endpoint": "unix:/run/user/1000/agentbridge/s/<hash>.sock",
  "tokenFile": "omp-<sessionId>.token",
  "heartbeatAt": 1793352545312,
  "startedAt": 1793352000000
}
```

- `model` và `status` trong file **chỉ mang tính gợi ý** (cập nhật khi có `agent_start`/`agent_end`, heartbeat 15 s). **Giá trị đúng luôn lấy qua `hello`/`status` trên endpoint** (đọc lười `ctx.model`).
- File token (32 byte ngẫu nhiên, base64url) tách riêng với quyền `0600`. Token được sinh lại mỗi lần extension khởi động.
- Ghi file **nguyên tử**: viết file tạm, `fsync`, rồi `rename`.

### 1.3 Định danh phía Claude (không cần registry riêng)
- MCP server tự xác định phiên Claude của mình theo thứ tự:
  1. `ppid` (cha trực tiếp, hoặc tổ tiên gần nhất có tên `claude`).
  2. Tra `claude agents --json`, khớp theo `pid` để có `sessionId`, `cwd`, `status`.
  3. Nếu không khớp thì fallback `CLAUDE_CODE_SESSION_ID` và đánh dấu `identityConfidence: "env-only"`.
- `CLAUDE_PROJECT_DIR` được dùng làm project root của Claude.
- Nếu OMP cần thấy các phiên Claude thì gọi `claude agents --json` (chính thức). **Không đọc `~/.claude/sessions/*.json`.**

## 2. Liveness và stale

Một bản ghi được coi là **sống** khi thỏa **cả ba**:
1. `pid` tồn tại.
2. `procStart` khớp. Điều kiện này chống PID reuse: Linux đọc `/proc/<pid>/stat` trường 22; Windows dùng `GetProcessTimes` qua `wmic`/PowerShell hoặc native.
3. `hello` trên endpoint thành công trong 2 s **và** trả về đúng `sessionId` + `instanceId`.

Hệ quả:
- Không thỏa (1) hoặc (2): xóa bản ghi và file token (chỉ khi owner == euid).
- Không thỏa (3) nhưng (1) và (2) đúng: coi là "unresponsive". Không xóa, không gửi.
- Extension dọn bản ghi của mình ở `session_shutdown` (best-effort, ngân sách 2 s) **và** khi khởi động thì quét bản ghi stale.
- **Bằng chứng thực tế:** trên máy có socket Claude `3105669.sock` của tiến trình đã chết. Socket sót lại là chuyện xảy ra thật.

## 3. Chiến lược khớp (deterministic)

Đầu vào: phiên Claude gọi (`claudeProjectRoot` = `realpath(CLAUDE_PROJECT_DIR)`), và tham số `target` tùy chọn.

```
1. Nếu có target:
     khớp chính xác sessionId | tiền tố sessionId ≥ 8 ký tự | sessionName duy nhất
     → 0: not_found · >1: ambiguous · 1: chọn (vẫn kiểm tra liveness).
     Target ở project khác → trả lỗi cross_project trừ khi allowCrossProject=true trong config.
2. Nếu không có target:
     C = các bản ghi sống, agent=omp
     T1 = {c ∈ C | c.worktree == claudeWorktree}            (cùng worktree)
     T2 = {c ∈ C | c.gitCommonDir == claudeGitCommonDir} \ T1 (cùng repo, worktree khác)
     |T1| == 1 → chọn
     |T1| > 1  → ambiguous_target (liệt kê: sessionId, name, model, status, startedAt)
     |T1| == 0 và |T2| ≥ 1 → no_match_same_worktree (liệt kê T2 để người dùng chọn rõ ràng)
     ngược lại → no_omp_session
3. KHÔNG BAO GIỜ broadcast. KHÔNG BAO GIỜ tự chọn "phiên mới nhất".
```

### Chuẩn hóa đường dẫn
- Luôn dùng `fs.realpathSync.native`, để giải symlink và lấy đúng case thực tế trên Windows.
- Trên Windows: so sánh **không phân biệt hoa thường** sau khi chuẩn hóa, chuyển `/` thành `\`, và chuẩn hóa ký tự ổ đĩa.
- **Repo lồng nhau:** dùng `git rev-parse --show-toplevel` của chính `cwd` mỗi agent. Repo con và repo cha là **khác nhau** và không tự khớp.
- **Không có git:** `projectRoot` = `realpath(cwd)`, so khớp chính xác.

### Các trường hợp biên

| Trường hợp | Xử lý |
|---|---|
| Nhiều OMP cùng thư mục | `ambiguous_target`. Người dùng nói "OMP tên X" hoặc chọn id. Có thể đặt tên phiên bằng `/name` (`pi.setSessionName`) |
| Nhiều worktree cùng repo | Chỉ tự khớp cùng worktree. Worktree khác thì liệt kê, không tự chọn |
| Symlink | realpath |
| WSL ↔ Windows native | **Không hỗ trợ trong MVP.** Hai không gian IPC và registry khác nhau (Claude cũng tuyên bố WSL2 và Windows không nhắn được cho nhau). Phát hiện `/mnt/c/...` thì cảnh báo |
| Resume OMP | `session_switch` → cập nhật `sessionId`, xoay token, ghi lại bản ghi |
| `/clear` phía Claude | MCP server tra lại `claude agents --json` theo pid ở mỗi request |
| PID reuse | `procStart` + `instanceId` trong `hello` |
| Crash agent | Liveness (2) thất bại → dọn |
| Đổi model giữa request | `runEphemeralTurn` ném lỗi. Trả `model_changed` (retryable) |
| Nhiều provider trong một agent | Ghi `model.provider` tại thời điểm request vào kết quả và audit |
| Khác máy | **Ngoài phạm vi.** Bridge chỉ local |

## 4. Giao thức v1

### 4.1 Transport
- Linux/macOS: Unix domain socket. Windows: named pipe. Không dùng TCP, không bind cổng mạng.
- Framing: **JSON Lines** (một object mỗi dòng, UTF-8). Mỗi dòng tối đa **1 MiB**; vượt quá thì đóng kết nối.
- Mỗi kết nối phục vụ một request. Đơn giản, không cần multiplex. Streaming là các dòng `progress` trên cùng kết nối.

### 4.2 Envelope

```json
{
  "v": 1,
  "id": "01J9…",
  "type": "hello|status|consult|delegate|cancel|get_result|progress|result|error",
  "replyTo": "01J8…",
  "from": { "agent": "claude-code", "sessionId": "00000000-…", "pid": 3221216 },
  "to":   { "agent": "omp", "sessionId": "0199…", "instanceId": "01J…" },
  "ts": 1793352545312,
  "ttlMs": 300000,
  "hop": 0,
  "body": { }
}
```

| Trường | Bắt buộc | Lý do |
|---|---|---|
| `v` | ✔ | Đánh phiên bản. Server từ chối khi `v` lớn hơn bản nó hỗ trợ (`unsupported_version`) |
| `id` | ✔ | UUIDv7, vừa là request id vừa là **khóa idempotency** |
| `replyTo` | với progress/result/error | Correlation id |
| `from` / `to` | ✔ | Chống gửi nhầm phiên. Server từ chối nếu `to.sessionId` / `instanceId` ≠ của mình (`identity_mismatch`) |
| `ts`, `ttlMs` | ✔ | Hết hạn thì bỏ (`expired`). Kèm cửa sổ chống replay |
| `hop` | ✔ | Chống vòng lặp. MVP: server **từ chối mọi request có `hop ≥ 1`**, và mọi request đi ra từ OMP do một request vào kích hoạt thì mang `hop = in.hop + 1` |
| `body` | ✔ | Nội dung theo `type` |

### 4.3 Bắt tay và xác thực
1. Client đọc `tokenFile` (chỉ đọc được khi cùng user).
2. Dòng đầu: `{"v":1,"type":"hello","id":…,"body":{"token":"…","clientNonce":"…"}}`.
3. Server so sánh token theo thời gian hằng (`timingSafeEqual`), rồi trả `{"type":"result","body":{"sessionId","instanceId","agentVersion","capabilities","model","status","serverNonce"}}`.
4. Sai token thì đóng kết nối, ghi audit, và rate-limit theo pid peer (Linux có thể lấy `SO_PEERCRED`: Partially, Bun chưa expose; xem 11).

Token chỉ chứng minh **"cùng OS user + đọc được thư mục runtime"**. Đó đúng là ranh giới tin cậy mà chính Claude Code cũng dùng cho inbox socket của nó. **Quyền thực sự** (cái gì được làm) do policy ở §5 và consent quyết định.

### 4.4 Thân của từng loại request

| `type` | body | Trả về |
|---|---|---|
| `status` | — | `{status, model, isIdle, pendingMessages, waitingFor?}` |
| `consult` | `{question: string ≤ 32 KiB, contextRefs?: [{path, lines?}], limits?: {maxTokens?, maxContextBytes?, replyMaxBytes?}, stream?: bool}` | `progress{delta}`* → `result{replyText, model, usage, durationMs, truncated}` |
| `delegate` (GĐ 2) | `{task, mode: "readonly"\|"worktree"\|"shared", paths?: string[], ttlMs}` | `result{state:"accepted"\|"rejected", taskId}` ngay lập tức |
| `get_result` | `{taskId}` | `result{state, summary?, changedFiles?, error?}` |
| `cancel` | `{targetId}` | `result{cancelled: bool}`. Chỉ người tạo request (`from.sessionId` khớp) mới được hủy |

- `contextRefs` **không chứa nội dung file**. OMP tự đọc file nếu cần.
- Tuy vậy, với consultation (tools bị tắt), OMP không đọc được file. Vì thế MCP server **nhúng một đoạn trích có giới hạn** (≤ 64 KiB, đã redact) vào `question` khi người dùng hoặc Claude yêu cầu.

### 4.5 Mã lỗi
`unauthorized`, `identity_mismatch`, `unsupported_version`, `expired`, `duplicate`, `denied`, `consent_timeout`, `busy_limit`, `rate_limited`, `too_large`, `model_changed` (retryable), `provider_error`, `target_exited`, `cancelled`, `unsupported_capability`, `internal`.

## 5. Vòng đời request và máy trạng thái

Tách biệt hai lớp:
- **Transport:** kết nối, framing, auth.
- **Task state** (chỉ tồn tại trong bộ nhớ của extension, MVP):

```
consult : received → (awaiting_consent) → running → succeeded | failed | cancelled | expired | denied
delegate: received → awaiting_consent → queued → running → succeeded | failed | cancelled | expired | denied
```

| Câu hỏi | Trả lời cho MVP |
|---|---|
| Target đang bận? | Consult chạy song song (`runEphemeralTurn` không chặn lượt chính). Giới hạn **1 consult đồng thời mỗi phiên OMP**; request thứ hai nhận `busy_limit`. Delegate dùng `deliverAs:"followUp"` (chạy sau lượt hiện tại) |
| Xếp hàng ra sao? | Consult không xếp hàng (từ chối nhanh để Claude tự quyết). Delegate xếp FIFO trong extension, tối đa 3 |
| Agent thoát giữa chừng? | Socket đóng, client nhận `target_exited`. Kết quả delegate dở dang được ghi `failed` nếu kịp làm trong `session_shutdown` |
| Bên gọi biết hoàn tất thế nào? | Consult: dòng `result` cuối cùng, vì MCP tool call là đồng bộ. Delegate: `get_result` hoặc ghi chú inbox |
| Streaming | Dòng `progress` → MCP `notifications/progress`, giúp reset idle-timeout của Claude |
| Trùng lặp | Extension lưu LRU 256 `id` gần nhất trong 10 phút. Gặp lại thì trả kết quả cũ hoặc `duplicate` |
| Retry | Chỉ client retry, và chỉ với lỗi retryable (`model_changed`, `busy_limit` sau backoff). Dùng **id mới** + `retryOf` |
| Vòng lặp A → B → A | `hop` (§4.2). Thêm nữa, consult **không có tool** nên OMP không thể gọi ngược. Delegate phía OMP không có tool gọi Claude trong MVP |
| Hủy an toàn | `cancel` chỉ chấp nhận khi `from.sessionId` == người tạo. Đóng kết nối consult cũng tương đương hủy (AbortController) |
| Đổi model giữa chừng | `model_changed` → client hỏi lại người dùng hoặc retry một lần |
| ACK | `hello` = delivery tới tiến trình đúng · `awaiting_consent` / `running` (progress) = đã nhận xử lý · `result` = hoàn tất. **Ba mức được tách rõ**, khác với Channels |

## 6. Khôi phục
- **Bridge (MCP server) chết:** không có trạng thái gì để mất. Claude spawn lại khi khởi động lại phiên.
- **Extension chết cùng OMP:** consult đang chạy thất bại với `target_exited`. Bản ghi stale được dọn ở lần discovery sau.
- **Delegate qua lần khởi động lại:** MVP **không** bảo đảm. Giai đoạn 2 mới lưu `tasks/<id>.json`, và đó là lúc cân nhắc SQLite.
