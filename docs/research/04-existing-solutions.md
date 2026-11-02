# 04 — Giải pháp hiện có

> Truy cập 2026-10-30. Các repo được shallow-clone chỉ để đọc, không chạy, không cài.
> Ký hiệu: Y = có · P = một phần · N = không · ? = chưa xác minh. "Existing" nghĩa là gắn được vào phiên **người dùng đã tự mở**, khác với tự spawn phiên mới.

## 1. Kết luận nhanh

**Không có công cụ nào** đáp ứng trọn: *Claude Code đang chạy* phát hiện và hỏi ý kiến *OMP TUI đang chạy*, local-first, Windows + Linux, không chia sẻ credential.

Gần nhất là các hướng sau:
- **Claude Code cross-session messaging** (chính thức). Đây là đường vào phiên Claude, nhưng chỉ thiết kế cho peer là Claude.
- **Họ "Agent Intercom" / pi-intercom.** Chỉ hỗ trợ Pi, không phải OMP. Bản cross-harness dùng license **AGPL**.
- **OMP `/collab`.** Điều khiển được phiên OMP đang chạy, nhưng đi qua relay WebSocket.
- **herdr.** Gõ phím vào pane, và chỉ dùng được khi cả hai agent chạy trong herdr.

## 2. Ma trận so sánh

| Giải pháp | Discovery phiên | Gắn phiên **đang có** | Hai chiều | Chia sẻ context | Delegation | File reservation | Worktree | Cô lập auth | Win / Linux | Commit gần nhất | License | Độ phức tạp tích hợp |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CC cross-session messaging | Y (`claude agents --json`, `ListAgents`) | **Y** (Claude ↔ Claude) | Y giữa các phiên Claude; peer ngoài ? | N | P | N | N | Y | Y (≥2.1.234) / Y | rolling | Proprietary | Thấp khi post từ chính phiên; cao với peer ngoài (format không công bố) |
| CC Channels (preview) | N | P (chỉ phiên **khởi động kèm** channel) | Y (reply tool) | N | P | N | N | Y | ? / Y | rolling | Proprietary | Trung bình, kèm dev flag |
| CC Agent Teams | Y (trong team) | N (spawn mới) | Y | N | Y | P | N | Y | P / Y | rolling | Proprietary | Không áp dụng cho OMP |
| MCP Agent Mail (Py → Rust) | P (định danh, không phải liveness) | **N** (hộp thư, phải tự kéo) | Y | P | P | **Y** (advisory, TTL, git guard) | P | Y | Y (Rust) / Y | 2026-10-29 | **MIT + rider chống OpenAI/Anthropic** | Trung bình |
| herdr 0.9.5 | Y (kể cả hook OMP) | **Y** nếu agent chạy trong pane herdr (gõ PTY) | Y | N | P (`agent.prompt --wait`) | N | Y | Y | Preview / Y | 2026-10-29 | Apache-2.0 | Gọi đơn giản, nhưng **phải chuyển sang dùng herdr** |
| OMP `/collab` | Y (`omp collab list --json`, khi đã bật) | **Y** (guest prompt / abort) | P (chỉ phía OMP) | Y | P | N | N | Y | Y / Y | 2026-10-29 | MIT (relay mã đóng) | Trung-cao, cần relay |
| pi-intercom (nicobailon) | Y | Y (Pi) | Y | P | Y | N | N | Y | Y / Y | 2026-10-29 | MIT | Trung bình, cần port sang OMP |
| Agent Intercom (dataforxyz) | Y | P (Claude phải khởi động qua `cci` hoặc socket native) | Y | P | Y | N | N | Y | Y / Y | 2026-10-05 | **AGPL-3.0** | Trung-cao |
| pi-messenger | Y | Y (Pi) | Y | P | Y | **Y** | N | Y | ? / Y | 2026-10-30 | MIT | Trung bình |
| claude-channel-cli | P | P (khởi động qua wrapper) | P | N | P | N | N | Y | ? / Y | 2026-07-19 | MIT | Thấp-trung |
| aiAgentBridge (Python) | Y | P | Y | N | P | N | N | Y | Y / Y | 2026-10-03 | MIT | Trung bình |
| rennerdo30/agent-bridge | Y | P (không có Pi/OMP) | Y | Y | Y | N | Y | Y | Y / Y | 2026-10-29 | MIT | Cao |
| Paseo | Y (phiên Paseo tự tạo) | **N** (spawn) | Y | P | Y | N | Y | Y | ? / Y | 2026-10-30 | Apache-2.0 | Trung bình |
| claude-squad / agent-deck / ccmanager | Phiên tự tạo | N | P | N | P | N | Y | Y | N / WSL / Y | 2026-08 → 10 | AGPL / MIT / MIT | Sai mô hình |
| A2A protocol | qua Agent Card | N (không agent nào nói A2A native) | Y | P | Y | N | N | tùy | Y / Y | 2026-10-29 | Apache-2.0 | Cao |
| PAL MCP (Zen) | N | N (spawn CLI / dùng API key) | N | P | P | N | N | **N** | ? / Y | **2025-12-15** (cũ) | Apache-2.0 | Vi phạm yêu cầu credential |

## 3. Ghi chú từng giải pháp quan trọng

- **MCP Agent Mail.**
  - Là hộp thư bất đồng bộ (`fetch_inbox`, `am check-inbox`). **Không đẩy vào phiên đang chạy.** Bản Python đã bị thay bằng bản Rust (có Windows, có `am setup run --agent omp`).
  - File reservation (TTL, glob, exclusive/shared, pre-commit guard) là **thiết kế tham khảo tốt**.
  - **License rider** từ chối quyền với Anthropic, OpenAI và bất kỳ ai hành động "for the benefit of" họ. Rider định nghĩa "use" rộng, gồm cả "executing… analyzing". **Cần review pháp lý** trước khi dùng làm dependency.
- **Agent Teams.** Teammate là các phiên Claude mới. Không thêm được agent ngoài và không nhận phiên có sẵn.
- **herdr.** `agent.prompt` gõ text + Enter qua PTY (bracketed paste), từ chối khi agent đang ở UI phê duyệt, và *"does not track individual turns"*. Extension OMP của herdr chỉ báo trạng thái. Repo cho thấy hướng **extension báo trạng thái qua socket local**, nhưng nhập liệu kiểu gõ phím thì không đủ tin cậy.
- **OMP `/collab`.** Là API điều khiển có cấu trúc duy nhất có sẵn trong OMP. Relay mặc định là dịch vụ ngoài, chỉ có relay dev tự chạy được (`packages/collab-web/scripts/local-relay.ts`). Giao thức không cam kết ổn định cho bên thứ ba.
- **pi-intercom (MIT).** Logic idle-wake / `busyDelivery` / steer là tham khảo hữu ích **được phép đọc và port**. Không copy từ fork AGPL của dataforxyz.
- **Channels community** (claude-channel-cli, aiAgentBridge, agent-bridge). Tất cả đều yêu cầu Claude **được khởi động kèm** channel server. Không cái nào gắn được vào phiên Claude đã chạy sẵn.

## 4. Build, extend hay compose?

**Khuyến nghị: compose các primitive chính thức với một lõi mỏng tự viết. Không áp dụng nguyên một framework.**

| Thành phần | Quyết định | Lý do |
|---|---|---|
| Phía OMP | **Tự viết** extension `agentbridge.ts` (khoảng 300-500 dòng) | Không có extension nào cho OMP. pi-intercom (MIT) dùng làm tham khảo |
| Phía Claude | **Tự viết** stdio MCP server nhỏ | MCP là cơ chế chính thức. Một server cho mỗi phiên tự biết phiên của mình |
| Discovery Claude | **Dùng lại** `claude agents --json` | Chính thức, có liveness |
| Push OMP → Claude | **Hoãn.** Đánh giá inbox socket / Channels ở giai đoạn 3 | Format không công bố, đồng thời có vấn đề chính sách |
| File reservation | **Tự viết lại**, học thiết kế Agent Mail / pi-messenger | Tránh rider license và dependency Python/Rust |
| `/collab`, herdr | Adapter tùy chọn, **không thuộc lõi** | Phụ thuộc relay / PTY |
| Envelope | Giữ hình dạng giống A2A/ACP (`id`, `from`, `to`, `status`) | Để bắc cầu được về sau, nhưng không kéo theo HTTP |

**Rủi ro license:**
- Không copy code AGPL (agent-intercom-*, claude-squad).
- Không phụ thuộc Agent Mail khi chưa có ý kiến pháp lý.
- Code MIT (pi-intercom, OMP) được phép tham khảo và port, kèm ghi nhận nguồn.

## Nguồn
Xem `SOURCES.md`, mục C.
