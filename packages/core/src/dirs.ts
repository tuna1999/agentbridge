/** Runtime/state/config paths and secure filesystem helpers. Spec: 01 §2. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { CORE_MESSAGES } from "./messages";

export interface Dirs {
	/** AgentBridge home: config, state, and run all live below it by default. */
	homeDir: string;
	runtimeDir: string;
	stateDir: string;
	configFile: string;
	sessionsDir: string;
	socketsDir: string;
}

type DirEnv = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Resolve all paths. The AgentBridge home is `~/.agentbridge` on every
 * platform; AGENTBRIDGE_HOME moves the whole tree, while each AGENTBRIDGE_*
 * path override wins over the corresponding home-relative path.
 */
export function resolveDirs(
	env: DirEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home?: string,
): Dirs {
	const path = platform === "win32" ? win32 : posix;
	const envHome = platform === "win32" ? nonEmpty(env.USERPROFILE) : nonEmpty(env.HOME);
	const baseHome = home ?? envHome ?? homedir();
	const homeDir = path.resolve(nonEmpty(env.AGENTBRIDGE_HOME) ?? path.join(baseHome, ".agentbridge"));
	const runtimeDir = path.resolve(nonEmpty(env.AGENTBRIDGE_RUNTIME_DIR) ?? path.join(homeDir, "run"));
	const stateDir = path.resolve(nonEmpty(env.AGENTBRIDGE_STATE_DIR) ?? path.join(homeDir, "state"));
	const configFile = path.resolve(nonEmpty(env.AGENTBRIDGE_CONFIG) ?? path.join(homeDir, "config.json"));

	return {
		homeDir,
		runtimeDir,
		stateDir,
		configFile,
		sessionsDir: path.join(runtimeDir, "sessions"),
		socketsDir: path.join(runtimeDir, "s"),
	};
}

/** Keep headroom below the Linux (108) and macOS (104) `sun_path` limits. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;

/** Reject Unix socket paths longer than the platform-safe ceiling. */
export function assertSocketPathLength(path: string): void {
	const bytes = Buffer.byteLength(path, "utf8");
	if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
		throw new Error(CORE_MESSAGES.socketPathTooLong(path, bytes, MAX_UNIX_SOCKET_PATH_BYTES));
	}
}

export class InsecureDirError extends Error {
	readonly code = "insecure_runtime_dir";
	readonly path: string;

	constructor(path: string) {
		super(CORE_MESSAGES.insecureDir(path));
		this.name = "InsecureDirError";
		this.path = path;
	}
}

/** Verify an existing directory: 0700, current uid, not a symlink. Missing -> ENOENT. */
export async function assertSecureDir(path: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new InsecureDirError(path);
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) throw new InsecureDirError(path);
	if ((info.mode & 0o077) !== 0) throw new InsecureDirError(path);
}

/** Create `path` (0700) and refuse symlinks, foreign owners, or group/other bits. */
export async function ensureSecureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await assertSecureDir(path);
}

export async function ensureRuntimeDirs(dirs: Dirs = resolveDirs()): Promise<Dirs> {
	await ensureSecureDir(dirs.homeDir);
	await ensureSecureDir(dirs.runtimeDir);
	await ensureSecureDir(dirs.sessionsDir);
	await ensureSecureDir(dirs.socketsDir);
	return dirs;
}

/** Write via `<file>.<uuid>.tmp` (0600), fsync, then rename. */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	try {
		const handle = await open(tmp, "wx", 0o600);
		try {
			await handle.chmod(0o600);
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, filePath);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}
