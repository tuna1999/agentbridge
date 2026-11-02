# AgentBridge — Danh sách task (giao cho OMP)

> Trước mỗi task, agent PHẢI đọc `00-overview.md` §4 (quy tắc) và các mục của `01-design-spec.md` mà task tham chiếu.
> Ký hiệu: **[Người dùng]** = bước chỉ người dùng làm được (chạy OMP hoặc Claude thật, tốn token).
> Ước lượng tính cho một agent có review của người.

| ID | Tên | Phụ thuộc | Ước lượng |
|---|---|---|---|
| T0 | Spike PoC + GATE | — | 0,5 ngày code + [Người dùng] 1 giờ |
| T1 | Scaffold monorepo | GATE | 0,5 ngày |
| T2 | `protocol`: envelope, framing, validate, errors, redact, pathguard, limits | T1 | 1,5 ngày |
| T3 | `core`: dirs, config, registry, proc, git, audit | T2 | 1,5 ngày |
| T4 | `core`: IPC server/client + handshake | T2 | 1 ngày |
| T5 | `protocol/match` | T2 | 0,5 ngày |
| T6 | Extension: lifecycle, registry, status, command | T3, T4 | 1,5 ngày |
| T7 | Extension: consult + consent + audit | T6 | 1,5 ngày |
| T8 | MCP server + CLI `ab` | T3, T4, T5 | 2 ngày |
| T9 | Integration test (fake host ↔ MCP client) | T7, T8 | 1 ngày |
| T10 | Build, install, doctor, README + [Người dùng] E2E | T9 | 1 ngày |
| T11 | Windows | T10 | 2–3 ngày |

---

## T0 — Spike PoC và GATE

**Mục tiêu:** chứng minh giả định then chốt trước khi đầu tư. `ctx` được lưu từ `session_start` phải gọi được `runEphemeralTurn` và `ui.confirm` **từ callback socket**, ngoài event handler.

**File tạo:** `spike/agentbridge-poc.ts`, `spike/client.ts`, `spike/README.md`.

**Yêu cầu:**
1. `agentbridge-poc.ts`: lấy bản phác ở `docs/research/09-feasibility-tests.md` §4. Đối chiếu từng API với `types.ts` tại v18.13.3. Thêm:
   - Log ra `$AGENTBRIDGE_RUNTIME_DIR/poc.log` (mặc định `/tmp/ab-poc`): thời điểm, `ctx.isIdle()`, model, độ dài reply, `usage`, và mọi lỗi kèm message.
   - Biến môi trường `AB_POC_MAXTOKENS` (số). Nếu có thì truyền `maxTokens` để thử phản ứng của transport.
   - Lệnh `status` trả `{sessionId, model, idle, sessionFile: ctx.sessionManager.getSessionFile?.()}`.
2. `client.ts` (bun): `bun spike/client.ts status|consult "<q>"`. Tìm file `.json` trong runtime dir, đọc token, kết nối, in các delta và kết quả.
3. `README.md`: quy trình cho [Người dùng], bám theo E2/E6 trong research 09.

**[Người dùng] chạy GATE**, trong thư mục tạm, không phải project thật:
```bash
mkdir -p /tmp/ab-e2 && cd /tmp/ab-e2 && git init -q && echo "# test" > README.md
AGENTBRIDGE_RUNTIME_DIR=/tmp/ab-poc omp -e ~/projects/agentbridge/spike/agentbridge-poc.ts
# Trong OMP: hỏi một câu bất kỳ để phiên có context. Ghi lại đường dẫn file phiên (từ client status).
# Terminal khác:
sha256sum <session-file>
bun ~/projects/agentbridge/spike/client.ts consult "Phiên này đang thảo luận gì?"
sha256sum <session-file>                        # phải giống
# Bận: trong OMP yêu cầu "chạy lệnh sleep 45 rồi báo kết quả", ngay lúc đó chạy consult lần nữa
# maxTokens: AB_POC_MAXTOKENS=1024 omp -e …  rồi consult
```

**Tiêu chí GATE (tất cả phải đạt):**
- [ ] G1: consult trả `replyText` không rỗng, gọi từ callback socket.
- [ ] G2: hash file phiên không đổi.
- [ ] G3: consult khi OMP đang bận vẫn trả lời, và lượt chính của OMP không bị chèn hay gián đoạn.
- [ ] G4: `ui.confirm` hiện được và trả kết quả, cả khi OMP đang idle lẫn khi đang chạy.
- [ ] G5 (ghi nhận, không chặn): hành vi khi truyền `maxTokens` với provider hiện tại.

**Nếu thất bại:**
- G1 thất bại vì `ctx` hết hiệu lực → thử (a) lấy `ctx` mới ở mỗi `agent_start`/`turn_start`, (b) thực thi consult bên trong `ctx.setTimeout(…, 0)`. Ghi kết quả từng cách.
- G4 thất bại khi đang chạy → dùng `ctx.ui.notify` kèm lệnh `/agentbridge allow <id>` (đổi spec 7.4 bước 7).
- G2 thất bại → **dừng dự án** và báo lại. Khi đó mục tiêu "không đổi lịch sử" không đạt được.

**Kết quả bàn giao:** người dùng điền vào `spike/RESULTS.md` (pass/fail từng mục kèm log). Sau GATE thì xóa thư mục `spike/` hoặc giữ làm tham khảo, không đưa vào build.

---

## T1 — Scaffold monorepo

**Spec:** 00 §3.

**Yêu cầu:**
- Root `package.json`: `"private": true`, `"workspaces": ["packages/*"]`, scripts `build`, `test` (`bun test`), `typecheck` (`tsc -b` hoặc `tsc --noEmit -p` từng package), `lint` (tùy chọn).
- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `module: ESNext`, `moduleResolution: bundler`, `target: ES2022`, `types: ["bun-types"]`.
- Bốn package `@agentbridge/{protocol,core,omp-extension,mcp-server}`, mỗi package có `src/index.ts` rỗng và một test mẫu.
- Dev dependencies: `typescript`, `@types/bun` (hoặc `bun-types`). `mcp-server` có thêm `@modelcontextprotocol/sdk` và `zod`, ghi **phiên bản cụ thể**.
- `.gitignore`: `node_modules`, `dist`, `spike/*.log`.
- `git init` nếu chưa có. **Không commit** trừ khi người dùng yêu cầu.

**Chấp nhận:** `bun install && bun test && bun run typecheck` đều pass.

---

## T2 — `@agentbridge/protocol`

**Spec:** 01 §4, §5, §9. Package này **không có dependency runtime**.

**File:** `envelope.ts`, `errors.ts`, `framing.ts`, `validate.ts`, `ids.ts` (dùng `Bun.randomUUIDv7()` nếu có, nếu không thì tự cài UUIDv7), `redact.ts`, `pathguard.ts`, `limits.ts`, `messages.ts`, `index.ts`.

**Test bắt buộc:**
- framing: frame bị chia thành nhiều chunk; nhiều frame trong một chunk; frame vượt 1 MiB → `too_large`; UTF-8 đa byte bị cắt giữa chunk.
- validate: mỗi trường bắt buộc thiếu hoặc sai kiểu; `hop ≠ 0`; `v ≠ 1`; question vượt giới hạn theo **byte** (tiếng Việt có dấu).
- redact: ít nhất một ca dương tính và một ca âm tính cho mỗi mẫu ở 01 §5.1. Câu bình thường như "token bucket algorithm" không bị redact.
- pathguard: `../`, đường dẫn tuyệt đối ra ngoài root, symlink trỏ ra ngoài, `.env.local`, file nhị phân, file > 256 KiB, Windows case (mô phỏng bằng tham số `caseInsensitive`).

**Chấp nhận:** độ phủ test các file trên ≥ 90% dòng (`bun test --coverage`).

---

## T3 — `@agentbridge/core`: dirs, config, registry, proc, git, audit

**Spec:** 01 §2, §3, §6, §7.7.

**Yêu cầu:**
- Mọi đường dẫn đều override được bằng env, để test dùng `mkdtemp`.
- `ensureSecureDir(path)`: tạo dir 0700; kiểm tra owner và mode; từ chối symlink.
- `registry.ts` đúng API ở 01 §3.2. `checkLiveness` nhận `hello` function qua dependency injection để test không cần socket.
- `proc.ts`: Linux đầy đủ. Windows trả `"unknown"` kèm `TODO(T11)`.
- `config.ts`: parse, áp mặc định, cache theo mtime. Lỗi parse thì dùng mặc định an toàn, ghi log một lần.
- `audit.ts`: append mỗi lần một dòng, mode 0600, xoay vòng.

**Test bắt buộc:**
- Ghi nguyên tử: không bao giờ đọc thấy file dở dang (mô phỏng crash bằng cách để lại file `.tmp`).
- Liveness: pid không tồn tại → dead. Pid sống nhưng `procStart` khác (dùng pid của test runner và sửa `procStart`) → dead. Hello lỗi → unresponsive.
- `sweepStale` không xóa bản ghi `unresponsive`, và không xóa file thuộc uid khác (mock `stat`).
- `insecure_runtime_dir` khi mode là 0755.
- `gitInfo` với repo thường, worktree (`git worktree add` trong tmp), thư mục không có git, và symlink tới repo.

---

## T4 — `@agentbridge/core`: IPC transport

**Spec:** 01 §4.1, §4.3, §7.3 (phần transport), §9.

**API:**
```ts
startServer(opts: { endpoint: string; token: string; identity: HelloResultProvider;
                    onRequest: (env: Envelope, io: { send(e: Envelope): void; signal: AbortSignal }) => Promise<void> }): Promise<{ close(): Promise<void> }>
request(opts: { endpoint: string; token: string; from: Peer; to: Peer; type: "status"|"consult"; body: unknown;
                onProgress?: (p: ProgressBody) => void; signal?: AbortSignal; timeoutMs: number }): Promise<{ hello: HelloResult; result: unknown }>
hello(endpoint, token, timeoutMs): Promise<HelloResult>      // dùng cho liveness
endpointFor(runtimeDir, instanceId): string                  // unix: <runtimeDir>/s/<hash16>.sock
```
- Server: chmod 0600 cho socket sau khi `listen`. Xóa socket cũ **chỉ khi** không connect được tới nó (tránh cướp socket của tiến trình đang sống). Áp các deadline, lockout khi auth sai nhiều, và **một request mỗi kết nối**.
- Client: đóng socket khi `signal` abort hoặc hết timeout. Socket đóng trước khi có result → `target_exited`.
- Mọi lỗi phải được bắt. Không có exception nào được thoát ra event loop.

**Test bắt buộc:** auth đúng và sai; lockout; frame vượt giới hạn; client abort → server nhận `signal.aborted`; server đóng giữa chừng → client nhận `target_exited`; hai server cùng endpoint (server thứ hai phải lỗi); deadline hello và deadline request.

---

## T5 — `protocol/match.ts`

**Spec:** 01 §8.2. Hàm thuần, không I/O.

**Test bắt buộc** (bảng test, ≥ 15 ca): 0 ứng viên; 1 cùng worktree; 2 cùng worktree; 1 cùng repo nhưng worktree khác; repo lồng nhau (cha/con); không có git; target là id đầy đủ, tiền tố 7 ký tự (từ chối), tiền tố 8 ký tự duy nhất, tiền tố trùng, tên trùng; target ở project khác (có và không có `allowCrossProject`); ứng viên `unresponsive` duy nhất; Windows case-insensitive; đường dẫn có `/` ở cuối.

---

## T6 — Extension: lifecycle, registry, status, command

**Spec:** 01 §7.1, §7.2, §7.3 (chỉ `status`), §7.6.

**Yêu cầu:**
- `src/index.ts` export default factory. Factory **không** làm I/O.
- Lớp `Host` (`lifecycle.ts`) nhận một interface `OmpLike` (adapter mỏng bọc `pi`/`ctx`), để test dùng fake.
- Lọc phiên: chỉ `ctx.agent?.kind === "main" && ctx.hasUI === true && ctx.mode === "tui"`.
- Tạo endpoint, token và bản ghi mới mỗi lần `session_start`/`session_switch`. Dọn sạch ở `session_shutdown` bằng API sync.
- Cập nhật trạng thái theo event (01 §7.2). Heartbeat bằng `ctx.setInterval`.
- `ctx.ui.setStatus("agentbridge", …)`.
- Command `/agentbridge` với `status|trust|untrust|off|on`.
- Phải chạy được khi chưa có config (chỉ `status`).
- Bundle: `bun build src/index.ts --target=bun --format=esm --outfile=dist/agentbridge.js`. Không có import nào ngoài `node:*`. Kiểm tra bằng script: grep `dist/agentbridge.js` không được chứa `from "@` hay `require("` tới package ngoài.

**Test bắt buộc** (với fake `pi`/`ctx`): subagent không publish; `session_switch` xoay instanceId và token, xóa bản ghi cũ; shutdown xóa file; exception trong callback không thoát ra ngoài; status phản ánh `agent_start`/`agent_end(willContinue)`.

**[Người dùng] kiểm tra nhanh:** `omp -e dist/agentbridge.js` trong `/tmp/ab-test` → status bar có `🔗 bridge`; `ls $XDG_RUNTIME_DIR/agentbridge/sessions` có bản ghi; thoát OMP thì bản ghi biến mất.

---

## T7 — Extension: consult + consent + audit

**Spec:** 01 §7.4, §7.5, §7.7, §6.

**Yêu cầu:**
- Cài đặt đúng 14 bước ở 01 §7.4, theo đúng thứ tự kiểm tra.
- Xác minh kiểu `ExtensionUISelectItem` trong `types.ts` (string hay `{label, description}`) và dùng cho đúng.
- `buildPrompt` đúng như 01 §7.5. Có test snapshot.
- Rate limiter dạng token bucket (`ratePerMinute`). Concurrency đúng bằng 1.
- Dedupe LRU.
- Ánh xạ lỗi của `runEphemeralTurn` theo message (01 §7.4 bước 11). Gom các regex vào một chỗ, kèm comment trích dẫn `agent-session.ts:850-866, 12604-12615`.

**Test bắt buộc** (fake `runEphemeralTurn`):
- happy path có delta;
- consent: từ chối, timeout, "trong phiên này" (request sau không hỏi);
- `project_not_allowed`; `busy_limit`; `rate_limited`; `too_large`;
- `maxTokens` bị từ chối khi `allowUncapped` false và true;
- `model_changed`; abort giữa chừng → fake nhận signal aborted;
- reply chứa secret → bị redact;
- audit không chứa nội dung khi `content=false`.

---

## T8 — MCP server + CLI `ab`

**Spec:** 01 §8.

**Yêu cầu:**
- `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), tool schema bằng `zod`.
- **Không ghi bất cứ thứ gì ra stdout** ngoài giao thức MCP. Log ghi ra stderr, hoặc ra file khi đặt `AGENTBRIDGE_LOG`.
- Kiểm tra xem SDK có hỗ trợ protocol 2026-07-28 không. **Không** bật các tính năng `claude/channel`.
- `identity.ts` đúng 01 §8.1. Spawn `claude agents --json` qua DI để test được.
- Tools `agent_list`, `agent_status`, `agent_consult`, với mô tả và hành vi đúng 01 §8.3.
- Định dạng đầu ra đúng 01 §8.4. Thông báo lỗi tiếng Việt kèm gợi ý.
- Hủy: nối `extra.signal` của SDK vào `AbortController` của client.
- Progress chỉ gửi khi có `progressToken`, throttle 1 giây.
- `cli.ts` với các lệnh `list|status|consult|doctor|sweep` (01 §8.5). Dùng chung code client.

**Test bắt buộc:**
- identity: khớp pid ở cấp 1 và cấp 2; không khớp thì fallback env; `claude` không có trong PATH.
- `agent_consult` với host giả (dùng server ở T4 với `onRequest` giả): happy path, `ambiguous_target` có options, `include_files` bị pathguard chặn `.env`, hủy giữa chừng.
- Snapshot cho định dạng đầu ra.

---

## T9 — Integration test

**Yêu cầu:** `tests/integration/*.test.ts` ở root, chạy hoàn toàn trong `mkdtemp`:
1. Khởi động `Host` của extension với fake `pi`/`ctx` (`runEphemeralTurn` giả, có stream).
2. Spawn MCP server thật (`bun packages/mcp-server/src/index.ts`) bằng MCP SDK Client qua stdio, với env trỏ vào runtime dir tạm. `claude agents --json` được giả bằng một script nằm đầu `PATH`.
3. Gọi `agent_list` rồi `agent_consult`, và kiểm tra nội dung trả về.
4. Kill host (đóng server mà không dọn bản ghi) → `agent_list` hiện `dead` và dọn được; `agent_consult` → `no_target`.
5. Hai host cùng worktree → `ambiguous_target`. Có `target` → đúng host.

**Chấp nhận:** `bun test tests/integration` pass ổn định 20 lần liên tiếp (`for i in $(seq 20)`).

---

## T10 — Build, install, doctor, README và E2E

**Yêu cầu:**
- `bun run build` build extension, kiểm tra bundle sạch dependency, và in kích thước.
- `scripts/install.ts`: **mặc định chỉ in ra** các bước, không tự làm. Chỉ khi có `--apply` mới:
  1. copy `dist/agentbridge.js` → `~/.omp/agent/extensions/agentbridge.js`;
  2. chạy `claude mcp add -s user agentbridge -- bun <abs>/packages/mcp-server/src/index.ts`;
  3. tạo config mẫu nếu chưa có (`projects: []`).
  Mỗi bước hỏi y/n. Phát hiện bản cũ thì báo.
- `ab doctor`: kiểm tra đủ các mục ở 01 §8.5, cộng thêm: cảnh báo nếu tìm thấy `.omp/extensions/*agentbridge*` ở cấp project (rủi ro T4 trong research 08).
- `README.md` (tiếng Việt): AgentBridge là gì, cài đặt, cấu hình, cách dùng ("hỏi OMP…"), bảo mật và quyền riêng tư (context OMP được gửi tới provider OMP, câu trả lời đi tới Claude/Anthropic), gỡ cài đặt, xử lý sự cố.
- **[Người dùng] E2E:** làm theo `00-overview.md` §7, rồi điền `docs/plan/E2E-RESULTS.md` theo các tiêu chí chấp nhận ở `docs/research/10` §5.

---

## T11 — Windows

**Yêu cầu:**
- Endpoint named pipe (01 §2). Thử `node:net` trong Bun trước (W1). Nếu không giới hạn được ACL theo user thì dùng `IpcServer` từ `@oh-my-pi/pi-natives` (chỉ trong extension, có feature-detect), và ghi rõ cách nào được dùng.
- Token **bắt buộc** (giống Claude yêu cầu trên Windows).
- `procStart` qua PowerShell `(Get-Process -Id N).StartTime.ToFileTimeUtc()`, có cache. `getParentPid` qua `Get-CimInstance Win32_Process`.
- Chuẩn hóa đường dẫn không phân biệt hoa thường. Dùng `fs.realpathSync.native`.
- Phát hiện WSL (`/proc/version` chứa `microsoft`) và cảnh báo rằng không bắc cầu được sang Windows native.
- CI: GitHub Actions matrix `ubuntu-latest`, `windows-latest` chạy unit và integration test (không cần OMP hay Claude thật).
- **[Người dùng]** E2E trên Windows.

---

## Giai đoạn 2 (chỉ phác, chưa giao)
- **T12 Delegation:** capability `delegate`, `pi.sendUserMessage(text, {attribution:"agent", deliverAs: idle ? undefined : "followUp"})`, consent luôn bắt buộc, `mode:"worktree"`, bắt kết quả từ `agent_end`, lưu `stateDir/tasks/<id>.json`; tool `agent_delegate` (có `_meta["anthropic/requiresUserInteraction"]`) và `agent_get_result`.
- **T13 Inbox OMP → Claude:** tool OMP `bridge_note_to_claude`; ghi `runtimeDir/inbox/<claudeSessionId|project>.jsonl`; hook Claude `UserPromptSubmit` thêm một dòng `additionalContext`; tool `agent_inbox`.
- **T14 Worktree helper:** `ab worktree new <task>` tạo worktree và branch `agent/omp/<task>`, rồi in lệnh mở `omp` ở đó.
