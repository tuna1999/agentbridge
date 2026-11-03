import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isPathInside, PathGuardError, resolveInside } from "./index";

let root: string;
let outside: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ab-pathguard-")));
	outside = realpathSync(mkdtempSync(join(tmpdir(), "ab-pathguard-outside-")));

	writeFileSync(join(root, "notes.txt"), "hello");
	writeFileSync(join(root, "empty.txt"), "");
	writeFileSync(join(outside, "secret.txt"), "outside");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "inner.txt"), "inner");
	mkdirSync(join(root, "empty-dir"));
	mkdirSync(join(root, ".ssh"));
	writeFileSync(join(root, ".ssh", "config"), "Host *");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "pkg.js"), "x");
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "config"), "x");
	writeFileSync(join(root, ".env.local"), "ENV=1");
	writeFileSync(join(root, ".ENV.LOCAL"), "ENV=1");
	writeFileSync(join(root, "server.pem"), "pem");
	writeFileSync(join(root, "id_rsa"), "key");
	writeFileSync(join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
	writeFileSync(join(root, "exact.bin"), Buffer.alloc(262_144, 0x61));
	writeFileSync(join(root, "large.bin"), Buffer.alloc(262_145, 0x61));
	writeFileSync(join(root, "unreadable.txt"), "x");
	chmodSync(join(root, "unreadable.txt"), 0o000);
	symlinkSync(join(outside, "secret.txt"), join(root, "outside-link"));
	symlinkSync(join(root, "notes.txt"), join(root, "inside-link"));
	mkdirSync(join(root, "config"));
	writeFileSync(join(root, "config", "prod.txt"), "DATABASE_URL=postgres://app:pw@db/prod");
	symlinkSync("config/prod.txt", join(root, ".env"));
	symlinkSync("../server.pem", join(root, "config", "tls-link.txt"));
});

afterAll(() => {
	try {
		chmodSync(join(root, "unreadable.txt"), 0o600);
	} catch {
		// the file may already be gone
	}
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function reasonOf(result: string | Error): string | undefined {
	return result instanceof PathGuardError ? result.reason : undefined;
}

test("accepts a regular file inside the root", () => {
	expect(resolveInside(root, "notes.txt")).toBe(realpathSync(join(root, "notes.txt")));
});

test("accepts an empty file", () => {
	expect(typeof resolveInside(root, "empty.txt")).toBe("string");
});

test("accepts a dot-dot path that stays inside", () => {
	expect(typeof resolveInside(root, "sub/../notes.txt")).toBe("string");
});

test("accepts a symlink that resolves inside", () => {
	expect(typeof resolveInside(root, "inside-link")).toBe("string");
});

test("rejects dot-dot escapes", () => {
	const escape = relative(root, join(outside, "secret.txt"));
	expect(reasonOf(resolveInside(root, escape))).toBe("outside_root");
});

test("rejects absolute paths outside the root", () => {
	expect(reasonOf(resolveInside(root, join(outside, "secret.txt")))).toBe("outside_root");
});

test("rejects symlinks that resolve outside", () => {
	expect(reasonOf(resolveInside(root, "outside-link"))).toBe("outside_root");
});

test("rejects .env files", () => {
	expect(reasonOf(resolveInside(root, ".env.local"))).toBe("forbidden");
});

test("rejects a forbidden name even when it is a symlink to an innocent-looking file", () => {
	expect(reasonOf(resolveInside(root, ".env"))).toBe("forbidden");
	expect(typeof resolveInside(root, "config/prod.txt")).toBe("string");
});

test("rejects an innocent-looking symlink that resolves to a forbidden file", () => {
	expect(reasonOf(resolveInside(root, "config/tls-link.txt"))).toBe("forbidden");
});

test("rejects .env files case-insensitively", () => {
	expect(reasonOf(resolveInside(root, ".ENV.LOCAL"))).toBe("forbidden");
});

test("rejects private-key filenames", () => {
	expect(reasonOf(resolveInside(root, "server.pem"))).toBe("forbidden");
	expect(reasonOf(resolveInside(root, "id_rsa"))).toBe("forbidden");
});

test("rejects forbidden directories anywhere in the path", () => {
	expect(reasonOf(resolveInside(root, ".ssh/config"))).toBe("forbidden");
	expect(reasonOf(resolveInside(root, "node_modules/pkg.js"))).toBe("forbidden");
	expect(reasonOf(resolveInside(root, ".git/config"))).toBe("forbidden");
});

test("rejects binary files", () => {
	expect(reasonOf(resolveInside(root, "binary.bin"))).toBe("binary");
});

test("accepts a file of exactly 256 KiB", () => {
	expect(typeof resolveInside(root, "exact.bin")).toBe("string");
});

test("rejects files larger than 256 KiB", () => {
	expect(reasonOf(resolveInside(root, "large.bin"))).toBe("too_large");
});

test("rejects directories", () => {
	expect(reasonOf(resolveInside(root, "empty-dir"))).toBe("not_file");
	expect(reasonOf(resolveInside(root, "."))).toBe("not_file");
});

test("returns unreadable for missing files and roots", () => {
	expect(reasonOf(resolveInside(root, "missing.txt"))).toBe("unreadable");
	expect(reasonOf(resolveInside(join(root, "missing-root"), "notes.txt"))).toBe("unreadable");
});

test("returns unreadable when the file cannot be opened", () => {
	if (typeof process.getuid === "function" && process.getuid() === 0) return;
	expect(reasonOf(resolveInside(root, "unreadable.txt"))).toBe("unreadable");
});

test("supports an explicit case-insensitive comparison", () => {
	expect(typeof resolveInside(root, "notes.txt", { caseInsensitive: true })).toBe("string");
});

test("isPathInside respects path boundaries", () => {
	expect(isPathInside("/tmp/root", "/tmp/root/file.txt")).toBe(true);
	expect(isPathInside("/tmp/root", "/tmp/root")).toBe(true);
	expect(isPathInside("/tmp/root", "/tmp/root-evil/file.txt")).toBe(false);
	expect(isPathInside("/", "/etc/passwd")).toBe(true);
});

test("isPathInside simulates Windows casing", () => {
	expect(isPathInside("/tmp/Root", "/tmp/root/file.txt", true)).toBe(true);
	expect(isPathInside("/tmp/Root", "/tmp/root/file.txt", false)).toBe(false);
	expect(isPathInside("/tmp/root", "/tmp/ROOT/file.txt", true)).toBe(true);
});

test("error carries a reason and a message", () => {
	const error = new PathGuardError("binary");
	expect(error.name).toBe("PathGuardError");
	expect(error.reason).toBe("binary");
	expect(error.message.length).toBeGreaterThan(0);
});
