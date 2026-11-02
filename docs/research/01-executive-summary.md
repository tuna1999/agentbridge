# 01 — Tóm tắt điều hành: AgentBridge

> Ngày: 2026-10-30 · Claude Code 2.1.314 · OMP 18.13.3 (`v18.13.3` = `413d278a`) · Linux (Arch)
> Trạng thái: **Nghiên cứu xong. Spike chưa chạy.** Mọi khẳng định đều có nguồn trong `SOURCES.md`.

## 1. Kết luận

**GO có điều kiện.** MVP **Consultation (Claude → OMP)** khả thi bằng API chính thức của cả hai phía, không sửa binary, không chạm credential, không cần daemon hay SQLite. Điều kiện là **Spike E2/E3** (09) xác nhận `runEphemeralTurn` gọi được từ callback IPC của extension.

Hướng **OMP → Claude dạng push** (tự kích hoạt Claude) **chưa nên làm**:
- Về kỹ thuật, chỉ có Channels (preview, dev flag, phải khởi động kèm) hoặc inbox socket (format không công bố cho bên thứ ba).
- Về chính sách, nó rơi vào vùng "cần xác nhận" của Anthropic.

MVP thay bằng **inbox dạng kéo**.

## 2. Phát hiện chính
1. **OMP không có cách sẵn để gắn vào phiên TUI đang chạy từ ngoài.** RPC luôn tạo phiên mới (`main.ts:2766`). `/collab` cần relay WebSocket. `omp collab list --json` trả rỗng dù có 2 phiên đang chạy. → **Extension tự mở IPC là con đường duy nhất phù hợp**, và đã có prior art trên máy (extension herdr).
2. **`ctx.runEphemeralTurn()` tồn tại ở 18.13.3 và gần như được thiết kế cho đúng bài toán này.** Docs OMP nêu ví dụ "bridge trả lời câu hỏi của agent khác". API này:
   - dùng **model hiện tại**;
   - lấy snapshot context, kể cả nội dung đang stream;
   - **không ghi lịch sử, không thực thi tool**;
   - chạy song song khi OMP đang bận;
   - có streaming, hủy và giới hạn kích thước.
3. **Claude Code có sẵn hai mảnh ghép chính thức:**
   - **stdio MCP server theo từng phiên**: tự biết phiên của mình;
   - **`claude agents --json`**: discovery chính thức, có lọc liveness, đã chạy thử.
   Cũng có **cross-session messaging** (inbox socket), nhưng chỉ dành cho peer là Claude.
4. **Channels không phù hợp làm kênh chính:** research preview, cần `--dangerously-load-development-channels` (cảnh báo mỗi lần chạy), **không gắn được vào phiên đã mở**, không ACK, mỗi sự kiện kích hoạt inference.
5. **Không có giải pháp có sẵn** đáp ứng trọn yêu cầu. MCP Agent Mail chỉ là hộp thư kéo và có rider license chống Anthropic/OpenAI. Họ Intercom chỉ cho Pi, bản cross-harness là AGPL. Paseo, Agent Teams và các orchestrator khác đều spawn phiên mới.
6. **Rủi ro bảo mật đáng chú ý của OMP:** extension cấp project được nạp không hỏi (`isProjectTrusted()` luôn `true`). Extension AgentBridge phải cài ở scope user và có cảnh báo trùng tên.

## 3. Kiến trúc khuyến nghị

**MVP — "Extension làm chủ IPC, không daemon" (Phương án E, 05):**
```
Claude Code ──stdio──► agentbridge-mcp ──UDS/pipe + token──► agentbridge.ts (trong OMP) ──► runEphemeralTurn
                          │                                        │
                          └──── đọc registry file 0600 ◄──── ghi ──┘
```
**Dài hạn:** thêm daemon + SQLite tùy chọn chỉ khi cần delegation bền vững, reservation dùng chung, hoặc push vào Claude khi chính sách cho phép.

## 4. Unknown then chốt
1. `ctx` lưu lại có dùng được ngoài event handler không (Q1). → E2
2. Transport OpenAI của OMP có nhận `maxTokens` cho side turn không (Q3).
3. Named pipe trong Bun của OMP trên Windows (Q5). → W1
4. Chính sách cho channel tự viết hoặc inbox socket khởi phát lượt Claude (P1/P2).

## 5. Trả lời 15 câu hỏi quyết định

| # | Câu hỏi | Trả lời |
|---|---|---|
| 1 | Claude phát hiện được phiên OMP tin cậy không? | **Có, khi có extension AgentBridge.** OMP không tự công bố phiên. Extension ghi registry + endpoint, và MCP xác minh bằng pid + `procStart` + handshake |
| 2 | Giao tiếp đúng phiên đó mà không tạo tiến trình mới? | **Có.** Extension chạy trong chính tiến trình OMP. RPC thì **không** làm được |
| 3 | OMP trả lời bằng model đang chọn? | **Có.** `runEphemeralTurn` dùng `this.model`, không override được. Đổi model giữa chừng thì ném lỗi retryable |
| 4 | Consultation giữ nguyên context và lịch sử OMP? | **Có theo mã nguồn** ("history is NOT modified"). Chưa kiểm chứng thực nghiệm (E2) |
| 5 | OMP gửi tin an toàn vào phiên Claude đang chạy? | **Chưa ở dạng push.** MVP dùng inbox kéo + hook `UserPromptSubmit` (không tốn inference). Push qua Channels hoặc inbox socket thì chờ xác nhận chính sách và format |
| 6 | Subscription / API key / chưa rõ? | **Subscription OK:** người dùng gọi MCP tool trong Claude (kịch bản 1), thông báo không kích hoạt inference (2, cơ chế kéo). **Cần API key:** daemon tự động ra lệnh (4), tự động hóa không người (6). **Chưa rõ:** Channel hoặc inbox socket tự kích hoạt Claude (3, 8); `claude -p` do công cụ phân phối công khai gọi (5) |
| 7 | MCP Channels có phải cơ chế đúng? | **Không cho MVP.** Có thể là tùy chọn GĐ 3 |
| 8 | Cần daemon thường trực? | **Không** cho MVP |
| 9 | Cần SQLite cho MVP? | **Không.** File JSON + JSONL đủ dùng |
| 10 | Tái sử dụng framework? | **Không dùng nguyên khối.** Compose primitive chính thức. Học thiết kế từ pi-intercom (MIT), Agent Mail (reservation), herdr (báo trạng thái) |
| 11 | Nhiều agent cùng project? | Khớp deterministic theo worktree / gitCommonDir. Nhiều ứng viên thì `ambiguous_target` + chọn rõ ràng. Không broadcast, không "chọn mới nhất" |
| 12 | Chia sẻ context không lộ secret? | Chia sẻ kết luận (ADR, ghi chú trong git) chứ không chia sẻ transcript. Redactor + path guard + `maxContextBytes`. Consent trước khi gửi context OMP ra ngoài |
| 13 | Tránh sửa file đồng thời? | Mặc định Read-Only Consultation (không có tool về mặt cấu trúc). Ghi thì bắt buộc worktree riêng. Shared workspace cần reservation, để GĐ 3 |
| 14 | MVP tối thiểu? | Extension OMP (`status` + `consult`) + MCP server (`agent_list/status/consult/cancel`) + protocol v1. Linux trước. Khoảng 1.5k dòng TS, 3–4 tuần |
| 15 | Giả định sai hoặc thừa trong đề xuất ban đầu? | Xem §6 |

## 6. Giả định trong đề xuất ban đầu cần sửa
| Giả định | Thực tế |
|---|---|
| Cần daemon "Local Bridge" ở giữa | Không cần. Extension OMP làm server, MCP server của Claude làm client |
| RPC của OMP có thể dùng để giao tiếp | RPC luôn tạo phiên mới, không gắn được |
| Channels là cách để OMP → Claude | Preview, phải khởi động kèm, không ACK, có vùng xám chính sách |
| Cần đồng bộ context hoặc transcript | Nên chia sẻ kết luận có cấu trúc, không chia sẻ transcript |
| Discovery bằng process + đường dẫn | Không đủ. Cần handshake + `procStart` + token. Socket stale là chuyện thực tế |
| `agent_send` là một thao tác | Tách **consult** (an toàn, không ghi) và **delegate** (ghi, cần consent và worktree) |
| Channels yêu cầu claude.ai login, không hỗ trợ API key | Đã cũ. API key được hỗ trợ từ 2.1.128 |
| Có thể phát hiện đổi model qua event | OMP không có event cho extension. Đọc lười `ctx.model` khi cần là đủ |

## 7. Bản ghi quyết định (Decision Record)

- **Kiến trúc chọn:** E. Extension OMP làm chủ IPC (UDS / named pipe + token theo phiên), stdio MCP server phía Claude, registry bằng file trong thư mục runtime của user, inbox kéo cho hướng ngược (GĐ 2).
- **Kiến trúc loại:**
  - B, thuần MCP: OMP không phải MCP server, và push vào Claude buộc dùng Channels.
  - A, daemon: thừa với MVP.
  - D, hybrid đầy đủ: quá phức tạp.
  - `/collab`: relay ngoài.
  - herdr / tmux: gõ phím.
  - spawn RPC hoặc `claude -p`: tạo phiên trùng; `-p` còn có rủi ro chính sách nếu phân phối.
- **Năng lực upstream cần có:** OMP ≥ 18.13.x với `ctx.runEphemeralTurn` (đã có). Claude Code ≥ 2.1.145 (`claude agents --json`) và MCP stdio. Không cần thay đổi upstream nào.
- **Đã xác nhận khả thi:**
  - Bằng mã nguồn và tài liệu: tất cả thành phần MVP.
  - Bằng chạy thực: discovery phía Claude.
- **Điểm chặn chưa giải quyết:** Q1 (ctx ngoài handler), Q5 (Windows pipe), P1/P2 (chính sách push).
- **Ranh giới chính sách và bảo mật:**
  - Mọi lượt Claude bắt nguồn từ người dùng.
  - Không chạm credential.
  - Không thêm allow rule.
  - Consent trong OMP cho consult (lần đầu) và delegate (luôn luôn).
  - Chỉ IPC local, giới hạn kích thước và tốc độ, audit chỉ metadata.
- **Phạm vi MVP:** `agent_list`, `agent_status`, `agent_consult`, `agent_cancel`. Linux. Consent `ask|session`. Project allowlist.
- **Độ phức tạp:** Trung bình-thấp, khoảng 1,5k LOC, 3–4 tuần cho 1 kỹ sư (GĐ 2: thêm khoảng 2–3 tuần).
- **Khuyến nghị:** **GO cho Spike GĐ 0 (2–3 ngày) → GO/NO-GO cho GĐ 1 dựa trên E2/E3.**
  - Nếu E2 thất bại vì `ctx` không dùng được ngoài handler, fallback là command context hoặc timer (10 §6).
  - Nếu cả fallback cũng thất bại thì NO-GO cho consultation không xâm lấn. Lúc đó chỉ còn delegation qua `sendUserMessage`, và lựa chọn này ghi vào lịch sử OMP.
