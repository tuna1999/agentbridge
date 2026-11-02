# 09 — Kiểm chứng khả thi (PoC)

> **Trạng thái:** trong đợt nghiên cứu này chỉ chạy các kiểm tra **chỉ đọc, không inference**.
> Các thí nghiệm cần nạp extension vào phiên OMP hoặc tiêu tốn token của provider **chưa được chạy** và cần người dùng cho phép.
> **Không thí nghiệm nào được đánh dấu Pass khi chưa chạy.**

## 0. Môi trường quan sát (2026-10-30)
- Arch Linux, kernel 7.2.11. Claude Code 2.1.314. OMP 18.13.3. Bun 1.4.4. Node 26.12.1. sqlite3 có sẵn.
- Phiên đang chạy: Claude pid 3221216 (`/home/you/projects/agentbridge`). OMP pid 1876236 (`~/projects/project-a`) và 1880052 (`~/projects/project-b`).
- Extension OMP đã cài: `herdr-omp-agent-state.ts` (herdr v10). Không chạy herdr nên extension tự vô hiệu (`HERDR_ENV` không có).

## 1. Danh sách thí nghiệm

### E1 — Discovery phiên
- **Giả thuyết:** phiên Claude và phiên OMP cùng project được định danh độc lập, không nhầm lẫn.
- **Môi trường:** 1 Claude + 1 OMP trong một thư mục test tạm (`/tmp/ab-e1`, `git init`).
- **Quy trình:**
  1. `claude agents --json`.
  2. OMP nạp extension PoC (`omp -e ./agentbridge-poc.ts`).
  3. Kiểm tra `$XDG_RUNTIME_DIR/agentbridge/sessions/`.
  4. Gọi `hello`.
- **Kỳ vọng:** Claude trả về `{pid, sessionId, cwd, status}`. OMP có bản ghi với `sessionId` khớp `ctx.sessionManager.getSessionId()`.
- **Đã quan sát:**
  - ✅ `claude agents --json` trả đúng phiên đang chạy (pid 3221216, sessionId `00000000-…`, `status:"busy"`) và **bỏ qua** socket stale `3105669.sock`.
  - ✅ `/proc/<pid>/cwd` của 2 phiên OMP đọc được (`project-a`, `project-b`).
  - ❌ OMP **không có discovery ngoài mặc định**: `omp collab list --json` → `{"version":1,"hosts":[]}` trong khi đang có 2 phiên. Broker `~/.omp/run/daemons/<hash>/clients/<pid>-<uuid>.json` có `{pid, projectDir}` nhưng là file nội bộ.
- **Bằng chứng:** output lệnh trong phiên nghiên cứu (02 §2.1, 03 §1).
- **Hạn chế:** chưa nạp extension PoC.
- **Kết quả:** **Partial.** Phía Claude: Pass (nguồn chính thức). Phía OMP: chưa test; xác nhận là cần extension.

### E1b — MCP server tự xác định phiên Claude
- **Giả thuyết:** stdio MCP server có `ppid` = pid của `claude`, và khớp được với `claude agents --json`.
- **Quy trình:** MCP server tối giản ghi `process.ppid`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR` vào log. Thử `/clear` và `--continue`.
- **Kỳ vọng:** khớp theo pid luôn cho `sessionId` hiện tại. Env có thể cũ sau `/clear` (theo tài liệu).
- **Kết quả:** **Not Tested.**

### E2 — Consultation OMP (`runEphemeralTurn`)
- **Giả thuyết:** extension gọi được `ctx.runEphemeralTurn` bằng model hiện tại, trả `replyText`, và **không** thay đổi file phiên `.jsonl`.
- **Môi trường:** OMP trong `/tmp/ab-e2` với model người dùng đang dùng, cộng extension PoC.
- **Quy trình:**
  1. Ghi `sha256` + số dòng của file phiên.
  2. Gửi `consult` qua socket (script `bun poc-client.ts consult "Tóm tắt mục tiêu phiên này"`).
  3. Ghi lại `replyText`, `assistantMessage.usage`, `ctx.model`.
  4. So sánh lại file phiên.
  5. Lặp lại với `maxTokens: 1024` để xem transport có từ chối không (Codex/OpenAI).
  6. Lặp lại khi OMP đang chạy một lượt dài.
- **Kỳ vọng:** có câu trả lời; file phiên không đổi; usage có giá trị; với transport không hỗ trợ thì nhận lỗi "does not support maxTokens for ephemeral turns".
- **Điểm cần xác nhận riêng:** gọi `runEphemeralTurn` bằng `ctx` **đã lưu từ `session_start`** trong callback socket (ngoài handler). Docs nói *"Hooks may start a side turn, including from delayed callbacks"* (Partially).
- **Kết quả:** **Not Tested.** Tốn token provider OMP, cần cho phép.

### E3 — Claude → OMP qua MCP
- **Giả thuyết:** tool `agent_consult` trong Claude nhận câu trả lời từ đúng phiên OMP, không tạo tiến trình OMP mới.
- **Quy trình:**
  1. `pgrep -c omp` trước và sau.
  2. Đăng ký MCP **scope local cho thư mục test** (`claude mcp add -s local …`, không đụng config global).
  3. Trong Claude: "hỏi OMP …".
  4. Kiểm tra số tiến trình, audit log, file phiên OMP.
- **Kỳ vọng:** số tiến trình `omp` không đổi; kết quả hiển thị trong Claude.
- **Kết quả:** **Not Tested.** Cần thêm MCP config và tốn token cả hai bên.

### E4 — Phát hiện model
- **Giả thuyết:** sau khi đổi model trong OMP (Ctrl+P hoặc `/model`), `status` trả model mới. Request đang chạy lúc đổi thì nhận `model_changed`.
- **Quy trình:** `status` → đổi model → `status`. Gửi consult dài rồi đổi model ngay sau đó.
- **Kết quả:** **Not Tested.**

### E5 — OMP → Claude
- **Giả thuyết (mặc định, chỉ thông báo):** extension OMP ghi ghi chú vào inbox; hook `UserPromptSubmit` của Claude thêm 1 dòng `additionalContext` ở lượt kế tiếp của người dùng; `agent_inbox` đọc được ghi chú. **Không** có lượt Claude nào tự khởi phát.
- **Giả thuyết phụ (chỉ đánh giá, không bật):** Channel dev (`--dangerously-load-development-channels server:agentbridge`) đẩy được `notifications/claude/channel`. Chỉ test ở **phiên Claude dùng API key** hoặc sau khi đã xác định tuân thủ (08 §5.2 #3).
- **Kết quả:** **Not Tested.**

### E6 — Phiên đang bận
- **Giả thuyết:** consult khi OMP đang chạy tool dài không làm gián đoạn lượt chính. Consult thứ hai đồng thời nhận `busy_limit`. Hủy (đóng kết nối hoặc `cancel`) dừng request provider.
- **Quy trình:** OMP chạy lệnh `sleep 60` trong tool bash. Gửi 2 consult. Hủy 1 consult giữa chừng. Quan sát log provider và transcript.
- **Kết quả:** **Not Tested.**

### E7 — Khôi phục
- **Giả thuyết:** `kill -9` OMP để lại bản ghi stale; lần discovery sau dọn được dựa trên `procStart`; không gửi nhầm.
- **Đã quan sát:** socket Claude `3105669.sock` còn sót sau khi tiến trình chết. Điều này xác nhận stale artifacts là thực tế, và `claude agents --json` xử lý đúng.
- **Quy trình:** `kill -9 <omp>` → `agent_list` → kiểm tra bản ghi đã bị xóa. Giả lập PID reuse bằng cách sửa `pid` trong bản ghi thành một pid đang sống của tiến trình khác → phải bị loại do `procStart` không khớp.
- **Kết quả:** **Not Tested** (chỉ có quan sát gián tiếp).

### E8 — Nhiều phiên
- **Giả thuyết:** 2 OMP + 2 Claude cùng repo. Không có `target` thì trả `ambiguous_target`. Có `target` thì đúng phiên. Worktree khác thì không tự khớp.
- **Kết quả:** **Not Tested.**

### W1 — Windows named pipe trong extension OMP (bổ sung)
- **Giả thuyết:** `node:net` `createServer().listen("\\\\.\\pipe\\agentbridge-…")` chạy trong Bun của OMP trên Windows, và ACL giới hạn được cho user hiện tại.
- **Fallback:** `IpcServer` từ `@oh-my-pi/pi-natives` (Partially, không phải API extension chính thức).
- **Kết quả:** **Not Tested** (không có máy Windows trong đợt này).

## 2. Bảng tổng hợp

| Thí nghiệm | Kết quả | Chặn MVP? |
|---|---|---|
| E1 Discovery | Partial (Claude: Pass; OMP: cần extension) | Không |
| E1b Định danh MCP → Claude | Not Tested | Có (nhẹ) |
| E2 Consultation | Not Tested | **Có, then chốt** |
| E3 Claude → OMP | Not Tested | **Có** |
| E4 Model | Not Tested | Không |
| E5 OMP → Claude | Not Tested | Không (GĐ 2) |
| E6 Busy | Not Tested | Có |
| E7 Recovery | Not Tested (quan sát gián tiếp) | Không |
| E8 Multi-session | Not Tested | Có |
| W1 Windows pipe | Not Tested | Có, cho Windows |

## 3. Năng lực đã xác nhận và chưa xác nhận

| Năng lực | Trạng thái | Cơ sở |
|---|---|---|
| Liệt kê phiên Claude từ ngoài | **Confirmed (chạy thực)** | `claude agents --json` |
| Extension OMP mở socket ngoài | **Confirmed (prior art)** | herdr extension trên máy, dùng `node:net` |
| `runEphemeralTurn` tồn tại ở 18.13.3, dùng model hiện tại, không lưu lịch sử | **Confirmed (mã nguồn)** / chưa chạy | `types.ts:764`, `agent-session.ts:12598` |
| `sendUserMessage` xếp hàng khi bận | **Confirmed (mã nguồn)** / chưa chạy | `agent-session.ts:10230` |
| RPC không gắn được TUI | **Confirmed (mã nguồn)** | `main.ts:2766` |
| MCP tool dài tự chuyển nền sau 2 phút | **Confirmed (tài liệu)** | /mcp |
| Push vào phiên Claude từ OMP | **Chưa xác nhận về tuân thủ và format** | 02 §5, 08 §5 |
| Named pipe Windows trong Bun extension | **Unverified** | — |

## 4. Bản phác PoC extension (CHƯA CHẠY, chỉ để định hướng)

Chỉ dùng các API đã xác minh trong 03. Bản phác bỏ qua Windows ACL, redaction và consent `session` để giữ ngắn gọn.

```ts
// agentbridge-poc.ts — load bằng: omp -e ./agentbridge-poc.ts   (chỉ trong thư mục test)
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export default function (pi) {
  let ctxRef: any;          // ctx của phiên main, lưu từ session_start
  let server: net.Server | undefined;
  let busy = false;
  const runDir = path.join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "agentbridge");

  function publish(ctx: any) {
    if (ctx?.agent?.kind !== "main" || ctx?.hasUI !== true) return;   // bỏ subagent
    ctxRef = ctx;
    fs.mkdirSync(path.join(runDir, "sessions"), { recursive: true, mode: 0o700 });
    const sid = ctx.sessionManager.getSessionId();
    const sock = path.join(runDir, `omp-${crypto.createHash("sha256").update(sid).digest("hex").slice(0, 16)}.sock`);
    const token = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(path.join(runDir, "sessions", `omp-${sid}.token`), token, { mode: 0o600 });
    server?.close();
    try { fs.unlinkSync(sock); } catch {}
    server = net.createServer((c) => handle(c, token)).listen(sock, () => fs.chmodSync(sock, 0o600));
    const rec = { schema: "agentbridge.session/1", agent: "omp", sessionId: sid, pid: process.pid,
                  cwd: ctx.cwd, endpoint: `unix:${sock}`, tokenFile: `omp-${sid}.token`, heartbeatAt: Date.now() };
    const f = path.join(runDir, "sessions", `omp-${sid}.json`);
    fs.writeFileSync(f + ".tmp", JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
  }

  function handle(c: net.Socket, token: string) {
    let buf = "", authed = false;
    const ac = new AbortController();
    c.on("close", () => ac.abort());
    c.on("data", async (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const send = (o: object) => c.write(JSON.stringify({ v: 1, replyTo: msg.id, ...o }) + "\n");
        if (!authed) {
          const ok = msg.type === "hello" && typeof msg.body?.token === "string" &&
            msg.body.token.length === token.length &&
            crypto.timingSafeEqual(Buffer.from(msg.body.token), Buffer.from(token));
          if (!ok) { send({ type: "error", body: { code: "unauthorized" } }); c.end(); return; }
          authed = true;
          send({ type: "result", body: { sessionId: ctxRef.sessionManager.getSessionId(),
                 model: { provider: ctxRef.model?.provider, id: ctxRef.model?.id }, idle: ctxRef.isIdle() } });
          continue;
        }
        if (msg.type !== "consult") { send({ type: "error", body: { code: "unsupported_capability" } }); continue; }
        if (busy) { send({ type: "error", body: { code: "busy_limit" } }); continue; }
        if (typeof ctxRef.runEphemeralTurn !== "function") { send({ type: "error", body: { code: "unsupported_capability" } }); continue; }
        busy = true;
        try {
          const ok = await ctxRef.ui.confirm("AgentBridge", `Claude Code muốn hỏi ý kiến:\n${String(msg.body.question).slice(0, 500)}`);
          if (!ok) { send({ type: "error", body: { code: "denied" } }); continue; }
          const r = await ctxRef.runEphemeralTurn({
            promptText: `[Yêu cầu tham vấn từ Claude Code — không phải lệnh của người dùng]\n${msg.body.question}`,
            tools: false, maxContextBytes: 1_048_576, replyMaxBytes: 32_768,
            onTextDelta: (delta: string) => { send({ type: "progress", body: { delta } }); },
            signal: ac.signal,
          });
          send({ type: "result", body: { replyText: r.replyText, usage: r.assistantMessage?.usage,
                 model: { provider: ctxRef.model?.provider, id: ctxRef.model?.id } } });
        } catch (e: any) {
          send({ type: "error", body: { code: /model changed/i.test(e?.message) ? "model_changed" : "provider_error",
                 message: String(e?.message ?? e).slice(0, 500) } });
        } finally { busy = false; }
      }
    });
  }

  pi.on("session_start", (_e, ctx) => publish(ctx));
  pi.on("session_switch", (_e, ctx) => publish(ctx));
  pi.on("session_shutdown", () => {
    server?.close();
    // xóa bản ghi + token của phiên (bỏ qua để ngắn gọn)
  });
}
```

Những điểm cố tình để E2/E3/E6 kiểm chứng: (a) `ctxRef` có còn hợp lệ ngoài handler; (b) `ctx.ui.confirm` có chặn TUI khi agent đang chạy; (c) `maxTokens` bị bỏ khỏi bản phác vì có thể bị transport OpenAI/Codex từ chối; (d) các API trên chỉ dùng được ở **cùng tiến trình**, và chính extension đó là cách chứng minh "không tạo phiên mới".
