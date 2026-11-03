/** User-facing strings for the core package (00 §4 rule 8). */

export const CORE_MESSAGES = {
	insecureDir: (path: string) => `Thư mục không an toàn (cần 0700 và thuộc user hiện tại): ${path}`,
	invalidConfig: (path: string) => `Config không hợp lệ, dùng mặc định an toàn: ${path}`,
	missingProject: (path: string) => `Bỏ qua project không tồn tại: ${path}`,
	relativeProject: (path: string) => `Bỏ qua project không phải đường dẫn tuyệt đối: ${path}`,
	socketPathTooLong: (path: string, bytes: number, maxBytes: number) =>
		`Đường dẫn socket quá dài (${bytes} byte, tối đa ${maxBytes}): ${path}. Hãy đặt AGENTBRIDGE_RUNTIME_DIR ngắn hơn.`,
} as const;
