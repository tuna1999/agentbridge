# T0 — Spike PoC và GATE

Mục tiêu duy nhất của thư mục này: chứng minh giả định then chốt của AgentBridge trước khi đầu tư
phần còn lại — **`ctx` lưu từ `session_start` vẫn gọi được `ctx.ui.confirm` và
`ctx.runEphemeralTurn` từ callback Unix socket**, tức ngoài mọi event handler của OMP, và **không
làm đổi file phiên**.

| File | Vai trò |
|---|---|
| `agentbridge-poc.ts` | Extension OMP (nạp bằng `omp -e`), mở Unix socket, xử lý `status`/`consult` |
| `client.ts` | CLI bun đóng vai Claude Code: tìm record trong runtime dir, hello + token, gửi request |
| `README.md` | Quy trình chạy GATE (tài liệu này) |

PoC cố tình bỏ qua: config, registry sweep, redaction, consent mode, Windows. Đây **không phải**
code của `packages/omp-extension`; sau GATE thì xóa hoặc giữ làm tham khảo, không đưa vào build.

> **Không nạp extension này vào phiên OMP đang dùng để làm việc.** Chỉ chạy trong `/tmp/ab-e2`.
> PoC chỉ ghi vào `$AGENTBRIDGE_RUNTIME_DIR` (mặc định `/tmp/ab-poc`), không ghi vào repo,
> `~/.omp` hay `~/.claude`.

---

## 0. Chuẩn bị

```bash
omp --version        # 18.13.3 hoặc 18.14.0; khác phiên bản -> dừng, báo lại (references có thể cũ)
bun --version
mkdir -p /tmp/ab-e2 && cd /tmp/ab-e2 && git init -q && echo "# test" > README.md
rm -rf /tmp/ab-poc      # xóa artifact của lần chạy trước
```

`/tmp/ab-poc` sẽ được extension tạo với mode `0700`; token, record, socket, log đều `0600`.
Nếu thư mục đã tồn tại với mode rộng hơn, extension từ chối chạy và hiện cảnh báo trong OMP —
đó là hành vi đúng, không phải lỗi.

Biến môi trường dùng trong suốt quy trình:

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `AGENTBRIDGE_RUNTIME_DIR` | Nơi chứa record/token/socket/log | `/tmp/ab-poc` |
| `AB_POC_MAXTOKENS` | Nếu có, truyền `maxTokens` cho `runEphemeralTurn` | không truyền |
| `AB_POC_CLIENT_TIMEOUT_MS` | Timeout của client cho `consult` | `180000` |

### Tương thích phiên bản

Spike viết theo reference ghim v18.13.3 (`references/extension-types.v18.13.3.ts.txt`), và đã được
đối chiếu lại với mã nguồn tag `v18.14.0` (`types.ts`, `agent-session-types.ts`, `session-manager.ts`,
`shared-events.ts`): **mọi member spike dùng giữ nguyên signature**, chỉ số dòng dịch chuyển.
Comment trong `agentbridge-poc.ts` ghi số dòng v18.13.3; bảng dưới là số dòng tương ứng ở v18.14.0.

| API | v18.13.3 | v18.14.0 |
|---|---|---|
| `ExtensionUIDialogOptions` / `onTimeout` | 202 / 206 | 207 / 211 |
| `ExtensionUIContext` / `confirm` / `notify` / `setStatus` | 311 / 324 / 349 / 355 | 316 / 329 / 354 / 377 |
| `ExtensionContext` | 680 | 746 |
| `ctx.mode` / `hasUI` / `cwd` | 684 / 692 / 694 | 750 / 758 / 760 |
| `ctx.sessionManager` / `model` / `isIdle` | 696 / 702 / 706 | 762 / 768 / 772 |
| `ctx.agent` / `ExtensionAgentIdentity` | 746 / 529 | 812 / 551 |
| `ctx.runEphemeralTurn` | 764 | 830 |
| `ctx.setInterval` / `setTimeout` / `clearTimer` | 778 / 784 / 786 | 851 / 857 / 859 |
| `pi.on` session_start / switch / shutdown / agent_start / agent_end | 1728 / 1733 / 1749 / 1763 / 1764 | 1820 / 1825 / 1841 / 1855 / 1856 |
| `EphemeralTurnOptions` / `EphemeralTurnResult` | 622 / 647 | 622 / 647 |
| `ReadonlySessionManager` `Pick`; `SessionManager.getSessionId` / `getSessionFile` | 726; 3211 / 3215 | 726; 3211 / 3215 |

Ở v18.14.0, `replyMaxBytes` vẫn chỉ được áp khi dedupe bật
(`agent-session.ts:12815`: `args.dedupeReply === false ? replyText.trim() : dedupeEphemeralReply(...)`),
nên việc tự cắt reply trong extension vẫn cần thiết.

---

## 1. Khởi động OMP với PoC

Trong terminal 1:

```bash
cd /tmp/ab-e2
AGENTBRIDGE_RUNTIME_DIR=/tmp/ab-poc \
  omp -e /home/you/projects/agentbridge/spike/agentbridge-poc.ts
```

Kỳ vọng: status bar hiện `🔗 poc`. Nếu không thấy, xem `poc.log` (mục 7) — extension có thể đã bị
lọc vì không phải phiên `main`/`hasUI`/`tui`, hoặc runtime dir không hợp lệ.

Làm ấm phiên để có context, ví dụ hỏi OMP: *"Tóm tắt mục tiêu của thư mục này trong 3 câu."*
Sau đó, ở terminal 2:

```bash
AGENTBRIDGE_RUNTIME_DIR=/tmp/ab-poc \
  bun /home/you/projects/agentbridge/spike/client.ts status
```

Ghi lại `sessionFile` trong output (cũng là `ctx.sessionManager.getSessionFile()`), và
`sessionId`, `model`, `idle`. Nếu có nhiều phiên PoC đang sống, client chọn phiên có heartbeat mới
nhất và in danh sách; dùng `--session <sessionId-prefix>` để chỉ định.

---

## 2. G1 + G2 — consult và tính bất biến của file phiên

```bash
SESSION_FILE="<dán sessionFile ở bước 1>"
sha256sum "$SESSION_FILE" | tee /tmp/ab-e2/before.sha256
wc -l "$SESSION_FILE"

AGENTBRIDGE_RUNTIME_DIR=/tmp/ab-poc \
  bun /home/you/projects/agentbridge/spike/client.ts consult "Phiên này đang thảo luận gì?"

sha256sum "$SESSION_FILE" | tee /tmp/ab-e2/after.sha256
wc -l "$SESSION_FILE"
diff /tmp/ab-e2/before.sha256 /tmp/ab-e2/after.sha256 && echo "G2: hash không đổi"
```

- **G1 pass** khi OMP hiện hộp thoại xác nhận, người dùng đồng ý, và client in delta (nếu provider
  stream) rồi block JSON có `replyText` không rỗng.
- **G2 pass** khi `diff` không có output và số dòng không đổi.

Lưu ý: client in delta ra stdout ngay khi nhận, rồi in JSON kết quả. Nếu provider không stream,
phần delta trống nhưng kết quả vẫn có.

---

## 3. G3 — consult khi OMP đang bận (E6)

Trong OMP, yêu cầu: *"Chạy lệnh `sleep 45` rồi báo kết quả."* Ngay khi lượt chính bắt đầu chạy:

```bash
AGENTBRIDGE_RUNTIME_DIR=/tmp/ab-poc \
  bun /home/you/projects/agentbridge/spike/client.ts consult "Trong lúc bạn đang bận, tóm tắt việc đang làm"
```

Quan sát và ghi lại:

1. Client trả lời trong bao lâu (log `consult_done.durationMs`).
2. Lượt chính của OMP có bị chèn, dừng, hay đổi thứ tự tool không.
3. Hộp thoại xác nhận có hiện được **khi đang chạy** hay không (đây đồng thời là G4-bận).

Tùy chọn, bằng chứng thêm cho `busy_limit`: mở hai terminal, chạy hai `consult` gần như đồng thời.
Một cái phải nhận `server:busy_limit` (exit code 2). Không bắt buộc cho GATE.

Tùy chọn, bằng chứng cho hủy (E6): nhấn `Ctrl+C` ở client khi consult đang chạy. Server phải log
`consult_error` với `code: "cancelled"`, hộp thoại đang mở (nếu có) phải đóng, và lượt chính của
OMP không được thay đổi.

---

## 4. G4 — `ui.confirm` ở hai trạng thái

| Trạng thái OMP | Cách tạo | Kỳ vọng |
|---|---|---|
| idle | G1 (không có lượt nào đang chạy) | Hộp thoại hiện, chọn "Yes" → consult chạy; chọn "No" → client nhận `server:denied` |
| đang chạy | G3 (`sleep 45`) | Hộp thoại vẫn hiện và trả kết quả, lượt chính không bị hủy |

Thử cả hai câu trả lời (đồng ý và từ chối) ít nhất một lần. Ghi lại thời điểm và hành vi quan sát
được; nếu hộp thoại không hiện khi đang chạy, ghi rõ hiện tượng (treo, lỗi, hay bị bỏ qua).

---

## 5. G5 — hành vi của `maxTokens` (ghi nhận, không chặn)

Thoát OMP, khởi động lại với biến môi trường:

```bash
cd /tmp/ab-e2
AGENTBRIDGE_RUNTIME_DIR=/tmp/ab-poc AB_POC_MAXTOKENS=1024 \
  omp -e /home/you/projects/agentbridge/spike/agentbridge-poc.ts
```

Rồi:

```bash
AGENTBRIDGE_RUNTIME_DIR=/tmp/ab-poc \
  bun /home/you/projects/agentbridge/spike/client.ts consult "Trả lời ngắn: 2+2 bằng mấy?"
```

Ghi lại một trong hai kết quả:

- Transport giữ được giới hạn: có `replyText`, log `consult_done.maxTokens = 1024`.
- Transport từ chối: client nhận `server:max_tokens_unsupported`, log `consult_error` có message
  chứa `does not support maxTokens for ephemeral turns` (hoặc tương đương).

Cả hai đều hợp lệ cho G5; điều cần biết là **transport hiện tại của bạn thuộc loại nào**, vì nó
quyết định `allowUncapped` trong T7.

---

## 6. Bảng checklist — điền vào `spike/RESULTS.md`

Sao chép khối dưới vào `spike/RESULTS.md` (file này do người dùng tạo sau khi chạy), điền kết quả
và dán bằng chứng (đoạn log, hash, exit code).

### Thông tin môi trường

| Mục | Giá trị |
|---|---|
| Ngày chạy | |
| `omp --version` | |
| Model OMP dùng khi test | |
| `sessionId` / `sessionFile` | |
| Runtime dir | |
| Provider/transport (nếu biết) | |

### Kết quả GATE

| Gate | Tiêu chí | Cách kiểm | Kết quả | Bằng chứng |
|---|---|---|---|---|
| G1 | `replyText` không rỗng, gọi từ callback socket | Mục 2 | ☐ Pass ☐ Fail | |
| G2 | hash file phiên không đổi | Mục 2 (`diff before/after`) | ☐ Pass ☐ Fail | |
| G3 | consult khi OMP bận vẫn trả lời; lượt chính không bị gián đoạn | Mục 3 | ☐ Pass ☐ Fail | |
| G4a | `ui.confirm` hiện và trả kết quả khi idle | Mục 2 + 4 | ☐ Pass ☐ Fail | |
| G4b | `ui.confirm` hiện và trả kết quả khi đang chạy | Mục 3 + 4 | ☐ Pass ☐ Fail | |
| G5 | ghi nhận hành vi `maxTokens` | Mục 5 | ☐ Giữ được ☐ Bị từ chối ☐ Khác | |

### Ghi chú thêm

| Câu hỏi | Trả lời |
|---|---|
| Thời gian consult khi idle / khi bận (ms) | |
| `usage` trong kết quả có giá trị? | |
| Delta streaming có hoạt động? | |
| Có lỗi nào trong `poc.log` không mong đợi? | |
| Hành vi lạ của TUI khi hộp thoại hiện giữa lượt chạy | |

---

## 7. Đọc log và artifact

```bash
ls -la /tmp/ab-poc
cat /tmp/ab-poc/poc.log                       # JSONL, mỗi dòng một sự kiện
tail -n 20 /tmp/ab-poc/poc.log
```

Các sự kiện chính:

| `event` | Nội dung |
|---|---|
| `host_started` / `host_stopped` | endpoint, session, model, `hasRunEphemeralTurn` |
| `hello` / `auth_failed` / `status` | handshake và truy vấn trạng thái |
| `consult_start` | `idle`, `model`, `questionBytes`, `maxTokens` |
| `consult_consent` | quyết định của người dùng |
| `consult_done` | `replyLen`, `replyBytesRaw`, `truncated`, `replyChars`, `deltaChunks`, `usage`, `durationMs` |
| `consult_error` | `code` + `message` đầy đủ |
| `agent_start` / `agent_end` | `idle`, `willContinue` — dùng để chứng minh lượt chính không bị chèn |
| `heartbeat`, `*_failed` | liveness và mọi lỗi đã bắt |

Mọi dòng đều có `ts` (ISO 8601). Log không chứa nội dung câu hỏi hay câu trả lời, chỉ độ dài.

Exit code của client: `0` ok, `2` server error, `3` socket đóng trước result, `4` không có record
dùng được, `5` sai cú pháp, `6` timeout, `7` unauthorized, `8` lỗi kết nối.

---

## 8. Dọn dẹp

1. Thoát OMP: log phải có `host_stopped` với `reason: "session_shutdown"`, và record/token/socket
   biến mất (chỉ còn `poc.log`).
2. `rm -rf /tmp/ab-poc /tmp/ab-e2` sau khi đã dán bằng chứng vào `RESULTS.md`.
3. Nếu OMP bị `kill -9`, artifact sẽ còn lại; client sẽ báo "tiến trình OMP đã chết (stale)" và
   không kết nối. Xóa thư mục runtime rồi chạy lại.

---

## 9. Nếu GATE thất bại

Theo `docs/plan/02-tasks.md` T0:

| Gate | Phương án |
|---|---|
| G1 — `ctx` hết hiệu lực | (a) lấy `ctx` mới ở mỗi `agent_start`/`turn_start`; (b) chạy consult bên trong `ctx.setTimeout(…, 0)`. Ghi kết quả từng cách vào `RESULTS.md`, **không** tự đổi spec. |
| G4 — confirm không hiện khi đang chạy | Chuyển sang phương án dự phòng: `ctx.ui.notify` + lệnh `/agentbridge allow <id>` (thay đổi spec 7.4 bước 7). Ghi lại trước khi sửa spec. |
| G2 — file phiên đổi | **Dừng dự án** và báo lại: mục tiêu "không đổi lịch sử" không đạt được. |

Nếu một API OMP không khớp reference ghim v18.13.3 hoặc mã nguồn tag v18.14.0, dừng và báo lại
thay vì đoán.
