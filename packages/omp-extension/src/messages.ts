/** User-facing strings for the OMP extension (00 §4 rule 8). */

/** Shared by the consult and chat consent dialogs (01 §7.4 step 7, §7.4b step 8). */
export const CONSENT_TEXT = {
	viewFull: "Xem toàn văn",
	nextPage: "Trang sau",
	page: (index: number, total: number) => `Trang ${index}/${total}`,
	size: (lines: number, chars: number, hidden: number) =>
		`Kích thước: ${lines} dòng · ${chars} ký tự${hidden > 0 ? ` (đã ẩn ${hidden} ký tự)` : ""}`,
} as const;

export const CONSULT_TEXT = {
	consentTitle: "AgentBridge: Claude Code muốn hỏi ý kiến",
	allowOnce: "Cho phép lần này",
	allowSession: "Cho phép trong phiên này",
	deny: "Từ chối",
	attachmentsLine: (count: number, callerSession: string) =>
		`Đính kèm: ${count} · caller session: ${callerSession}`,
	attachmentItem: (location: string) => `  • ${location}`,
	answered: (durationMs: number) => `AgentBridge: đã trả lời Claude (${durationMs}ms)`,
	widgetHeader: (caller: string) => `◆ AgentBridge · Claude đang hỏi · ${caller}`,
	widgetDone: (durationMs: number) => `✓ đã trả lời Claude (${durationMs}ms)`,
	widgetFailed: (code: string) => `✗ ${code}`,
} as const;

export const CHAT_TEXT = {
	consentTitle: "AgentBridge: Claude Code muốn gửi tin vào phiên OMP",
	send: "Gửi",
	deny: "Từ chối",
	caller: (agent: string, sessionId: string) => `${agent} · phiên ${sessionId}`,
	callerLine: (caller: string) => `Caller: ${caller}`,
	transcriptWarning: "Tin này sẽ hiện trong transcript OMP; OMP có thể chạy tool theo quyền của chính nó.",
	/** Exact framing required by 01 §7.4b: the OMP model must see the source. */
	frame: (caller: string, message: string) =>
		`[Tin nhắn từ Claude Code (phiên ${caller}), chuyển qua AgentBridge — không phải người dùng gõ]\n\n${message}`,
} as const;

export interface HostStatusFields {
	endpoint: string | undefined;
	sessionId: string;
	status: string;
	projectAllowed: boolean;
	consent: string;
	trusted: boolean;
	autochat: string;
	requests: number;
}

/** `/agentbridge` command replies, status lines and lifecycle notices (01 §7.2, §7.6). */
export const HOST_TEXT = {
	mainTuiOnly: (command: string) =>
		`AgentBridge: /agentbridge ${command} chỉ dùng trong TUI chính; không thay đổi config.`,
	projectActionLabel: (action: "allow" | "disallow") => (action === "allow" ? "Cho phép" : "Bỏ cho phép"),
	projectConfirmTitle: (action: string, label: string, project: string) =>
		`AgentBridge: /agentbridge ${action} — ${label} project?\n${project}`,
	agree: "Đồng ý",
	refuse: "Từ chối",
	confirmUnavailable: "AgentBridge: không mở được hộp thoại xác nhận; config không thay đổi.",
	confirmCancelled: "AgentBridge: đã huỷ; config không thay đổi.",
	configWriteFailed: (path: string, reason: string) =>
		`AgentBridge: không ghi được config (${path}): ${reason.slice(0, 200)}`,
	configReadFailed: (path: string, reason: string) =>
		`AgentBridge: không đọc được config (${path}): ${reason.slice(0, 200)}`,
	projectAllowed: (project: string) => `AgentBridge: đã cho phép project: ${project}`,
	projectDisallowed: (project: string) => `AgentBridge: đã bỏ cho phép project: ${project}`,
	projectAlreadyListed: (project: string) => `AgentBridge: project đã có trong danh sách: ${project}`,
	projectNotListed: (project: string) => `AgentBridge: project không có trong danh sách: ${project}`,
	configInvalidNoWrite: (path: string, reason: string) =>
		`AgentBridge: config không hợp lệ: ${path} (${reason}); không ghi đè.`,
	configInsecureNoWrite: (path: string, reason: string) =>
		`AgentBridge: config không an toàn: ${path} (${reason}); không ghi.`,
	configInsecure: (path: string, reason: string) => `AgentBridge: config không an toàn: ${path} (${reason})`,
	configInsideProject: (project: string) =>
		`AgentBridge: từ chối ghi config vì file nằm trong project được phép (${project}); hãy chuyển config ra ngoài project.`,
	configMissingHeader: (path: string) => `AgentBridge: config chưa có (dùng mặc định an toàn): ${path}`,
	configHeader: (path: string) => `AgentBridge: config: ${path}`,
	projectsLine: (projects: readonly string[]) =>
		`projects: ${projects.length === 0 ? "(trống)" : projects.join(", ")}`,
	trusted: "AgentBridge: đã tin phiên này (chỉ trong bộ nhớ).",
	untrusted: "AgentBridge: đã bỏ tin cậy phiên này.",
	serverOff: "AgentBridge: đã tắt server cho phiên này.",
	serverOn: "AgentBridge: đã bật lại server cho phiên này.",
	autochatState: (mode: string, source: string) =>
		`AgentBridge: autochat ${mode} (${source}). Dùng /agentbridge autochat off|limited [phút]|unlimited.`,
	autochatUsage: "AgentBridge: dùng /agentbridge autochat off|limited [phút]|unlimited.",
	autochatOff: "AgentBridge: autochat đã tắt cho phiên này.",
	autochatUnlimitedTui: "AgentBridge: autochat unlimited bật từ lệnh TUI.",
	autochatBadMinutes: "AgentBridge: số phút phải là số nguyên dương (tối đa 480).",
	autochatMinutesClamped: (max: number) => `AgentBridge: thời hạn autochat tối đa ${max} phút; đã kẹp về ${max}.`,
	autochatLimitedTui: (minutes: number | undefined) =>
		minutes === undefined
			? "AgentBridge: autochat limited bật từ lệnh TUI."
			: `AgentBridge: autochat limited bật từ lệnh TUI trong ${minutes} phút.`,
	autochatExpired: "AgentBridge: autochat limited đã hết hạn.",
	autochatModeTui: (mode: string) => `AgentBridge: autochat ${mode} bật từ lệnh TUI.`,
	autochatModeCli: (mode: string, flag: string) => `AgentBridge: autochat ${mode} bật từ CLI (--${flag}).`,
	autochatBadFlag: (flag: string, value: string) => `AgentBridge: bỏ qua cờ --${flag} không hợp lệ (${value}).`,
	autochatConfigUnchecked: (reason: string) =>
		`AgentBridge: bỏ qua chat.autoApprove vì không kiểm tra được config (${reason.slice(0, 160)}).`,
	autochatLimitedState: (used: number, quota: number, source: string) => `limited ${used}/${quota} (${source})`,
	autochatUnlimitedState: (used: number, source: string) => `unlimited ∞ · ${used} tin (${source})`,
	widgetCleared: "AgentBridge: đã xoá widget.",
	commandUsage: "AgentBridge: dùng /agentbridge [status|trust|untrust|autochat|off|on|clear|allow|disallow|config].",
	error: (message: string) => `AgentBridge lỗi: ${message.slice(0, 300)}`,
	statusBar: (canAnswer: boolean) => (canAnswer ? "🔗 bridge" : "🔗 bridge (status-only)"),
	statusLines: (fields: HostStatusFields) => [
		"AgentBridge",
		`endpoint: ${fields.endpoint ?? "(chưa công bố)"}`,
		`session: ${fields.sessionId}`,
		`trạng thái: ${fields.status}`,
		`project: ${fields.projectAllowed ? "được phép" : "không được phép"}`,
		`consent: ${fields.consent}${fields.trusted ? " (trusted trong phiên)" : ""}`,
		`autochat: ${fields.autochat}`,
		`request: ${fields.requests}`,
	],
} as const;

/** Autochat notices and status-bar suffixes (01 §7.4c). */
export const AUTOCHAT_TEXT = {
	unlimitedWarning: "Claude có thể gửi tin và khiến OMP chạy tool không cần duyệt; quyền tool của OMP vẫn áp dụng",
	source: { config: "config", cli: "CLI", tui: "lệnh TUI" },
	limitClamped: (maxChars: number, maxMessages: number, minIntervalMs: number) =>
		`AgentBridge: giới hạn autochat vượt mức an toàn; đã kẹp về autoMaxChars ≤ ${maxChars}, autoMaxMessages ≤ ${maxMessages}, autoMinIntervalMs ≥ ${minIntervalMs}.`,
	sent: (used: number, quota: number | undefined) =>
		`AgentBridge: tự gửi tin từ Claude (${quota === undefined ? used : `${used}/${quota}`})`,
	configInsideProject: (path: string) =>
		`AgentBridge: bỏ qua chat.autoApprove vì config nằm trong project (${path}); chuyển config ra ngoài project`,
	configInsecure: (path: string) =>
		`AgentBridge: bỏ qua chat.autoApprove vì file config phải có quyền 0600 và cùng uid (${path})`,
	enabledFromConfig: (mode: string, path: string) => `AgentBridge: autochat ${mode} bật từ config ${path}`,
	statusLimited: (base: string, used: number, quota: number) => `${base} · autochat ${used}/${quota}`,
	statusUnlimited: (base: string, used: number) => `${base} · autochat ∞ · ${used} tin`,
} as const;

/** `/agentbridge allow|disallow|config` file checks (project-config.ts). */
export const CONFIG_TEXT = {
	notRegularFile: "config phải là regular file, không phải symlink",
	badMode: "config phải có quyền 0600 và cùng uid",
	unsafeParent: "thư mục config không an toàn",
} as const;

/** Autocomplete descriptions for `/agentbridge`. */
export const COMPLETION_TEXT = {
	subcommands: {
		status: "Trạng thái server, phiên và autochat",
		trust: "Tin cậy phiên này (chỉ trong bộ nhớ)",
		untrust: "Bỏ tin cậy phiên này",
		autochat: "Chế độ tự duyệt: off | limited [phút] | unlimited",
		allow: "Cho phép project hiện tại",
		disallow: "Bỏ cho phép project hiện tại",
		config: "Xem cấu hình AgentBridge",
		off: "Tắt server cho phiên này",
		on: "Bật lại server cho phiên này",
		clear: "Xoá widget",
	},
	autochatModes: {
		off: "Tắt autochat",
		limited: "Tự duyệt có giới hạn, tuỳ chọn số phút (tối đa 480)",
		unlimited: "Tự duyệt không giới hạn",
	},
} as const;

/** Descriptions OMP shows for the extension's flag and command. */
export const EXTENSION_TEXT = {
	autochatFlag: "AgentBridge autochat: off | limited | unlimited (lệnh TUI ưu tiên hơn cờ này; config là phương án cuối)",
	command: "AgentBridge: status, trust, untrust, autochat, allow, disallow, config, off, on, clear",
} as const;
