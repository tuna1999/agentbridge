# AgentBridge

AgentBridge nối **Claude Code** với phiên **Oh My Pi (OMP)** đang mở trong cùng project, để Claude hỏi OMP một câu và nhận câu trả lời bằng model hiện tại của OMP.

- Không có daemon, không mở cổng mạng: mỗi phiên OMP là một server trên Unix domain socket cục bộ.
- Mỗi phiên Claude có một tiến trình MCP server riêng, chạy qua stdio.
- Lượt consult của OMP là lượt tạm (`runEphemeralTurn`): **không** sửa file phiên OMP, **không** thực thi tool, **không** chèn vào lượt chính.
- **Chat (opt-in, mặc định tắt)**: Claude gửi tin vào phiên OMP như một lượt chat thật. Tin hiện trong transcript, OMP có thể chạy tool theo quyền của nó, và người dùng xác nhận **từng tin** trên OMP (trừ khi bật autochat).
- **Autochat (opt-in, mặc định tắt)**: bỏ bước xác nhận chat theo `chat.autoApprove`; chỉ đọc lúc start, yêu cầu config ngoài project và 0600/cùng uid.
- Câu trả lời là **dữ liệu tham khảo** từ agent khác, không phải chỉ thị của người dùng.

Trạng thái: MVP cho Linux. Windows thuộc T11, chưa hỗ trợ.

---

## 1. Yêu cầu

| Thành phần | Yêu cầu |
|---|---|
| Hệ điều hành | Linux (macOS chưa được kiểm thử; Windows chưa hỗ trợ) |
| Bun | ≥ 1.4 (đã chạy với 1.4.4) |
| OMP | ≥ 18.13.3 (GATE chạy trên 18.14.0) |
| Claude Code | Bản có MCP server qua stdio |
| Lệnh trong `PATH` | `bun`, `claude`, `omp` |

Không cần Node.js riêng: MCP server chạy bằng Bun.

---

## 2. Cài đặt (plugin)

AgentBridge phát hành hai plugin từ cùng marketplace `agentbridge`: **Claude Code plugin** (MCP server) và **OMP plugin** (extension OMP). Cài cả hai — không cần clone repo:

```bash
claude plugin marketplace add tuna1999/agentbridge
claude plugin install agentbridge@agentbridge
omp plugin marketplace add tuna1999/agentbridge
omp plugin install agentbridge@agentbridge
```

Sau đó mở OMP trong project và chạy trong **main OMP TUI**:

```text
/agentbridge allow
```

Lệnh này hỏi xác nhận, thêm `realpath` của project vào `~/.agentbridge/config.json` và tạo file từ mẫu mặc định nếu chưa có. `/agentbridge disallow` bỏ project khỏi allowlist; `/agentbridge config` chỉ in tóm tắt config (không sửa). Có thể sửa `projects` thủ công nếu muốn (xem §3).

`bun` **phải có trong `PATH`**: Claude plugin chạy MCP server bằng `bun`, và OMP extension cũng chạy bằng Bun.

Plugin được cache và quản lý bởi Claude/OMP; **không cần clone**, `bun install`, hay `bun run build`.

Claude plugin được cài dưới cache của Claude (`~/.claude/plugins/...`); OMP plugin nằm dưới `~/.omp/plugins/node_modules/...`. Hai thư mục tách biệt: package OMP chỉ chứa extension OMP, không chứa `.mcp.json`/MCP server của Claude plugin, nên OMP không nạp extension OMP từ Claude plugin (và Claude không nạp extension OMP).

Tuy nhiên OMP **có thể** nạp MCP server từ Claude plugin đã cài trong `~/.claude`: OMP có provider `claude-plugins` đọc `~/.claude/plugins/installed_plugins.json` và `.mcp.json` của plugin. Nếu OMP làm vậy, MCP server AgentBridge khởi động với một tiến trình `omp` trong ancestor chain; startup guard (`packages/mcp-server/src/caller-support.ts`) phát hiện `omp` ancestor, đăng ký **không tool nào** và log `[AgentBridge] unsupported_caller`. Đây là hành vi được thiết kế để OMP không tự gọi tool của chính nó, không phải lỗi cài đặt.

### Cập nhật plugin

Phiên bản hiện tại: **0.1.1**. Plugin chỉ được cập nhật khi version trong catalog tăng (nguồn duy nhất là `version` trong `package.json` gốc; `bun run build` đồng bộ sang `plugin.json`, `plugins/omp/package.json` và hai `marketplace.json`).

```bash
claude plugin update agentbridge@agentbridge
omp plugin upgrade agentbridge@agentbridge
```

### Gỡ plugin

```bash
claude plugin uninstall agentbridge@agentbridge
omp plugin uninstall agentbridge@agentbridge
```

Gỡ plugin không tự xóa config/state/runtime trong `~/.agentbridge`; xem §8 nếu muốn xóa dữ liệu.

---

## 3. Cấu hình

AgentBridge dùng một home duy nhất, mặc định là `~/.agentbridge` (`%USERPROFILE%\.agentbridge` trên Windows):

| Đường dẫn | Mặc định | Override riêng |
|---|---|---|
| Config | `~/.agentbridge/config.json` | `AGENTBRIDGE_CONFIG` |
| State (audit) | `~/.agentbridge/state` | `AGENTBRIDGE_STATE_DIR` |
| Runtime (registry, socket) | `~/.agentbridge/run` | `AGENTBRIDGE_RUNTIME_DIR` |

`AGENTBRIDGE_HOME` đổi home và kéo theo cả ba đường dẫn mặc định bên trên. Ba biến override riêng (`AGENTBRIDGE_CONFIG`, `AGENTBRIDGE_STATE_DIR`, `AGENTBRIDGE_RUNTIME_DIR`) **ưu tiên hơn** `AGENTBRIDGE_HOME`. Ví dụ:

```bash
AGENTBRIDGE_HOME=/srv/agentbridge                         # config/state/run nằm dưới /srv/agentbridge
AGENTBRIDGE_CONFIG=/etc/agentbridge/config.json           # chỉ đổi config, state/runtime vẫn theo home
```

Các giá trị XDG (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`) **không còn** tham gia vào đường dẫn mặc định, và AgentBridge **không tự di chuyển** dữ liệu cũ. Nếu vẫn còn thư mục legacy (`${XDG_CONFIG_HOME:-~/.config}/agentbridge`, `${XDG_STATE_HOME:-~/.local/state}/agentbridge`, `$XDG_RUNTIME_DIR/agentbridge`), `ab doctor` sẽ cảnh báo; hãy tự chuyển config/state vào `~/.agentbridge` hoặc đặt `AGENTBRIDGE_HOME` trỏ tới vị trí mới.

Plugin install **không tự tạo** file config. Chạy `/agentbridge allow` trong main OMP TUI để tạo file từ mẫu mặc định và thêm project; nếu không, AgentBridge dùng mặc định an toàn (`projects: []`) và consult sẽ trả `project_not_allowed`. Có thể tạo/sửa `~/.agentbridge/config.json` thủ công (thư mục `~/.agentbridge` nên `0700`, file `0600`). Dev installer cũng tạo file này nếu chưa tồn tại.

Config mẫu (giá trị mặc định; có sẵn file [`config.example.json`](config.example.json) để copy, nhớ sửa `projects` thành `realpath` project của bạn):

```json
{
  "version": 1,
  "projects": [],
  "allowFrom": ["claude-code"],
  "consult": {
    "consent": "ask",
    "consentTimeoutMs": 60000,
    "maxQuestionBytes": 32768,
    "maxAttachmentBytes": 65536,
    "maxContextBytes": 1048576,
    "replyMaxBytes": 32768,
    "maxTokens": 4096,
    "allowUncapped": false,
    "ratePerMinute": 6,
    "toolsOff": true
  },
  "chat": {
    "enabled": false,
    "queueWhenBusy": false,
    "consentTimeoutMs": 120000,
    "autoApprove": "off",
    "autoMaxChars": 2000,
    "autoMaxMessages": 20,
    "autoMinIntervalMs": 10000
  },
  "audit": { "content": false, "maxBytes": 5242880 },
  "ui": { "liveWidget": true, "widgetLines": 6, "widgetHoldMs": 20000 }
}
```

### Quan trọng: `projects` mặc định là `[]`

`projects` là allowlist phía OMP: phiên OMP chỉ nhận consult/chat khi project của nó (`git.worktree`, nếu không có thì `cwd`, đã `realpath`) **trùng khớp chính xác** một entry. Thư mục con **không** được tính (khai báo `/home/you/projects` không cho phép `/home/you/projects/my-app`), và không hỗ trợ wildcard.

File thiếu, không đọc được hoặc không hợp lệ đều dùng **mặc định an toàn** với `projects: []`. Khi đó:

- `consult` trả `project_not_allowed`;
- `chat` trả `denied`;
- `list`/`status` vẫn trả lời (Claude thấy phiên OMP nhưng không gửi được gì).

Muốn dùng, phải thêm **đường dẫn thật** (`realpath`) của từng project vào `projects`:

```json
"projects": ["/home/you/projects/my-app", "/home/you/projects/other-app"]
```

Lý do có allowlist: extension cài ở scope user được nạp vào **mọi** phiên OMP, nên không có danh sách này thì bất kỳ phiên Claude nào cũng có thể hỏi (hoặc, với chat, khiến OMP chạy tool trong) một repo nhạy cảm đang mở OMP.

Config được đọc lại ở mỗi request (cache theo mtime), không cần khởi động lại OMP. Ngoại lệ: `chat.autoApprove` chỉ được snapshot ở `session_start` của phiên main TUI; xem mục Autochat.

### Các trường đáng chú ý

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `consult.consent` | `ask` | `ask`: hỏi mỗi lần; `session`: hỏi lần đầu mỗi phiên OMP; `always`: không hỏi (không khuyến nghị); `deny`: luôn từ chối |
| `consult.maxContextBytes` | 1 MiB | Trần byte cho snapshot phiên OMP gửi sang provider; xem §6 |
| `consult.replyMaxBytes` | 32 KiB | Cắt câu trả lời trả về Claude |
| `consult.maxTokens` | 4096 | Trần output truyền cho transport; `0` = không truyền |
| `consult.allowUncapped` | `false` | Cho phép chạy lại **một lần** không có `maxTokens` nếu transport từ chối |
| `consult.ratePerMinute` | 6 | Token bucket cho consult |
| `consult.toolsOff` | `true` | Truyền `tools: false` cho lượt consult |
| `chat.enabled` | `false` | Bật chế độ chat; chỉ khi bật extension mới quảng bá capability `chat` |
| `chat.queueWhenBusy` | `false` | `true`: khi OMP bận thì xếp tin bằng `deliverAs: "followUp"`; `false`: trả `busy`. Không bao giờ dùng `steer` |
| `chat.consentTimeoutMs` | `120000` | Thời gian chờ hộp xác nhận Gửi/Từ chối cho mỗi tin chat |
| `chat.autoApprove` | `off` | `off`: hỏi từng tin; `limited`: tự chấp nhận trong giới hạn; `unlimited`: tự chấp nhận mọi tin. Chỉ đọc ở `session_start` của main TUI |
| `chat.autoMaxChars` | `2000` | `limited`: trần số code point của một tin được tự chấp nhận; giá trị > 8000 bị kẹp về 8000 |
| `chat.autoMaxMessages` | `20` | `limited`: số tin tự chấp nhận tối đa trong cả phiên OMP; giá trị > 50 bị kẹp về 50 |
| `chat.autoMinIntervalMs` | `10000` | `limited`: khoảng cách tối thiểu giữa hai tin tự chấp nhận; giá trị < 2000 bị kẹp về 2000 |
| `audit.content` | `false` | Không ghi nội dung câu hỏi/câu trả lời vào audit |
| `audit.maxBytes` | 5 MiB | Ngưỡng xoay vòng audit |
| `ui.liveWidget` | `true` | Hiện widget consult realtime trên OMP TUI; `false` giữ hành vi cũ (chỉ status/notify) |
| `ui.widgetLines` | 6 | Số dòng **cuối** của câu trả lời hiển thị trong widget; số nguyên 1..6 để tổng widget không vượt 10 dòng của OMP. Giá trị ngoài khoảng làm config không hợp lệ → dùng mặc định an toàn |
| `ui.widgetHoldMs` | 20000 | Giữ widget kết quả trên màn hình trước khi tự xoá |

---

## 4. Cách dùng

1. Mở OMP trong project:
   ```bash
   cd /path/to/project
   omp
   ```
   Extension AgentBridge ở scope user được nạp tự động. Status bar phải hiện `🔗 bridge`. Nếu project chưa được allow, chạy `/agentbridge allow` trong main OMP TUI (hoặc thêm vào `projects` trong config).

2. Mở Claude Code trong **cùng project** (cùng worktree):
   ```bash
   cd /path/to/project
   claude
   ```

3. Nói với Claude, ví dụ:
   - "hỏi OMP review kiến trúc này"
   - "nhờ OMP giải thích module đang sửa"
   - "hỏi OMP xem phiên của nó đang làm gì"
   - "bảo OMP chạy test và sửa lỗi giúp" (chỉ khi đã bật chat)

### Thử trong một thư mục sandbox (không cài ở scope user)

Có thể thử mà không cài extension/MCP toàn cục: nạp extension bằng `-e` và MCP bằng `--mcp-config` chỉ cho một thư mục. `/path/to/agentbridge` là thư mục đã clone (ví dụ `~/agentbridge`).

```bash
cd /path/to/agentbridge && bun install --frozen-lockfile && bun run build
mkdir -p ~/projects/ab-sandbox/.agentbridge && cd ~/projects/ab-sandbox
cat > .agentbridge/mcp.json <<EOF
{ "mcpServers": { "agentbridge": {
  "command": "$(command -v bun)",
  "args": ["/path/to/agentbridge/plugins/claude/dist/mcp-server.js"]
} } }
EOF
# thêm realpath của ~/projects/ab-sandbox vào "projects" trong ~/.agentbridge/config.json (0600)

omp -e /path/to/agentbridge/plugins/omp/dist/agentbridge.js     # terminal 1
claude --mcp-config .agentbridge/mcp.json                        # terminal 2
```

Nếu OMP mở **không** có `-e`, hoặc Claude mở **không** có `--mcp-config`, Claude sẽ không có tool `agent_*` và có thể dùng cơ chế nhắn tin giữa các phiên Claude của chính nó thay vì gửi tới OMP.

### Luồng gọi

Claude sẽ gọi `agent_list` (nếu cần) rồi `agent_consult` hoặc `agent_chat`. Với consult, lần đầu OMP hiện hộp xác nhận: cho phép một lần, cho phép trong phiên, hoặc từ chối. Từ chối thì Claude nhận `denied` và không được tự thử lại. Với chat, OMP hỏi Gửi/Từ chối cho từng tin, **trừ khi** người dùng đã bật autochat; `/agentbridge trust` của consult không bỏ qua bước này.

AgentBridge chỉ trả kết quả tool bằng `content[].text`; **không** gửi `structuredContent` và không khai báo `outputSchema`. Claude Code 2.1.x ưu tiên `structuredContent` khi có, nên JSON trước đây đã che mất phần text chứa `<<<OMP_REPLY` và dòng cảnh báo "DỮ LIỆU THAM KHẢO". Text là contract duy nhất: `agent_list` in sessionId đầy đủ, model, status, worktree, branch, liveness và consent; `agent_status` in đầy đủ các trường; mọi lỗi bắt đầu bằng `[AgentBridge] <code>`. Với consult, header ghi thêm "đã cắt theo replyMaxBytes" khi `truncated=true`; `capped` không được đưa ra output để tránh hiểu nhầm là reply bị cắt.

Trong chế độ consult:

- OMP **không** sửa file và **không** chạy lệnh;
- file phiên OMP **không đổi byte nào** (GATE G2 đã kiểm tra bằng sha256);
- câu trả lời được đóng khung là dữ liệu từ agent khác.

Có thể đính kèm đoạn code bằng `include_files`; OMP không tự đọc file trong project. `include_files` bị chặn bởi path guard (`.env`, khóa, `.git`, `.ssh`, `.aws`, `.claude`, `.omp`, `node_modules`, symlink ra ngoài, file nhị phân, file > 256 KiB).

### Chế độ chat (opt-in)

Chat **mặc định tắt**. Bật bằng:

```json
"chat": { "enabled": true, "queueWhenBusy": false, "consentTimeoutMs": 120000 }
```

Sau khi bật và mở lại OMP (hoặc chờ heartbeat cập nhật record), Claude có tool `agent_chat { message, target?, timeout_s? }`:

- Tin được bọc nguồn gửi: `[Tin nhắn từ Claude Code (phiên <id>), chuyển qua AgentBridge — không phải người dùng gõ]` rồi mới tới nội dung.
- Tin **đi vào transcript OMP** và OMP trả lời trong cùng phiên; OMP có thể dùng tool, sửa file hoặc chạy lệnh theo quyền của chính nó. Đây là khác biệt cốt lõi so với consult. Tin được gửi với `attribution: "agent"` (nguồn là Claude Code, không phải người dùng gõ).
- **Consent từng tin, xem được toàn văn:** dialog hiển thị `Kích thước: N dòng · M ký tự` của nội dung đã redact/sanitize; nếu phần xem trước bị cắt, ghi thêm `(đã ẩn K ký tự)`.
  - Tin ngắn (vừa snippet) hiện đủ nội dung với hai lựa chọn **Gửi/Từ chối**.
  - Tin dài có thêm **Xem toàn văn**. Nội dung đầy đủ được chia trang, mỗi trang có **Trang sau/Từ chối**; chỉ trang cuối mới có **Gửi/Từ chối**. AgentBridge chọn cách **không hiện Gửi trước trang cuối**, nên người dùng buộc phải xem hết nội dung trước khi gửi.
  - `chat.consentTimeoutMs` là hạn chót chung cho toàn bộ quá trình xem (snippet + mọi trang), không reset theo từng trang. Consent của consult (kể cả `always` hoặc `/agentbridge trust`) **không** áp dụng cho chat. Nếu autochat đang bật và tin nằm trong giới hạn, bước này được bỏ qua; xem mục Autochat.
- Nếu OMP đang bận: mặc định trả `busy`; đặt `queueWhenBusy: true` để gửi nối tiếp bằng `followUp` (không bao giờ `steer`).
- Chỉ một chat chờ trả lời tại một thời điểm; chat thứ hai nhận `busy`.
- Kết quả trả Claude vẫn là text, có header, dòng **DỮ LIỆU THAM KHẢO** và khung `<<<OMP_REPLY … OMP_REPLY>>>`.
- Timeout (`timeout_s`, 10–1800 giây) bao gồm cả thời gian xác nhận và chờ trả lời. Timeout trả `target_exited` với `details.reason="chat_timeout"`; MCP hiển thị: *"OMP có thể vẫn đang chạy lượt này trong phiên; KHÔNG gửi lại tin, hãy hỏi người dùng hoặc dùng agent_status."* Session switch/shutdown hoặc người dùng abort trả `cancelled`.

Tin chat dùng chung trần `consult.maxQuestionBytes` (mặc định 32 KiB); vượt thì trả `too_large`.

Không dùng chat cho câu hỏi nhanh chỉ cần ý kiến: dùng `agent_consult` để OMP không chạy tool và không ghi vào lịch sử.

### Autochat (T12b, opt-in)

Autochat bỏ bước xác nhận Gửi/Từ chối cho chat. Chat vẫn phải bật (`chat.enabled=true`). Bật bằng config:

```json
"chat": {
  "enabled": true,
  "autoApprove": "limited",
  "autoMaxChars": 2000,
  "autoMaxMessages": 20,
  "autoMinIntervalMs": 10000
}
```

Hoặc `"autoApprove": "unlimited"` để tự chấp nhận mọi tin. Mặc định là `"off"`.

**Hai điều kiện bắt buộc:**

1. **Chỉ đọc khi start:** `autoApprove` **và các giới hạn `autoMax*`** được snapshot cùng lúc ở `session_start` của phiên main TUI (hoặc khi lệnh TUI bật limited). Sửa config giữa chừng **không** đổi mode/giới hạn cho tới khi mở lại OMP hoặc chủ động chạy lệnh TUI limited. Các field chat khác (`enabled`, `queueWhenBusy`, `consentTimeoutMs`) vẫn reload như cũ.
2. **Config phải nằm ngoài project:** `realpath` của file config phải **không** nằm trong bất kỳ entry `projects` nào và **không** nằm trong cwd/worktree của phiên OMP. Vi phạm thì autochat bị bỏ qua và có warning:
   `AgentBridge: bỏ qua chat.autoApprove vì config nằm trong project (<path>); chuyển config ra ngoài project`

Ngoài ra file config phải là file thường, quyền **0600**, cùng uid với OMP. Sai quyền/owner cũng bị bỏ qua kèm warning. Kiểm tra và sửa:

```bash
chmod 600 ~/.agentbridge/config.json
```

**Clamp:** giới hạn limited bị kẹp về mức an toàn thay vì làm hỏng cả config:

| Field | Mặc định | Kẹp |
|---|---:|---|
| `autoMaxChars` | 2000 | tối đa 8000 |
| `autoMaxMessages` | 20 | tối đa 50 |
| `autoMinIntervalMs` | 10000 | tối thiểu 2000 |

Giá trị vượt bị kẹp và có **một** warning. Giới hạn đã snapshot không bị nới bởi sửa config giữa phiên.

**`limited`:** chỉ tự chấp nhận khi tin ≤ `autoMaxChars` code point, số tin tự chấp nhận chưa đạt `autoMaxMessages`, và đã qua `autoMinIntervalMs` kể từ tin tự chấp nhận trước. Bộ đếm tính trên **cả phiên OMP**, không có thời hạn mặc định. Vượt giới hạn thì AgentBridge quay về hộp xác nhận thủ công, không từ chối tin.

`/agentbridge autochat limited [phút]` đặt thời hạn tuỳ chọn (mặc định không hạn, tối đa 480 phút, dùng timer của OMP). Lệnh TUI limited **reset quota** (thao tác chủ động của người dùng); chuyển sang unlimited/off hoặc nguồn config/CLI không reset bộ đếm.

Mỗi tin tự gửi có notify ngắn: `AgentBridge: tự gửi tin từ Claude (n/quota)` cho limited hoặc `(n)` cho unlimited. Status bar:

- limited: `🔗 bridge · autochat <used>/<quota>`
- unlimited: `🔗 bridge · autochat ∞ · <n> tin`

Khi bật unlimited (config, CLI hoặc TUI), AgentBridge luôn thêm warning một dòng: `Claude có thể gửi tin và khiến OMP chạy tool không cần duyệt; quyền tool của OMP vẫn áp dụng`.

**Thứ tự ưu tiên:** lệnh TUI > cờ CLI > config.

```bash
omp --agentbridge-autochat=limited
omp --agentbridge-autochat=unlimited
omp --agentbridge-autochat=off
```

Trong OMP:

```text
/agentbridge autochat off
/agentbridge autochat limited
/agentbridge autochat limited 30
/agentbridge autochat unlimited
```

`/agentbridge autochat off` tắt ngay cho phiên hiện tại, kể cả khi CLI/config đang bật. Khi bật từ config, OMP notify ngay lúc start (`AgentBridge: autochat <mode> bật từ config <path>`). Audit event `chat` có field `consent`: `auto-config` (limited) hoặc `auto-config-unlimited`; các nguồn khác dùng `auto-cli…` / `auto-tui…`; xác nhận thủ công là `manual`.

> **Cảnh báo:** autochat **không phải ranh giới an toàn**. Nó chỉ bỏ bước xác nhận chat của AgentBridge. Nếu Claude Code đang chạy ở chế độ **bypass permissions** (hoặc đã được cấp quyền tool rộng), Claude vẫn có thể tự chạy tool/hành động ngoài AgentBridge mà không bị autochat hay config ngoài project chặn. Config ngoài project chỉ chống việc project tự sửa `autoApprove`; nó không chống mã độc trong project hoặc quyền đã cấp cho Claude.

### Hiển thị trên OMP TUI

Sau khi consent xong, extension hiện một widget **display-only** ngay trên editor. OMP 18.14.0 chỉ hiển thị tối đa **10 dòng** cho widget dạng mảng chuỗi (`MAX_WIDGET_LINES = 10` trong `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`; `#createHookWidget` cắt bằng `content.slice(0, 10)` rồi thêm "... (widget truncated)"). Vì vậy bố cục được cố định trong 10 dòng:

1. header `◆ AgentBridge · Claude đang hỏi` kèm caller session — 1 dòng;
2. câu hỏi — tối đa 2 dòng;
3. đường kẻ — 1 dòng;
4. phần trả lời đang stream (chỉ lấy từ delta đã redact) — tối đa `ui.widgetLines` dòng **cuối**; `ui.widgetLines` mặc định là 6 và chỉ nhận giá trị nguyên 1..6, nên tail luôn đủ 6 dòng khi câu hỏi chiếm đủ 2 dòng.

Widget cập nhật theo từng dòng vì `RedactingDeltaStream` là line-buffered: nó chỉ nhả text khi gặp `\n` (hoặc khi buffer vượt ngưỡng và có whitespace), nên dòng đang viết dở có thể chưa hiện; tail luôn là các dòng cuối đã hoàn tất.

Khi xong, header đổi thành `✓ đã trả lời Claude (Xms)` hoặc `✗ <code>`. Widget được giữ `ui.widgetHoldMs` rồi tự xoá; consult mới thay widget cũ. `/agentbridge clear` xoá ngay; `/agentbridge off`, `session_shutdown` và đổi session cũng xoá.

Widget không ghi vào file session, không append message và không đi vào context/LLM của OMP. Toàn bộ text được lọc C0/C1, ANSI escape và bidi control; secret đã được `RedactingDeltaStream` redact trước khi vào widget. Ở RPC/print mode (không có `ctx.ui.setWidget`), tính năng này tự no-op; đặt `ui.liveWidget: false` để tắt hoàn toàn.

---

## 5. CLI `ab`

CLI dùng cùng code client với MCP server, hữu ích để tự kiểm tra mà không cần Claude:

```bash
bun packages/mcp-server/src/cli.ts list [--scope worktree|repo|all] [--json]
bun packages/mcp-server/src/cli.ts status [target]
bun packages/mcp-server/src/cli.ts consult "<câu hỏi>" [--target X] [--file path[:start-end]]... [--no-stream]
bun packages/mcp-server/src/cli.ts chat "<tin nhắn>" [--target X]
bun packages/mcp-server/src/cli.ts doctor
bun packages/mcp-server/src/cli.ts sweep
```

`ab sweep` dọn bản ghi registry/socket của phiên OMP đã chết (pid không còn hoặc khác thời điểm start, cùng uid). Extension cũng tự sweep sau mỗi lần publish record, nên thường không cần chạy tay. Socket mồ côi không có record thì không bị dọn.

`ab consult` tự định danh là `claude-code` với session `cli-<pid>`. Host OMP vẫn áp đầy đủ consent, rate limit và allowlist project; CLI không bỏ qua bước xác nhận. `ab chat` cũng vậy: tin đi vào transcript OMP và cần xác nhận từng lần, trừ khi autochat đang bật.

`ab doctor` in ra ba đường dẫn đang dùng (config file, state dir, runtime dir), rồi kiểm tra: phiên bản Bun, `claude`, `omp`, quyền thư mục runtime/sessions, config, extension đã cài, MCP đã đăng ký (user/local/project). Nó cũng phát hiện **Claude plugin** (MCP server do plugin cung cấp) và **OMP plugin** (extension cài qua `omp plugin`), cảnh báo **trùng cách cài** (dev extension + OMP plugin, manual MCP + Claude plugin), `.omp/extensions/*agentbridge*` ở cấp project, và thư mục legacy XDG (`~/.config/agentbridge`, `~/.local/state/agentbridge`, `$XDG_RUNTIME_DIR/agentbridge`) — các thư mục legacy không còn được dùng và không được tự di chuyển.

---

## 6. Bảo mật và quyền riêng tư

Đọc kỹ phần này trước khi dùng với code thật.

### 6.1 Dữ liệu gửi tới provider của OMP

- **Mỗi consult gửi một snapshot phiên OMP tới provider mà OMP đang dùng.** Đây không phải chỉ câu hỏi: OMP dùng context phiên của nó để trả lời. GATE đã đo `usage.input` khoảng **10,7k token** cho một consult ngắn.
- `consult.maxContextBytes` mặc định là **1 MiB**, tức khoảng **250k token** với phiên dài (ước lượng ~4 byte/token; con số thật phụ thuộc tokenizer của model). Nên hạ xuống nếu phiên của bạn chứa code hoặc dữ liệu nhạy cảm:

  ```json
  "consult": { "maxContextBytes": 131072 }
  ```

  `131072` byte ≈ 32k token; `65536` ≈ 16k token. Đây vẫn là ước lượng theo byte, không phải đếm token chính xác. Cấu hình có hiệu lực ở request kế tiếp, không cần khởi động lại OMP.

- Nội dung `include_files` cũng được gửi tới provider đó. Redactor chỉ là **best-effort** cho một số mẫu credential; không đảm bảo phát hiện mọi bí mật. Không đính kèm hoặc hỏi về bí mật.
- **Chat ghi tin vào lịch sử phiên OMP**, nên tin nhắn trở thành một phần context được gửi tới provider OMP trong các lượt sau, không chỉ trong lượt hiện tại. OMP cũng có thể chạy tool, sửa file hoặc gọi lệnh theo quyền của nó.
- Provider của OMP có thể lưu log/theo chính sách riêng của provider đó, ngoài tầm kiểm soát của AgentBridge.

### 6.2 Dữ liệu đi vào Claude và Anthropic

- **Câu trả lời của OMP đi vào context của Claude, và từ đó tới Anthropic** theo chính sách của Claude Code. Bất cứ nội dung nào Claude nhìn thấy đều có thể được gửi tới Anthropic trong các lượt sau. Điều này áp dụng cho cả consult và chat.
- Đừng yêu cầu OMP trả lời bằng nội dung mà bạn không muốn xuất hiện trong transcript Claude.
- Claude được dặn coi câu trả lời là dữ liệu tham khảo, không phải chỉ thị. Đây là biện pháp giảm prompt injection, không phải bảo đảm tuyệt đối.

### 6.3 Ranh giới cục bộ

- IPC chỉ dùng Unix domain socket trong thư mục runtime 0700; socket 0600; mỗi phiên có token riêng. **Không** mở TCP, không bind cổng mạng.
- Registry và audit nằm ngoài repo; audit mặc định chỉ ghi metadata (không nội dung câu hỏi/câu trả lời), file 0600, xoay vòng theo `audit.maxBytes`. Chat ghi event `chat` kèm `consent` (`manual`, `auto-config`, `auto-config-unlimited`, `auto-cli…`, `auto-tui…`); nếu `audit.content=true` thì nội dung được redact trước khi ghi. State mặc định: `~/.agentbridge/state/`; runtime (registry, socket) mặc định: `~/.agentbridge/run/`.
- User khác không đọc được thư mục runtime. Cùng một user thì mọi tiến trình đều có thể đọc — AgentBridge không sandbox tiến trình cùng user.
- Chỉ spawn `claude agents --json` để định danh phiên Claude. Không đọc transcript, file phiên hay file credential.

### 6.4 Repo không đáng tin

OMP nạp `.omp/extensions/*` trong project **mà không hỏi**. Một repo độc hại có thể đặt extension giả tên `agentbridge`. Vì vậy:

- chỉ cài extension AgentBridge ở scope user;
- chạy `ab doctor` trong repo lạ; nếu thấy cảnh báo `extension cấp project`, xóa các file `.omp/extensions/*agentbridge*` trước khi mở OMP;
- MCP server cũng nên đăng ký ở scope user, không dựa vào `.mcp.json` của repo.

---

## 7. Giới hạn đã biết

- **G5 — trần `maxTokens` CHƯA được xác minh trên provider thật.** GATE chỉ cho thấy một transport (OpenAI-compatible) **chấp nhận** option `maxTokens=1024`; câu trả lời chỉ có 62 output token nên chưa chạm trần. Chưa chứng minh provider cắt đúng giới hạn. Đừng dựa vào `maxTokens` để kiểm soát chi phí; `replyMaxBytes` chỉ cắt phần trả về Claude, không cắt phần provider đã sinh.
- **Đường dẫn Unix socket tối đa 100 byte UTF-8.** Vượt giới hạn thì AgentBridge từ chối endpoint kèm lỗi gợi ý đặt `AGENTBRIDGE_RUNTIME_DIR` ngắn hơn. Home directory dài có thể cần override runtime dir.
- MCP SDK đang dùng là `@modelcontextprotocol/sdk` **1.32.1**, hỗ trợ protocol tới **2025-11-25**. AgentBridge **không** dùng `claude/channel`, không khai báo capability channel, không dùng push.
- **Thông báo tiến độ cuối có thể bị client bỏ qua** (chỉ ảnh hưởng hiển thị). Kết quả cuối vẫn nằm trong response của tool; delta/progress không phải nguồn dữ liệu đáng tin để ghép câu trả lời.
- **`projects` mặc định là `[]`**, nên phải thêm project vào config thì consult mới chạy. Nếu quên, lỗi là `project_not_allowed`, không phải lỗi kết nối.
- Một consult tại một thời điểm cho mỗi phiên OMP (`CONSULT_CONCURRENCY = 1`); request thứ hai nhận `busy_limit`.
- Chat **mặc định tắt** (`chat.enabled=false`) và chỉ một chat chờ trả lời tại một thời điểm; chat thứ hai nhận `busy`. Khi OMP bận, mặc định `busy`; bật `chat.queueWhenBusy` để xếp `followUp`.
- Autochat **mặc định tắt**. `autoApprove` và các giới hạn `autoMax*` chỉ được snapshot ở `session_start` của main TUI (hoặc lệnh TUI limited); sửa config giữa phiên không nới được giới hạn. Mode từ config chỉ được chấp nhận khi file config ngoài project/cwd/worktree, 0600 và cùng uid. Giới hạn `limited` tính trên cả phiên OMP; vượt giới hạn thì quay về consent thủ công. Lệnh TUI limited có thể đặt thời hạn tối đa 480 phút.
- Autochat **không chặn** Claude Code đang chạy bypass permissions; nó chỉ bỏ bước xác nhận chat của AgentBridge.
- Chat cần OMP có `pi.sendUserMessage`; extension feature-detect và trả `unsupported_capability` nếu thiếu. OMP không cam kết event `agent_end`/`message_update` ổn định giữa các bản.
- Timeout của chat bao gồm consent và chờ trả lời; một tin bị timeout có thể vẫn đang được OMP xử lý.
- OMP không cam kết API ổn định. Extension feature-detect và trả `unsupported_capability` nếu thiếu `runEphemeralTurn`, nhưng bản OMP mới vẫn có thể làm hỏng.
- Chưa hỗ trợ Windows; chưa hỗ trợ nhiều máy; chưa có delegation hay inbox tự động.

---

## 8. Gỡ cài đặt (dev mode)

Phần này chỉ dành cho **dev mode**. Gỡ plugin bằng `claude plugin uninstall` / `omp plugin uninstall` ở §2.

Xem trước:

```bash
bun scripts/install.ts --uninstall
```

Thực hiện (hỏi `y/n` từng bước):

```bash
bun scripts/install.ts --uninstall --apply
```

Script sẽ:

1. xóa `~/.omp/agent/extensions/agentbridge.js`;
2. chạy `claude mcp remove -s user agentbridge`;
3. **giữ nguyên** config và audit log, trừ khi bạn đồng ý xóa ở bước tùy chọn tương ứng (mặc định là giữ). Khi config/audit nằm trong `~/.agentbridge` (mặc định), bước xóa thư mục home thay thế các bước riêng lẻ này để tránh xóa trùng;
4. hỏi trước khi xóa `~/.agentbridge` (bước tùy chọn, mặc định **giữ**). Đồng ý thì toàn bộ config, state và runtime trong thư mục đó bị xóa; từ chối thì dữ liệu vẫn còn. Nếu `AGENTBRIDGE_HOME` trỏ tới thư mục khác, script hỏi xóa đúng thư mục đó.

Dry-run (`bun scripts/install.ts --uninstall`) hiển thị bước xóa home là tùy chọn, không đụng tới file nào. Script không xóa extension, đăng ký MCP hay dữ liệu nào khi bạn chưa xác nhận.

Lệnh thủ công tương đương:

```bash
rm -f ~/.omp/agent/extensions/agentbridge.js
claude mcp remove -s user agentbridge
# chỉ khi muốn xóa toàn bộ dữ liệu AgentBridge:
rm -rf ~/.agentbridge
# cuối cùng, xoá source đã clone:
rm -rf ~/agentbridge
```

---

## 9. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| OMP không hiện `🔗 bridge` | OMP plugin chưa cài/bật hoặc OMP chưa khởi động lại | `omp plugin list`; cài lại `omp plugin install agentbridge@agentbridge`; mở lại OMP |
| Claude không thấy tool AgentBridge | Claude plugin chưa cài/bật hoặc Claude chưa nạp lại | `claude plugin list`, `claude mcp list`; cài lại `claude plugin install agentbridge@agentbridge`; mở phiên Claude mới |
| OMP log `[AgentBridge] unsupported_caller` | OMP provider `claude-plugins` đã nạp `.mcp.json` của Claude plugin; startup guard thấy tiến trình `omp` trong ancestor chain | Không phải lỗi cài đặt: MCP server đăng ký không tool nào. Nếu không muốn OMP nạp MCP từ Claude plugin, đừng bật provider `claude-plugins`/`claude` cho `~/.claude` |
| `no_target` | Không có phiên OMP cùng worktree, hoặc extension không chạy | Mở OMP đúng thư mục; kiểm tra status bar; `ab list --scope repo` |
| OMP báo `Đường dẫn socket quá dài` (hoặc bridge không lên) | Path Unix socket vượt 100 byte UTF-8, thường do home/runtime dir quá dài | Đặt `AGENTBRIDGE_RUNTIME_DIR` ngắn, ví dụ `/tmp/ab-$(id -u)`, rồi mở lại OMP và chạy `ab doctor` |
| `project_not_allowed` (consult) / `denied` (chat) | `projects` chưa chứa đúng thư mục gốc project (thư mục con không tính) | Chạy `/agentbridge allow` trong main OMP TUI, hoặc thêm `realpath` của worktree/cwd của OMP vào `~/.agentbridge/config.json` |
| Claude dùng nhắn tin giữa các phiên Claude thay vì gửi tới OMP | Claude không có MCP AgentBridge hoặc OMP không nạp extension | Kiểm tra `claude mcp list` / `--mcp-config`, status bar `🔗 bridge`; xem §4 sandbox |
| `ambiguous_target` | Có nhiều phiên OMP cùng worktree | `ab list`, rồi gọi lại với `target` là sessionId đầy đủ hoặc tiền tố ≥ 8 ký tự |
| `max_tokens_unsupported` | Transport từ chối `maxTokens` | Đổi model/transport, hoặc bật `consult.allowUncapped` nếu chấp nhận lượt không có trần |
| `consent_timeout` | Không trả lời hộp xác nhận trong thời hạn | Trả lời trong OMP; hoặc tăng `consult.consentTimeoutMs` / `chat.consentTimeoutMs` |
| `unauthorized` / `identity_mismatch` | OMP đã khởi động lại hoặc đổi phiên | Chạy lại `agent_list`; không tự động thử lại |
| `busy_limit` / `rate_limited` | Đang có consult khác hoặc vượt 6 consult/phút | Đợi rồi thử lại khi người dùng đồng ý |
| `chat_disabled` | `chat.enabled` đang `false` | Hỏi người dùng có muốn bật chat trong config không; không tự sửa config |
| `busy` | OMP đang bận hoặc đã có chat khác chờ | Đợi lượt hiện tại; chỉ bật `chat.queueWhenBusy` nếu người dùng đồng ý |
| Doctor báo `extension cấp project` | Repo có `.omp/extensions/*agentbridge*` | Xóa file đó; chỉ dùng bản ở `~/.omp/agent/extensions/` |
| Doctor báo `trùng cách cài AgentBridge` | Cài cả plugin lẫn dev extension/MCP thủ công | Gỡ một bên: `bun scripts/install.ts --uninstall` hoặc `claude mcp remove -s user agentbridge`, `omp plugin uninstall agentbridge@agentbridge` |
| Doctor báo `thư mục legacy XDG` | Còn `~/.config/agentbridge`, `~/.local/state/agentbridge` hoặc `$XDG_RUNTIME_DIR/agentbridge` từ bản cũ | Tự chuyển config/state vào `~/.agentbridge` (hoặc đặt `AGENTBRIDGE_HOME`) rồi xóa thư mục cũ; AgentBridge không tự di chuyển |

Log của MCP server đi ra **stderr**, không bao giờ ra stdout (stdout dành cho giao thức MCP). Đặt `AGENTBRIDGE_LOG=/path/to/log` để ghi ra file.

---

## 10. Phát triển

### Dev mode (clone + installer)

Chỉ dùng khi phát triển AgentBridge. Người dùng cuối cài plugin ở §2.

```bash
# Clone và build (không clone vào ~/.agentbridge)
git clone https://github.com/tuna1999/agentbridge.git ~/agentbridge
cd ~/agentbridge
bun install --frozen-lockfile
bun run build

# Xem trước (không ghi gì), rồi cài thật (hỏi y/n từng bước)
bun scripts/install.ts
bun scripts/install.ts --apply
```

`bun run build` tạo hai bundle một file và sinh lại manifest plugin:

- `plugins/claude/dist/mcp-server.js` (MCP server cho Claude plugin);
- `plugins/omp/dist/agentbridge.js` (extension OMP).

Build từ chối import ngoài `node:*`/Bun built-in và đường dẫn tuyệt đối của máy build, rồi in kích thước bundle. `bun run build --check` rebuild vào thư mục tạm và so sánh với file đã commit mà không sửa working tree.

Dev installer (`scripts/install.ts`) là **dev mode**, tách biệt với plugin install:

| Bước | Việc làm |
|---|---|
| 1 | Copy `plugins/omp/dist/agentbridge.js` → `~/.omp/agent/extensions/agentbridge.js` (0600) |
| 2 | Chạy `claude mcp add -s user agentbridge -- <bun tuyệt đối> <repo>/plugins/claude/dist/mcp-server.js` |
| 3 | Tạo `~/.agentbridge/config.json` nếu chưa có, với `projects: []` |

Thư mục `~/.agentbridge` được tạo với quyền `0700`, config `0600`; config đã tồn tại **không bị ghi đè**. Đổi home bằng `AGENTBRIDGE_HOME`; installer tạo `<AGENTBRIDGE_HOME>/config.json`.

Cập nhật dev mode:

```bash
cd ~/agentbridge
git pull
bun install --frozen-lockfile
bun run build
bun scripts/install.ts --apply
```

Mở lại OMP để nạp bundle mới. MCP server là bundle single-file, nên Claude Code chỉ cần mở phiên mới.

`ab doctor` (chạy từ bản clone: `bun packages/mcp-server/src/cli.ts doctor`) nhận diện cả plugin lẫn dev mode và **cảnh báo trùng cách cài** nếu bạn vừa cài dev extension/manual MCP vừa cài plugin. Gỡ dev mode bằng `bun scripts/install.ts --uninstall [--apply]` (xem §8).

### Kiểm tra

```bash
bun test
bun run typecheck
bun run build
```

- Đặc tả: `docs/plan/01-design-spec.md`
- Task và thứ tự: `docs/plan/02-tasks.md`, `docs/plan/00-overview.md`
- Kết quả GATE: `spike/RESULTS.md`
- Mẫu biên bản E2E: `docs/plan/E2E-RESULTS.md` (người dùng điền sau khi chạy theo `docs/plan/00-overview.md` §7)

Cấu trúc:

```text
packages/protocol/       schema, framing, redactor, path guard, matching
packages/core/           dirs, config, registry, proc, git, audit, IPC
packages/omp-extension/  extension OMP; bundle một file
packages/mcp-server/     MCP server stdio + CLI ab
plugins/claude/          Claude plugin: manifest + .mcp.json + dist/mcp-server.js
plugins/omp/             OMP plugin: package.json (omp manifest) + dist/agentbridge.js
scripts/                 build/audit plugin bundles, dev installer
```

---

## Giấy phép

AgentBridge phát hành theo [Apache License 2.0](LICENSE). Bạn được dùng, sửa và phân phối lại (kể cả thương mại), với điều kiện:

- giữ nguyên file `LICENSE` và `NOTICE` (ghi công tác giả gốc) trong bản phân phối lại hoặc bản phái sinh;
- ghi rõ trong các file đã sửa rằng chúng đã bị thay đổi.

Copyright 2026 tuna1999.
