# T0 — Kết quả GATE

Người chạy: người dùng, phiên OMP riêng trong `/tmp/ab-e2`. Extension nạp bằng `omp -e`; không
nạp vào phiên làm việc của repo. Log thô: `/tmp/ab-poc/poc.log` (JSONL).

## Môi trường

| Mục | Giá trị |
|---|---|
| Ngày chạy | 2026-10-31 (giờ local, log UTC 2026-10-30 17:18–17:31) |
| `omp --version` | 18.14.0 |
| Bun | 1.4.4 |
| Runtime dir | `/tmp/ab-poc` |
| Model G1–G4 | `vcspentest/deepseek-v4.1-flash` |
| Model G5 | `nice-router/glm-5.3` |
| sessionId G1–G4 | `01a18dd3-7bdd-71ef-9ea9-1312bd62b611` |
| sessionFile G1–G4 | `~/.omp/agent/sessions/-tmp-ab-e2/2026-10-30T17-20-09-693Z_01a18dd3-7bdd-71ef-9ea9-1312bd62b611.jsonl` |
| sessionId G5 | `01a18dda-6619-77e8-b788-100d1933ba4d` |
| Transport | OpenAI-compatible (`vcspentest`, `nice-router`) |

## Kết quả GATE

| Gate | Kết quả | Bằng chứng |
|---|---|---|
| G1 — `replyText` từ callback socket | **Pass** | `replyText` 745 byte, 82 delta chunk, `usage.output=328`, không có `consult_error`; `consult_start`/`consult_done` cùng requestId `04b30b4b-…` |
| G2 — file phiên không đổi | **Pass** | sha256 `52fcfee7a3b46e0a0b9fd8937cdae16f9cee9d3b6c51a8fe3e39dda7d35a33e5` trước và sau; 16 dòng cả hai lần |
| G3 — consult khi OMP bận | **Pass (có ghi chú)** | `consult_start.idle=false`, `consult_consent.idle=false`; chỉ 2 `agent_start`/2 `agent_end` trong log; lượt chính 49,3 s; không có steer |
| G4a — confirm khi idle | **Pass** | `consult_consent.decision="allow"`, `idle=true` |
| G4b — confirm khi đang chạy | **Pass** | confirm hiện và trả kết quả với `idle=false` (17:26:10) |
| G4 — từ chối | **Pass** | `decision="deny"` → `consult_error.code="denied"`; client in `[server:denied]` |
| G5 — `maxTokens` | **Ghi nhận: được chấp nhận** | `consult_start.maxTokens=1024` và `consult_done.maxTokens=1024`; không có `max_tokens_unsupported` |

## Ghi chú

### G3 — thời điểm

```text
17:25:27.820  agent_start (main)              idle=false
17:25:43.821  consult_start                   idle=false
17:26:10.130  consult_consent allow           idle=false
17:26:17.109  agent_end (main)                willContinue=false
17:26:21.347  consult_done (side)             37,5 s kể từ request
```

- Side turn chạy song song thật: reply mô tả tool `bash` (`sleep 45`) đang chạy với
  *"No result provided"*, tức snapshot được chụp khi tool chưa xong. Nếu bị xếp sau lượt chính,
  snapshot đã có tool result.
- Lượt chính không bị chèn: không có `agent_start` thứ hai, thời lượng 49,3 s khớp approve +
  `sleep 45` + model, `agent_end` có `willContinue=false`.
- **Kết quả consult về sau `agent_end` 4,2 s.** Không phải fail, nhưng T7 cần biết: câu trả lời có
  thể dựa trên trạng thái dở dang của lượt chính.

### Khác

- Delta streaming hoạt động: 82 chunk (G1), 97 chunk (G3), 7 chunk (G5); `deltaBytes` khớp `replyLen`.
- Đổi model giữa phiên: `host_started` ghi `nice-router/glm-5.3`, `status`/`consult` sau đó trả
  `vcspentest/deepseek-v4.1-flash`; `runEphemeralTurn` dùng model hiện tại. Bằng chứng một phần cho E4.
- Consult ngắn nhưng `usage.input` ≈ 10,7k token (G5) → toàn bộ snapshot phiên được gửi tới provider.
- Không có lỗi ngoài lần từ chối có chủ đích; không có exception nào thoát ra event loop OMP.
- Exit code của lần từ chối không được chụp; client in `[server:denied]` (nhánh code trả `2`).

### Chưa kiểm

- G5 với transport `vcspentest/deepseek`: chỉ test `maxTokens` trên `nice-router/glm-5.3`.
  Câu trả lời 62 output token, chưa chạm ngưỡng 1024 → mới chứng minh option được chấp nhận,
  chưa chứng minh cap được áp khi chạm trần.
