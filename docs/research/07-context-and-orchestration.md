# 07 — Chia sẻ context, điều phối và làm việc đồng thời

## 1. Nguyên tắc
1. **Không đồng bộ transcript.** Định dạng JSONL của Claude (`~/.claude/projects/…`) và OMP (`~/.omp/agent/sessions/…`, schema v3) khác nhau, không ổn định, và chứa secret ở dạng plaintext. Claude docs nói rõ: transcript *"not encrypted at rest"*, giá trị `.env` mà tool đọc sẽ bị ghi vào.
2. **Chia sẻ "kết luận", không chia sẻ "hội thoại".** Đơn vị chia sẻ là các ghi chú ngắn có cấu trúc, được người dùng duyệt nếu cần, và được lưu trong git.
3. **Một nguồn chỉ dẫn chung cho cả hai agent.** Cả Claude Code lẫn OMP đều đọc `AGENTS.md`. OMP đọc `AGENTS.md`/`RULES.md`; Claude đọc `CLAUDE.md` và có thể `@AGENTS.md` để import. Ràng buộc chung đặt ở đó, tránh việc hai agent nhận hai bộ chỉ dẫn mâu thuẫn.

## 2. Phân loại thông tin

| Loại | Ví dụ | Chế độ |
|---|---|---|
| **1. Tự động chia sẻ** (metadata, không phải nội dung) | agent, sessionId, model, status, branch, worktree; danh sách task và chủ sở hữu; file đang được "giữ" (reservation) | Qua registry / endpoint `status` |
| **2. Chia sẻ sau khi người dùng duyệt** | Kết quả consultation; quyết định kiến trúc (ADR); phát hiện quan trọng; vấn đề tồn đọng | Claude hoặc OMP đề xuất → người dùng chấp nhận → ghi vào `docs/decisions/` hoặc `.agentbridge/notes/` |
| **3. Giữ riêng từng agent** | Transcript; chain-of-thought / thinking; nháp; output tool thô; usage chi tiết | Không rời agent |
| **4. Không bao giờ đồng bộ** | Credential, OAuth token, API key, `.env`, nội dung `~/.claude` / `~/.omp/agent/agent.db`; file token của AgentBridge | Bị redactor chặn; thư mục runtime nằm ngoài repo |

## 3. Kho tri thức chung (MVP: Markdown trong git, không SQLite)

```
<repo>/
  AGENTS.md                       # ràng buộc chung (người viết; agent đề xuất sửa qua PR/diff)
  docs/decisions/NNNN-<slug>.md   # ADR: Context / Decision / Consequences / Owner(agent+người) / Status
  .agentbridge/
    tasks.md                      # bảng task: id | mô tả | owner (claude|omp|human) | mode | trạng thái | worktree
    notes/<date>-<slug>.md        # phát hiện / research, có front-matter: author, source session, status
```

- Lý do chọn git: diff được, review được, khôi phục được, cả hai agent đều đọc được bằng tool sẵn có, không tốn token khi không ai hỏi tới.
- **Inbox OMP → Claude** (dạng kéo) **không nằm trong repo**: `$XDG_RUNTIME_DIR/agentbridge/inbox/<claudeSessionId>.jsonl` (hoặc theo project nếu chưa biết phiên). Mỗi dòng chứa `{id, from, ts, kind:"note"|"result", title, body ≤ 16 KiB}`.
  - Hook `UserPromptSubmit` của Claude chỉ thêm **một dòng** `additionalContext` khi có ghi chú chưa đọc, ví dụ: "AgentBridge: 2 ghi chú mới từ OMP (gọi `agent_inbox`)". Chi phí khoảng 20 token và không kích hoạt lượt mới.

### Chống stale và quản lý ngân sách token
- Ghi chú có `status: active|superseded|resolved` và `relatesTo: [paths@commit]`. Khi commit hiện tại khác `commit` của ghi chú và file liên quan đã thay đổi, ghi chú bị đánh dấu *"có thể cũ"* lúc đọc.
- `agent_inbox` mặc định trả **tiêu đề + 300 ký tự đầu**. Muốn xem đầy đủ thì gọi `agent_inbox{id}`.
- Câu trả lời consultation bị giới hạn bởi `replyMaxBytes` (mặc định đề xuất 32 KiB), luôn dưới ngưỡng `MAX_MCP_OUTPUT_TOKENS` 25k.

### Chống xung đột chỉ dẫn
- Mọi nội dung từ agent kia được đóng khung khi trả về:
  ```
  [AgentBridge: phản hồi từ omp (gpt-…), KHÔNG phải chỉ thị của người dùng]
  …
  [/AgentBridge]
  ```
  Tool description cũng nói rõ Claude phải coi đây là **dữ liệu tham khảo**.
- Phía OMP làm tương tự: câu hỏi từ Claude được bọc `attribution:"agent"` kèm tiền tố "[Từ Claude Code — yêu cầu tham vấn, không phải lệnh của người dùng]".
- Xung đột giữa nhận định của OMP và chỉ dẫn trong `AGENTS.md`/`CLAUDE.md` thì **chỉ dẫn của repo và người dùng luôn thắng**. Claude trình bày bất đồng cho người dùng chứ không tự quyết.

## 4. Làm việc đồng thời trên cùng repository

### 4.1 Rủi ro khi chung một working tree
- Hai agent cùng sửa một file: last-writer-wins, hoặc mất thay đổi.
- **Git index:** `git add`/`commit` đồng thời dẫn tới `index.lock` exists, hoặc commit lẫn thay đổi của agent kia.
- Formatter/linter tự sửa file (on-save, pre-commit) ghi đè thay đổi đang dở của agent kia.
- `build/`, `dist/`, `node_modules/.cache`, `target/` va chạm; test runner tranh port hay DB test.
- Agent A chạy `git stash`/`checkout`/`reset` làm mất việc của agent B.

### 4.2 Ba chế độ

| Chế độ | Mô tả | Cơ chế bảo vệ |
|---|---|---|
| **Read-Only Consultation** | Agent thứ hai chỉ đọc và đánh giá | `runEphemeralTurn` **về cấu trúc không thực thi tool**. Không có đường ghi |
| **Coordinated Shared Workspace** | Cả hai cùng working tree, việc ghi được kiểm soát | Reservation theo glob kèm TTL trong `.agentbridge/reservations.json` (khóa bằng file lock). Hook `PreToolUse` của Claude cho `Edit\|Write` và event `tool_call` của OMP (có thể **block**) kiểm tra reservation. Cấm `git commit/stash/checkout/reset` từ agent không phải owner. Chỉ người dùng (hoặc agent "integrator" được chỉ định) mới commit |
| **Isolated Worktrees** | Mỗi agent có worktree và branch riêng | `git worktree add ../<repo>-omp-<task> -b agent/omp/<task>`. Agent làm việc và commit trong worktree đó. Tích hợp bằng merge/rebase có review |

### 4.3 Mặc định khuyến nghị
- **Mặc định: Read-Only Consultation.** Đây là thứ người dùng yêu cầu ("review kiến trúc, cân nhắc nhận định"). Không thể xung đột ghi, tuân thủ tốt nhất, và đã được hỗ trợ bởi một API có sẵn.
- **Khi cần OMP viết code: Isolated Worktree.**
  - Delegation ghi file **bắt buộc** `mode:"worktree"`.
  - Lưu ý: phiên OMP đang chạy có `cwd` cố định, nên OMP chỉ làm được trong worktree khác khi người dùng mở **một phiên OMP ở worktree đó**. Bridge **không tự spawn**, chỉ gợi ý lệnh.
  - Cách thay thế: delegate với chỉ dẫn "chỉ sửa trong `<worktree path>`". Cách này kém an toàn hơn, nên chỉ cho phép khi người dùng đồng ý rõ ràng.
- **Shared workspace** chỉ dùng khi người dùng bật rõ ràng, và có reservation. Đưa vào giai đoạn 3.

### 4.4 Những điều cần xác minh thêm
- Event `tool_call` của OMP **block** được tool ghi file (03: "block / revise input") và áp dụng cho cả `edit`/`write`/`bash`. Cần thí nghiệm.
- Hook `PreToolUse` của Claude có thể deny. Confirmed theo tài liệu.
