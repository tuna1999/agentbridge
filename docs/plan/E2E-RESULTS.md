# E2E — Kết quả kiểm thử MVP (MẪU)

> Đây là biên bản mẫu. **Chưa điền kết quả.** Người dùng chạy theo `docs/plan/00-overview.md` §7, rồi điền cột **Kết quả** và **Bằng chứng** cho từng tiêu chí ở `docs/research/10-implementation-roadmap.md` §5.
>
> Quy ước: `PASS`, `FAIL`, hoặc `BLOCKED` (kèm lý do). Không đánh dấu PASS khi chưa có bằng chứng.

## 1. Thông tin phiên chạy

| Mục | Giá trị |
|---|---|
| Ngày chạy | |
| Người chạy | |
| `omp --version` | |
| `claude --version` | |
| `bun --version` | |
| Model OMP dùng cho consult | |
| Project/worktree | |
| Commit AgentBridge | |
| Đường dẫn phiên OMP (nếu cần đối chiếu hash) | |

## 2. Tiêu chí chấp nhận MVP

| # | Tiêu chí (research/10 §5) | Cách kiểm | Kết quả | Bằng chứng |
|---|---|---|---|---|
| 1 | Với một Claude + một OMP cùng worktree, yêu cầu "hỏi OMP review kiến trúc" trả lời trong Claude, và kết quả hiển thị model của OMP. | Mở OMP + Claude trong cùng worktree; yêu cầu Claude consult; đọc header kết quả có `model …`. | | |
| 2 | Số tiến trình `omp` không đổi; file phiên OMP không đổi byte nào sau consultation. | Đếm tiến trình `omp` trước/sau; `sha256sum <session-file>` trước/sau consult. | | |
| 3 | Hai OMP cùng worktree → `ambiguous_target` kèm danh sách; chỉ định `target` thì tới đúng phiên; không bao giờ broadcast. | Mở hai OMP cùng worktree; gọi consult không target; gọi lại với `target` là sessionId của từng phiên. | | |
| 4 | Khi OMP đang chạy lượt dài, consult vẫn trả kết quả và lượt chính không bị gián đoạn (transcript không có steer/chèn). | Trong OMP yêu cầu chạy `sleep 45`; ngay lúc đó consult từ Claude; kiểm tra transcript và số `agent_start`/`agent_end`. | | |
| 5 | Sau `kill -9` OMP, bản ghi stale được dọn ở lần `agent_list` kế tiếp; không còn kết nối tới pid sai. | `kill -9` tiến trình OMP; chạy `agent_list`; kiểm tra registry và kết quả consult. | | |
| 6 | Không thể kết nối khi thiếu token đúng; user khác không đọc được thư mục runtime. | Thử handshake sai/thiếu token; kiểm tra mode runtime dir (0700), socket (0600), quyền của user khác. | | |
| 7 | Khi extension hoặc MCP không có mặt, cả hai agent hoạt động bình thường: không lỗi, không cảnh báo lặp lại. | Tạm gỡ extension rồi mở OMP; tạm gỡ MCP rồi mở Claude; quan sát UI/log. | | |
| 8 | Không có lượt Claude nào bắt đầu mà không có thao tác của người dùng. | Quan sát: không có channel/inbox/auto-turn; chỉ tool call do người dùng yêu cầu. | | |
| 9 | Audit log không chứa nội dung câu hỏi hay câu trả lời (mặc định). | Chạy consult, mở audit JSONL; xác nhận chỉ có metadata (`questionBytes`, `questionSha256`, `replyBytes`, …). | | |
| 10 | Kiểm thử trên OMP 18.13.3 (hoặc bản đã chốt), và extension từ chối an toàn khi thiếu `runEphemeralTurn`. | Ghi lại phiên bản OMP; chạy extension với fake/không có `runEphemeralTurn`; xác nhận lỗi `unsupported_capability`, không crash OMP. | | |

## 3. Ghi chú

| Mục | Nội dung |
|---|---|
| Sai lệch so với spec | |
| Lỗi gặp phải | |
| Việc cần làm tiếp | |
