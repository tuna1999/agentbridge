# SOURCES — Chỉ mục bằng chứng

Ngày truy cập: **2026-10-30** cho mọi mục. Độ tin cậy gồm: Confirmed / Partially / Unverified.
Mã nguồn OMP được đọc tại tag `v18.13.3` = `413d278a87a69b453efabf8d1fedb9940385e8c6`. Khi so sánh với `main` thì dùng `338d2ce6658dfdbfba19efe0f006f0d5a8edd66d`. `CA/` = `packages/coding-agent/src/`.

## L — Quan sát trực tiếp trên máy (chỉ đọc)
| Nguồn | Phát hiện | Độ tin cậy |
|---|---|---|
| `claude --version` → 2.1.314; `omp --version` → 18.13.3; `bun` 1.4.4; `node` v26.12.1 | Phiên bản môi trường | Confirmed |
| `claude agents --json` | Trả `pid, cwd, kind, startedAt, sessionId, name, status` của phiên sống; bỏ qua socket stale | Confirmed |
| `ls /run/user/1000/cc-socks/` | `3105669.sock` còn sót lại sau khi tiến trình đã chết | Confirmed |
| `~/.claude/sessions/<pid>.json` (chỉ xem tên field, không đọc `.key`) | Có `peerProtocol`, `peerFeatures`, `messagingSocketPath`, `status`, nhưng không có tài liệu về các field này | Confirmed (nội bộ) |
| `omp collab list --json` | `{"version":1,"hosts":[]}` trong khi có 2 phiên OMP đang chạy | Confirmed |
| `~/.omp/run/daemons/<hash>/{scope.json, clients/*.json, broker.*}` | Broker theo project, lưu metadata client `{pid, id, projectDir}` | Confirmed |
| `~/.omp/agent/extensions/herdr-omp-agent-state.ts` | Prior art: extension dùng `pi.on(...)`, `ctx.isIdle()`, `ctx.sessionManager.getSessionId()` và client `node:net` | Confirmed |
| `omp --help` | Có `-e/--extension`, `--no-extensions`, `--mode text\|json\|rpc\|rpc-ui`, `acp`, `collab` | Confirmed |

## A — Claude Code (https://code.claude.com/docs/en/…)
| URL | Mục | Phát hiện | Độ tin cậy |
|---|---|---|---|
| /hooks | Common input fields; từng event | Các trường chung; model chỉ có ở SessionStart và Pre/PostModelSwitch (≥2.1.251); UserPromptSubmit cũng chạy với tin peer | Confirmed |
| /statusline | Available data | `model.id`, `session_id`, trigger | Confirmed |
| /env-vars | | `CLAUDE_CODE_SESSION_ID` (MCP giữ ID lúc spawn), `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`, `MCP_TIMEOUT`, `MAX_MCP_OUTPUT_TOKENS`, không có `$CLAUDE_MODEL` | Confirmed |
| /cli-reference | `--fork-session` | `--resume`/`--continue` giữ session ID | Confirmed |
| /sessions, /claude-directory | | Vị trí transcript, transcript không mã hóa; `sessions/` dùng để phát hiện phiên đồng thời và crash | Confirmed |
| /agent-view | List sessions as JSON | `claude agents --json` là cách chính thức để đọc trạng thái phiên (≥2.1.145) | Confirmed |
| /mcp | scopes, approvals, time limits, auto-background (2 phút), output limits, elicitation, MCP tasks, runtimes | Xem 02 §3 | Confirmed |
| /permissions | MCP rules | `mcp__server__tool` | Confirmed |
| /channels, /channels-reference | toàn trang | Research preview (≥2.1.80); dev flag; allowlist; `notifications/claude/channel`; không ACK; xếp hàng khi bận; API key được hỗ trợ từ 2.1.128; dev flag bị bỏ qua với `-p`; lỗi đăng ký khi dùng protocol 2026-07-28 | Confirmed |
| /cross-session-messaging | toàn trang | ListAgents/SendMessage (≥2.1.224, Windows ≥2.1.234); inbox socket; inbound controls; giới hạn; peer không thể cấp consent; format frame không công bố | Confirmed |
| /plugins/mods/api | | `$.session.send`, `$.prompt.submit`, `$.ui.notify` | Confirmed (tồn tại) |
| /agent-teams | | Thử nghiệm, chỉ Claude | Confirmed |
| /headless, /authentication | | `--bare` không dùng subscription; `setup-token` | Confirmed |
| /agent-sdk/overview | | Bên thứ ba không được cung cấp claude.ai login | Confirmed |
| /legal-and-compliance | Authentication and credential use; Acceptable use | OAuth dành cho "ordinary use"; developer dùng API key; không trung gian credential | Confirmed |
| /changelog | 2.1.80, .81, .83, .84, .126, .128, .145, .224, .234, .236, .251, .290, .314 | Mốc phiên bản | Confirmed |
| https://www.anthropic.com/legal/consumer-terms | §2, §3(7) | Cấm truy cập tự động trừ khi qua API key hoặc được cho phép rõ ràng | Confirmed (qua bản fetch) |
| https://www.anthropic.com/legal/aup | Do Not Abuse Our Platform | Cấm định tuyến qua subscription; ngày hiệu lực bất thường (12/11/2026) | Confirmed + bất thường |
| https://www.anthropic.com/legal/commercial-terms | A.1, D.4 | Điều khoản dùng API | Confirmed |
| https://support.claude.com/en/articles/15036540 | 07/10/2026 | Agent SDK và `claude -p` dùng hạn mức subscription | Partially (trang động) |

## B — OMP (https://github.com/can1357/oh-my-pi @ 413d278a)
| Đường dẫn | Symbol | Phát hiện | Độ tin cậy |
|---|---|---|---|
| CA/extensibility/extensions/types.ts:680-831 | `ExtensionContext` | Bề mặt `ctx`; `runEphemeralTurn?` :764; `isIdle` :706; `isProjectTrusted` luôn true :747 | Confirmed |
| CA/extensibility/extensions/types.ts:317-361 | `ExtensionUIContext` | `select`, `confirm` :324, `input`, `notify` :349, `setStatus` :355, `setWidget` :361 | Confirmed |
| CA/extensibility/extensions/types.ts:1703-2045, :1547 | `ExtensionAPI`, `ExtensionEvent` | `on`, `register*`, `sendMessage` :1941, `sendUserMessage` :1949; không có event model | Confirmed |
| CA/extensibility/shared-events.ts:30-235 | Session/Agent/Turn events | `agent_end{messages, willContinue}` | Confirmed |
| CA/session/agent-session-types.ts:513, 622-651 | `SendUserMessageOptions`, `EphemeralTurnOptions/Result` | Kiểu dữ liệu chính xác | Confirmed |
| CA/session/agent-session.ts:10230 | `sendUserMessage` | Định tuyến idle/busy; trả void; lưu vào transcript | Confirmed |
| CA/session/agent-session.ts:12598, 12611, 12809 | `runEphemeralTurn`, `#buildEphemeralSnapshot` | Dùng model hiện tại; ném lỗi khi đổi model; snapshot có nội dung đang stream; tool bị loại; không lưu | Confirmed |
| CA/session/agent-session.ts:850-866 | `ephemeralMaxTokensRejection` | Từ chối `maxTokens` khi transport không giữ được output limit | Confirmed |
| packages/catalog/src/compat/output-limits.ts | `supportsOutputTokenLimit` | Chính sách theo catalog | Confirmed |
| CA/session/agent-session.ts:12183 | comment trong `setModel` | `model_changed` không được expose cho extension | Confirmed |
| CA/extensibility/extensions/runner.ts:133, 157, 1467-1540 | timeouts, `createContext` | 30 s / 2 s; chặn đệ quy; gộp signal | Confirmed |
| CA/extensibility/extensions/loader.ts:64, 420, 453, 582-605 | loader | Thứ tự nạp; dedup theo realpath (lệch với docs) | Confirmed |
| CA/discovery/builtin.ts:61, 494 | `getConfigDirs` | Project trước, user sau; bỏ qua khi cwd = home | Confirmed |
| CA/extensibility/plugins/legacy-pi-compat.ts:814-825 | package rewrite | Extension dùng được `@oh-my-pi/pi-natives` | Partially |
| CA/modes/runtime-init.ts:107, 143, 149; CA/modes/controllers/extension-ui-controller.ts:247, 258, 354, 1461 | wiring | API có ở TUI và headless | Confirmed |
| CA/main.ts:2766-2776; CA/modes/rpc/rpc-mode.ts:1387; docs/rpc.md | RPC | Tạo phiên mới; chỉ stdio | Confirmed |
| CA/session/session-storage.ts:1300; session-manager.ts:~1279 | `claimSession`, `#moveOffSessionFile` | Lease ghi đơn → tách sang file mới | Confirmed |
| CA/session/session-paths.ts:46-120; session-manager.ts:144, 2079; session-entries.ts:41, 341 | lưu trữ | Encode cwd (mất thông tin), UUIDv7, JSONL v3 | Confirmed |
| packages/utils/src/dirs.ts:998, 1121-1131; CA/launch/{broker,paths,presence,protocol}.ts | broker | Giám sát tiến trình; không có thao tác phiên | Confirmed |
| CA/collab/registry.ts:162, 417; docs/collab.md | Collab | Remote prompt qua relay | Confirmed |
| CA/irc/bus.ts | `IrcBus` | Chỉ trong tiến trình | Confirmed |
| docs/extensions.md:381-407 | Ephemeral side turns | Ví dụ bridge; yêu cầu consent, auth, audit | Confirmed |
| docs/extensions.md:600-620 | `mcp_notification` | Đường MCP push → `sendUserMessage` | Confirmed |
| crates/pi-natives/src/ipc/mod.rs:141-158 | `ipcEndpoint` | Đặt tên UDS / named pipe | Confirmed |
| packages/coding-agent/CHANGELOG.md:628-630 | Breaking Changes | Extension API từng bị phá vỡ | Confirmed |
| `git diff v18.13.3..338d2ce6` | | Chỉ thay đổi bổ sung | Confirmed |

## C — Giải pháp hiện có
| URL | Phiên bản / commit | Phát hiện | Độ tin cậy |
|---|---|---|---|
| https://github.com/Dicklesworthstone/mcp_agent_mail | 426d4f3 (2026-10-26) | Đã bị thay thế; hộp thư kéo; reservation; rider license | Confirmed |
| https://github.com/Dicklesworthstone/mcp_agent_mail_rust | 6bbadb7 (2026-10-29) | Windows; thiết lập OMP; cùng rider | Confirmed |
| https://github.com/ogulcancelik/herdr | v0.9.5, ee5bfb5 | `agent.prompt` gõ PTY; hook OMP chỉ báo trạng thái; Apache-2.0 | Confirmed |
| https://github.com/nicobailon/pi-intercom | v0.18.1, 4b387e8 | Nhắn tin trực tiếp cho Pi; MIT | Confirmed |
| https://github.com/dataforxyz/agent-intercom-pi / -claude | 62ba698 / 7de76e5 | Cross-harness; AGPL; bridge socket native `msgV:1` (không chính thức) | Confirmed (đọc code) |
| https://github.com/nicobailon/pi-messenger | a704e72 | Reservation dựa trên file; MIT | Confirmed |
| https://github.com/getpaseo/paseo | e299b21 | Spawn agent mới; Apache-2.0 | Confirmed |
| https://github.com/aaronn/claude-channel-cli | 851c4c5 | Channel; phải khởi động qua wrapper | Confirmed |
| https://github.com/umairulh2001/aiAgentBridge | 24a68f3 | Hub Python + channel | Confirmed |
| https://github.com/rennerdo30/agent-bridge | e09a819 | Broker cross-CLI, không có Pi/OMP | Confirmed |
| https://github.com/smtg-ai/claude-squad · asheshgoplani/agent-deck · kbwo/ccmanager | ce1ffb4 · 967e2fa · b0948dd | Spawn phiên mới | Confirmed |
| https://github.com/BeehiveInnovations/pal-mcp-server | 7afc7c1 (2025-12-15) | Dùng API key; không còn được cập nhật | Confirmed |
| https://github.com/a2aproject/A2A | d924e07 | CC/OMP không hỗ trợ native | Partially |
| https://code.claude.com/docs/en/agent-teams | | Chỉ dành cho Claude | Confirmed |
