# 11 — Câu hỏi mở

## 1. Kỹ thuật (giải quyết bằng thí nghiệm)
| # | Câu hỏi | Cách giải quyết | Ảnh hưởng |
|---|---|---|---|
| Q1 | `ctx` lưu từ `session_start` có gọi được `runEphemeralTurn` / `ui.confirm` từ callback socket không? | E2 | **Chặn MVP** |
| Q2 | `ctx.ui.confirm` hành xử thế nào khi OMP đang stream một lượt? | E2/E6 | UX |
| Q3 | Transport model OpenAI mà người dùng đang dùng trong OMP có hỗ trợ `maxTokens` cho side turn không? | E2 bước 5 | Giới hạn chi phí |
| Q4 | stdio MCP server có luôn là con trực tiếp của `claude` (ppid) trên Linux và Windows không? | E1b | Định danh |
| Q5 | Bun (trong binary OMP) có hỗ trợ `node:net` named pipe + ACL trên Windows không? | W1 | Windows |
| Q6 | Lấy được thông tin peer (`SO_PEERCRED`) trong Bun không, để ràng buộc pid client? | Thử nghiệm | Tăng cường auth |
| Q7 | Event `tool_call` của OMP chặn được `edit`/`write`/`bash` cho reservation không? | Thí nghiệm GĐ 3 | Shared workspace |
| Q8 | Deferred-load extension có bỏ lỡ `session_start` trong một số trường hợp không? | E1 với TUI thật | Đăng ký phiên |
| Q9 | Tương quan chính xác giữa `sendUserMessage` và `agent_end` khi có steer hoặc followUp đan xen | GĐ 2 | Delegation |

## 2. Bằng chứng còn thiếu
- Hành vi buffer/TTL của Channels khi phiên bận lâu (tài liệu không nói).
- `UserPromptSubmit` có chạy với lượt do channel khởi phát không (Unverified).
- Định dạng frame inbox socket của Claude cho người gửi không phải Claude (không công bố). `agent-intercom-claude` suy ra `msgV:1`, nhưng đó là AGPL và không chính thức.
- Ngày hiệu lực Usage Policy hiển thị 12/11/2026, sau ngày nghiên cứu. Cần đọc lại khi đến hạn.

## 3. Chính sách (cần xác nhận với Anthropic hoặc pháp lý)
| # | Câu hỏi |
|---|---|
| P1 | Một cá nhân dùng Pro/Max có được dùng channel tự viết hằng ngày (qua dev flag) để agent local khác **khởi phát lượt Claude** không? Có được coi là "ordinary, individual usage" không? |
| P2 | Script bên ngoài (không phải hook hay Bash con của phiên) post vào inbox socket của phiên Claude có được chấp nhận không? Format có cam kết ổn định không? |
| P3 | Nếu AgentBridge được **phân phối công khai** (open-source), việc MCP server được Claude Code (subscription) gọi có còn thuộc "ordinary use" không? Dự kiến là có, vì sản phẩm không chạm credential và không khởi phát inference, nhưng nên ghi rõ trong README |
| P4 | Điều khoản OpenAI (hoặc provider khác) mà OMP dùng: consultation do agent khác yêu cầu, có người dùng phía sau, có ổn không, nhất là khi OMP đăng nhập bằng subscription ChatGPT/Codex? **Người dùng cần tự kiểm tra** |
| P5 | Rider license của MCP Agent Mail: có ảnh hưởng nếu chỉ *tham khảo thiết kế* không? Dự kiến là không, nhưng cần ý kiến pháp lý nếu dùng code |

## 4. Upstream cần theo dõi
- OMP: không có event `model_changed` cho extension (có thể đề xuất PR thêm). Docs/code lệch về realpath dedup (có thể mở issue). `isProjectTrusted()` luôn true (rủi ro bảo mật đáng báo cáo).
- Claude Code: Channels ra GA và mở allowlist cho channel cá nhân; công bố format inbox cho bên thứ ba.

## 5. Bước tiếp theo đề xuất
1. **Người dùng duyệt**: chạy Spike GĐ 0 trong `/tmp/ab-*`. Việc này cần nạp extension PoC **chỉ** vào phiên OMP test (`omp -e`), thêm MCP **scope local** cho thư mục test, và chấp nhận tiêu tốn một ít token của OMP provider và Claude.
2. Người dùng xác nhận provider và transport OMP đang dùng (cho Q3 và P4).
3. Sau spike: cập nhật 09 với kết quả thực, rồi quyết định Go cho GĐ 1.
