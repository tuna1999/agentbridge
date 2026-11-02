/** Path guard for attachment reads. Spec: docs/plan/01-design-spec.md §5.2. */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { MAX_ATTACHMENT_FILE_BYTES } from "./limits";
import { PATH_GUARD_MESSAGES, type PathGuardReason } from "./messages";

export interface ResolveInsideOptions {
	/** Compare paths case-insensitively; defaults to true on Windows. */
	caseInsensitive?: boolean;
}

export class PathGuardError extends Error {
	readonly reason: PathGuardReason;

	constructor(reason: PathGuardReason) {
		super(PATH_GUARD_MESSAGES[reason]);
		this.name = "PathGuardError";
		this.reason = reason;
	}
}

const FORBIDDEN_DIRS: Record<string, true> = {
	".ssh": true,
	".aws": true,
	".git": true,
	".claude": true,
	".omp": true,
	node_modules: true,
};

/**
 * True when `target` is `root` itself or a descendant, using `sep` boundaries.
 * Exported for callers/tests that simulate Windows casing on other platforms.
 */
export function isPathInside(root: string, target: string, caseInsensitive = process.platform === "win32"): boolean {
	const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
	const base = fold(root).replace(/[\\/]+$/, "");
	const candidate = fold(target);
	if (base === "") return candidate.startsWith("/") || candidate.startsWith("\\");
	if (candidate === base) return true;
	return candidate.startsWith(`${base}${sep}`);
}

function isForbidden(relativePath: string): boolean {
	const parts = relativePath.split(/[\\/]+/).filter(Boolean);
	const base = parts.at(-1)?.toLowerCase();
	if (base === undefined) return false;
	if (base.startsWith(".env")) return true;
	if (base.endsWith(".pem") || base.endsWith(".key")) return true;
	if (base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return true;
	return parts.slice(0, -1).some((part) => FORBIDDEN_DIRS[part.toLowerCase()] === true);
}

function hasNulByte(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(8_192);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).includes(0);
	} finally {
		closeSync(fd);
	}
}

/**
 * Resolve `p` against `root`, then enforce containment, the forbidden-pattern list,
 * the 256 KiB cap, and the binary check. Returns the resolved absolute path, or a
 * `PathGuardError` describing the rejection.
 */
export function resolveInside(root: string, p: string, options: ResolveInsideOptions = {}): string | Error {
	const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";

	let rootReal: string;
	try {
		rootReal = realpathSync(root);
	} catch {
		return new PathGuardError("unreadable");
	}

	let target: string;
	try {
		target = realpathSync(resolve(rootReal, p));
	} catch {
		return new PathGuardError("unreadable");
	}

	if (!isPathInside(rootReal, target, caseInsensitive)) return new PathGuardError("outside_root");
	if (isForbidden(relative(rootReal, target))) return new PathGuardError("forbidden");

	let info: ReturnType<typeof statSync>;
	try {
		info = statSync(target);
	} catch {
		return new PathGuardError("unreadable");
	}
	if (!info.isFile()) return new PathGuardError("not_file");
	if (info.size > MAX_ATTACHMENT_FILE_BYTES) return new PathGuardError("too_large");

	try {
		if (hasNulByte(target)) return new PathGuardError("binary");
	} catch {
		return new PathGuardError("unreadable");
	}

	return target;
}
