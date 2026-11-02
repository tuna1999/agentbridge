/** User-facing strings for the protocol package (00 §4 rule 8). */

export const PATH_GUARD_MESSAGES = {
	outside_root: "Đường dẫn nằm ngoài thư mục dự án.",
	forbidden: "Tệp này bị chặn bởi chính sách an toàn.",
	too_large: "Tệp vượt quá 256 KiB.",
	binary: "Tệp nhị phân không được hỗ trợ.",
	not_file: "Đường dẫn không phải tệp thường.",
	unreadable: "Không đọc được tệp.",
} as const;

export type PathGuardReason = keyof typeof PATH_GUARD_MESSAGES;

export const FRAME_TOO_LARGE_MESSAGE = "Frame vượt quá giới hạn 1 MiB.";

export const VALIDATION_MESSAGES = {
	invalidJson: "JSON không hợp lệ.",
	notObject: "Envelope phải là một object.",
	unsupportedVersion: (version: unknown) => `Phiên bản giao thức không được hỗ trợ: ${String(version)}.`,
	badField: (field: string) => `Envelope không hợp lệ: trường "${field}".`,
	badHop: "Envelope không hợp lệ: hop phải bằng 0.",
	questionTooLarge: (limit: number) => `Câu hỏi vượt quá giới hạn ${limit} byte.`,
	messageTooLarge: (limit: number) => `Tin nhắn vượt quá giới hạn ${limit} byte.`,
} as const;
