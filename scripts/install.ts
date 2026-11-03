#!/usr/bin/env bun
/**
 * T10 dev-mode installer (clone). Dry-run by default; `--apply` asks y/n before
 * every step.
 *
 * Dev mode copies the OMP bundle from `plugins/omp/dist` and registers the
 * single-file MCP bundle from `plugins/claude/dist` manually. Normal users
 * install the Claude/OMP plugins instead (see README). Uninstall removes the
 * dev artifacts, then keeps config/audit/home unless the user explicitly agrees
 * to delete them. Never edits shell profiles.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

export interface InstallPaths {
 repoRoot: string;
 distFile: string;
 mcpEntry: string;
 /** OS user home (`HOME` / `USERPROFILE`). */
 home: string;
 /** AgentBridge home default `~/.agentbridge`, overridable via `AGENTBRIDGE_HOME`. */
 agentbridgeHome: string;
 extensionFile: string;
 configFile: string;
 stateDir: string;
 runtimeDir: string;
 auditFile: string;
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
 return value !== undefined && value.length > 0 ? value : undefined;
}

function homeDirectory(env: Env): string {
 const fromEnv = process.platform === "win32" ? env.USERPROFILE : env.HOME;
 return nonEmpty(fromEnv) ?? homedir();
}

/**
 * OMP's active agent directory, resolved the way OMP 18.14 does: the config
 * root is `path.join(homedir, PI_CONFIG_DIR || ".omp")` (always below home); a
 * profile (`OMP_PROFILE` / `PI_PROFILE`) selects `<root>/profiles/<name>/agent`
 * and then ignores `PI_CODING_AGENT_DIR`; otherwise `PI_CODING_AGENT_DIR`
 * overrides `<root>/agent`. `omp --profile` on the command line is not visible here.
 */
export function ompAgentDir(env: Env, home: string): string {
 const root = join(home, nonEmpty(env.PI_CONFIG_DIR) ?? ".omp");
 const profile = nonEmpty(env.OMP_PROFILE) ?? nonEmpty(env.PI_PROFILE);
 if (profile !== undefined) return join(root, "profiles", profile, "agent");
 const agentDir = nonEmpty(env.PI_CODING_AGENT_DIR);
 return agentDir !== undefined ? resolve(agentDir) : join(root, "agent");
}

/** Same defaults as @agentbridge/core `resolveDirs`, duplicated to keep this script standalone. */
export function resolveInstallPaths(env: Env = process.env, repoRoot = resolve(import.meta.dir, "..")): InstallPaths {
 const home = homeDirectory(env);
 const agentbridgeHome = resolve(nonEmpty(env.AGENTBRIDGE_HOME) ?? join(home, ".agentbridge"));
 const configFile = resolve(nonEmpty(env.AGENTBRIDGE_CONFIG) ?? join(agentbridgeHome, "config.json"));
 const stateDir = resolve(nonEmpty(env.AGENTBRIDGE_STATE_DIR) ?? join(agentbridgeHome, "state"));
 const runtimeDir = resolve(nonEmpty(env.AGENTBRIDGE_RUNTIME_DIR) ?? join(agentbridgeHome, "run"));
 return {
  repoRoot,
  distFile: join(repoRoot, "plugins", "omp", "dist", "agentbridge.js"),
  mcpEntry: join(repoRoot, "plugins", "claude", "dist", "mcp-server.js"),
  home,
  agentbridgeHome,
  extensionFile: join(ompAgentDir(env, home), "extensions", "agentbridge.js"),
  configFile,
  stateDir,
  runtimeDir,
  auditFile: join(stateDir, "audit.jsonl"),
 };
}

export const SAMPLE_CONFIG = {
 version: 1,
 projects: [] as string[],
 allowFrom: ["claude-code"],
 consult: {
  consent: "ask",
  consentTimeoutMs: 60_000,
  maxQuestionBytes: 32_768,
  maxAttachmentBytes: 65_536,
  maxContextBytes: 1_048_576,
  replyMaxBytes: 32_768,
  maxTokens: 4_096,
  allowUncapped: false,
  ratePerMinute: 6,
  toolsOff: true,
 },
 chat: {
  enabled: false,
  queueWhenBusy: false,
  consentTimeoutMs: 120_000,
  autoApprove: "off",
  autoMaxChars: 2_000,
  autoMaxMessages: 20,
  autoMinIntervalMs: 10_000,
 },
 audit: { content: false, maxBytes: 5_242_880 },
 ui: { liveWidget: true, widgetLines: 6, widgetHoldMs: 20_000 },
};

export async function sha256File(file: string): Promise<string | undefined> {
 try {
  return createHash("sha256").update(await readFile(file)).digest("hex");
 } catch {
  return undefined;
 }
}

export interface BundleComparison {
 state: "missing" | "same" | "different" | "no-dist";
 installedSha?: string;
 distSha?: string;
}

/** Compare the installed bundle with dist to expose an older install (T10). */
export async function compareBundles(installedFile: string, distFile: string): Promise<BundleComparison> {
 const [installedSha, distSha] = await Promise.all([sha256File(installedFile), sha256File(distFile)]);
 if (distSha === undefined) return { state: "no-dist", ...(installedSha === undefined ? {} : { installedSha }) };
 if (installedSha === undefined) return { state: "missing", distSha };
 if (installedSha === distSha) return { state: "same", installedSha, distSha };
 return { state: "different", installedSha, distSha };
}

function shortSha(sha: string | undefined): string {
 return sha === undefined ? "không đọc được" : sha.slice(0, 12);
}

export function describeBundle(comparison: BundleComparison): string[] {
 switch (comparison.state) {
  case "no-dist":
   return [
    `dist: chưa có file (sha256 ${shortSha(comparison.distSha)})`,
    `đã cài: sha256 ${shortSha(comparison.installedSha)}`,
    "Chạy `bun run build` trước khi cài.",
   ];
  case "missing":
   return [
    `dist: sha256 ${shortSha(comparison.distSha)}`,
    "đã cài: chưa có",
   ];
  case "same":
   return [
    `dist: sha256 ${shortSha(comparison.distSha)}`,
    `đã cài: sha256 ${shortSha(comparison.installedSha)}`,
    "Bản cài trùng khớp dist.",
   ];
  case "different":
   return [
    `dist: sha256 ${shortSha(comparison.distSha)}`,
    `đã cài: sha256 ${shortSha(comparison.installedSha)}`,
    "Bản cài KHÁC dist: có thể là bản cũ; --apply sẽ ghi đè.",
   ];
 }
}

function shellQuote(value: string): string {
 return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(argv: readonly string[]): string {
 return argv.map(shellQuote).join(" ");
}

function findExecutable(name: string, env: Env): string {
 return Bun.which(name, { PATH: env.PATH }) ?? name;
}

/** T10: the MCP command must use an absolute `bun` path from Bun.which. */
export function mcpAddCommand(paths: InstallPaths, env: Env = process.env): string[] {
 const bun = Bun.which("bun", { PATH: env.PATH }) ?? process.execPath;
 const claude = findExecutable("claude", env);
 return [claude, "mcp", "add", "-s", "user", "agentbridge", "--", bun, paths.mcpEntry];
}

export function mcpRemoveCommand(env: Env = process.env): string[] {
 return [findExecutable("claude", env), "mcp", "remove", "-s", "user", "agentbridge"];
}

export interface CommandResult {
 exitCode: number;
 stderr: string;
}

export interface InstallerIO {
 out(text: string): void;
 err(text: string): void;
 /** Throws `StdinClosedError` when no answer can arrive any more. */
 confirm(question: string, defaultYes: boolean): Promise<boolean>;
 run(argv: string[]): Promise<CommandResult>;
 /** Releases stdin so the process can exit. */
 close?(): void;
}

async function defaultRun(argv: string[]): Promise<CommandResult> {
 const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
 const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
 return { exitCode, stderr };
}

/** stdin ended before an answer: the remaining steps must not run silently. */
export class StdinClosedError extends Error {
 constructor() {
  super("stdin đã đóng trước khi có câu trả lời");
  this.name = "StdinClosedError";
 }
}

/**
 * One readline for the whole run: piped answers are consumed one per question
 * (a readline per question swallowed the rest), and EOF rejects instead of
 * leaving the question pending forever.
 */
function createStdinAsker(): Pick<InstallerIO, "confirm" | "close"> {
 let rl: ReturnType<typeof createInterface> | undefined;
 const lines: string[] = [];
 let closed = false;
 let waiting: ((line: string | undefined) => void) | undefined;
 const reader = (): ReturnType<typeof createInterface> => {
  if (rl !== undefined) return rl;
  // terminal: false keeps the TTY in cooked mode: echo and Ctrl-C (SIGINT) still
  // work while the interface stays open across steps.
  rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  rl.on("line", (line) => {
   const resolveLine = waiting;
   waiting = undefined;
   if (resolveLine !== undefined) resolveLine(line);
   else lines.push(line);
  });
  rl.on("close", () => {
   closed = true;
   const resolveLine = waiting;
   waiting = undefined;
   resolveLine?.(undefined);
  });
  return rl;
 };
 return {
  async confirm(question, defaultYes) {
   reader();
   const suffix = defaultYes ? "[Y/n]" : "[y/N]";
   process.stderr.write(`${question} ${suffix} `);
   const buffered = lines.shift();
   const line =
    buffered ?? (closed ? undefined : await new Promise<string | undefined>((resolveLine) => { waiting = resolveLine; }));
   if (line === undefined) throw new StdinClosedError();
   const answer = line.trim().toLowerCase();
   if (answer === "") return defaultYes;
   return answer === "y" || answer === "yes" || answer === "c" || answer === "có";
  },
  close() {
   rl?.close();
  },
 };
}

function defaultIO(): InstallerIO {
 const asker = createStdinAsker();
 return {
  out: (text) => {
   process.stdout.write(text);
  },
  err: (text) => {
   process.stderr.write(text);
  },
  confirm: asker.confirm,
  close: asker.close,
  run: defaultRun,
 };
}

interface StepResult {
 ok: boolean;
 note?: string;
}

interface PlannedStep {
 title: string;
 details: string[];
 skip?: string;
 optional?: boolean;
 perform(): Promise<StepResult>;
}

function writeLine(io: InstallerIO, text: string): void {
 io.out(text.endsWith("\n") ? text : `${text}\n`);
}

/** Write `data` to `<file>.<uuid>.tmp` (0600) and fsync it; the caller links or renames it into place. */
async function writeTemp(file: string, data: string | Uint8Array): Promise<string> {
 const tmp = `${file}.${randomUUID()}.tmp`;
 const handle = await open(tmp, "wx", 0o600);
 try {
  await handle.writeFile(data);
  await handle.sync();
 } catch (error) {
  await handle.close();
  await rm(tmp, { force: true });
  throw error;
 }
 await handle.close();
 return tmp;
}

/**
 * Replace `file` atomically (tmp → rename). `rename` replaces a symlink at
 * `file` instead of writing through it, and an interrupted copy never leaves
 * a truncated extension behind.
 */
async function replaceFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
 const tmp = await writeTemp(file, data);
 try {
  await rename(tmp, file);
 } catch (error) {
  await rm(tmp, { force: true });
  throw error;
 }
}

/** `false` when the file already exists; a failed write never leaves a partial file. */
async function createExclusive(file: string, content: string): Promise<boolean> {
 let handle: Awaited<ReturnType<typeof open>>;
 try {
  handle = await open(file, "wx", 0o600);
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
  throw error;
 }
 try {
  await handle.writeFile(content);
  await handle.sync();
 } catch (error) {
  await handle.close();
  await rm(file, { force: true });
  throw error;
 }
 await handle.close();
 return true;
}

/** Existing parent: a real directory owned by this user (never a symlink). */
async function assertOwnDirectory(dir: string): Promise<void> {
 const info = await lstat(dir);
 const uid = process.getuid?.();
 if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
  throw new Error(`thư mục không an toàn (cần thư mục thật thuộc user hiện tại): ${dir}`);
 }
}

/**
 * Spec §2: config 0600 in a 0700 parent, never overwriting an existing file.
 * The content is written to a temp file and hard-linked into place, so a
 * failed write never leaves a truncated config that later runs would keep.
 */
async function createSampleConfig(paths: InstallPaths): Promise<StepResult> {
 const file = paths.configFile;
 const parent = dirname(file);
 await mkdir(parent, { recursive: true, mode: 0o700 });
 await assertOwnDirectory(parent);
 let note: string | undefined;
 if (resolve(parent) === resolve(paths.agentbridgeHome) && ((await lstat(parent)).mode & 0o077) !== 0) {
  // The host refuses a group/other-accessible AgentBridge home (01 §2), but a
  // home that is (or contains) the user's HOME, the repo or a symlink is never re-moded.
  const unsafe = await unsafeHomeReason(paths);
  if (unsafe === undefined) {
   await chmod(parent, 0o700);
   note = `đã đặt quyền 0700 cho ${parent}`;
  } else {
   note = `không tự đổi quyền ${parent} (${unsafe}); host cần thư mục này ở quyền 0700`;
  }
 }
 const content = `${JSON.stringify(SAMPLE_CONFIG, null, 2)}\n`;
 const tmp = await writeTemp(file, content);
 try {
  await link(tmp, file);
 } catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return { ok: true, note: "config đã tồn tại, không ghi đè" };
  if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS" && code !== "EXDEV") {
   throw error;
  }
  // Filesystem without hard links: exclusive create, removed again if the write fails.
  if (!(await createExclusive(file, content))) return { ok: true, note: "config đã tồn tại, không ghi đè" };
 } finally {
  await rm(tmp, { force: true });
 }
 return note === undefined ? { ok: true } : { ok: true, note };
}

function installPlan(paths: InstallPaths, env: Env, io: InstallerIO): PlannedStep[] {
 const addCommand = mcpAddCommand(paths, env);
 const configExists = existsSync(paths.configFile);
 return [
  {
   title: "Cài extension OMP (dev)",
   details: [`nguồn: ${paths.distFile}`, `đích:  ${paths.extensionFile}`, "dev mode: bundle từ plugins/omp/dist"],
   perform: async () => {
    await mkdir(dirname(paths.extensionFile), { recursive: true, mode: 0o700 });
    await replaceFileAtomic(paths.extensionFile, await readFile(paths.distFile));
    return { ok: true };
   },
  },
  {
   title: "Đăng ký MCP thủ công ở scope user (dev)",
   details: [displayCommand(addCommand), "dev mode: MCP single-file từ plugins/claude/dist"],
   perform: async () => {
    let result = await io.run(addCommand);
    let note: string | undefined;
    if (result.exitCode !== 0 && /already exists/i.test(result.stderr)) {
     // Re-running the installer (e.g. after moving the clone) replaces the old registration.
     const removed = await io.run(mcpRemoveCommand(env));
     if (removed.exitCode === 0) {
      result = await io.run(addCommand);
      note = "đã thay đăng ký agentbridge cũ";
     }
    }
    if (result.exitCode === 0) return note === undefined ? { ok: true } : { ok: true, note };
    const detail = result.stderr.trim();
    return { ok: false, note: `claude mcp add lỗi (exit ${result.exitCode})${detail.length > 0 ? `: ${detail}` : ""}` };
   },
  },
  {
   title: "Tạo config mẫu",
   details: [paths.configFile, "projects = [] (consult sẽ bị project_not_allowed cho tới khi thêm project)"],
   ...(configExists ? { skip: "config đã tồn tại, giữ nguyên" } : {}),
   perform: () => createSampleConfig(paths),
  },
 ];
}

/** True when `target` is `base` or lives inside it. */
function isInside(base: string, target: string): boolean {
 const rel = relative(base, target);
 return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realOrResolved(path: string): Promise<string> {
 try {
  return await realpath(path);
 } catch {
  return resolve(path);
 }
}

/**
 * Refuse to clean the OS home, an ancestor of it, the filesystem root, the repo
 * or the OMP extension dir — compared by real path, so a symlinked HOME or an
 * AGENTBRIDGE_HOME alias cannot slip past — and anything that is not a real
 * directory owned by this user. Deletion itself is limited to AgentBridge files.
 */
export async function unsafeHomeReason(paths: InstallPaths): Promise<string | undefined> {
 const home = await realOrResolved(paths.agentbridgeHome);
 const userHome = await realOrResolved(paths.home);
 const repo = await realOrResolved(paths.repoRoot);
 const extensionDir = await realOrResolved(dirname(paths.extensionFile));
 if (home === dirname(home)) return "AGENTBRIDGE_HOME là filesystem root; không xóa";
 if (isInside(home, userHome)) return "AGENTBRIDGE_HOME trùng thư mục home của user (hoặc chứa nó); không xóa";
 if (isInside(home, repo)) return "AGENTBRIDGE_HOME chứa repo; không xóa";
 if (isInside(home, extensionDir)) return "AGENTBRIDGE_HOME chứa extension OMP; không xóa";
 let info: Awaited<ReturnType<typeof lstat>>;
 try {
  info = await lstat(paths.agentbridgeHome);
 } catch {
  return undefined;
 }
 const uid = process.getuid?.();
 if (info.isSymbolicLink()) return "AGENTBRIDGE_HOME là symlink; không xóa";
 if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
  return "AGENTBRIDGE_HOME không phải thư mục thuộc user hiện tại; không xóa";
 }
 return undefined;
}

/** A directory entry AgentBridge created: regular file or socket, never a symlink. */
async function removeOwnEntries(dir: string, matches: (name: string) => boolean): Promise<void> {
 let names: string[];
 try {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  names = await readdir(dir);
 } catch {
  return;
 }
 for (const name of names) {
  if (!matches(name)) continue;
  const path = join(dir, name);
  try {
   const info = await lstat(path);
   if (info.isFile() || info.isSocket()) await rm(path, { force: true });
  } catch {
   // vanished meanwhile
  }
 }
}

async function removeDirIfEmpty(dir: string): Promise<void> {
 try {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  await rmdir(dir);
 } catch {
  // not empty or already gone: keep it
 }
}

const TMP_SUFFIX = /\.[0-9a-f-]{36}\.tmp$/;

const AGENTBRIDGE_CONFIG_KEYS: ReadonlySet<string> = new Set(["version", "projects", "allowFrom", "consult", "chat", "audit", "ui"]);

function isAgentBridgeConfig(raw: string): boolean {
 try {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) return false;
  // Every key must be an AgentBridge key: a foreign config.json that merely has
  // a `projects` field is not ours to delete.
  if (!Object.keys(record).every((key) => AGENTBRIDGE_CONFIG_KEYS.has(key))) return false;
  return record.projects === undefined || Array.isArray(record.projects);
 } catch {
  return false;
 }
}

/**
 * Delete only what AgentBridge writes under its home — `config.json` (when it
 * is an AgentBridge config), the audit log, registry records, tokens and
 * sockets — then remove the emptied directories. Anything else keeps the home
 * and is reported, so a mistaken AGENTBRIDGE_HOME can never lose foreign data.
 */
async function removeAgentBridgeHome(home: string): Promise<StepResult> {
 const config = join(home, "config.json");
 try {
  const info = await lstat(config);
  if (info.isFile() && isAgentBridgeConfig(await readFile(config, "utf8"))) await rm(config, { force: true });
 } catch {
  // no config
 }
 await removeOwnEntries(home, (name) => name.startsWith("config.json.") && TMP_SUFFIX.test(name));
 const stateDir = join(home, "state");
 await removeOwnEntries(stateDir, (name) => name === "audit.jsonl" || name === "audit.jsonl.1");
 await removeDirIfEmpty(stateDir);
 const runDir = join(home, "run");
 const sessionsDir = join(runDir, "sessions");
 await removeOwnEntries(sessionsDir, (name) => /^omp-.+\.(?:json|token)$/.test(name) || TMP_SUFFIX.test(name));
 await removeDirIfEmpty(sessionsDir);
 const socketsDir = join(runDir, "s");
 await removeOwnEntries(socketsDir, (name) => /^[0-9a-f]{16}\.sock$/.test(name));
 await removeDirIfEmpty(socketsDir);
 await removeDirIfEmpty(runDir);
 await removeDirIfEmpty(home);
 if (!existsSync(home)) return { ok: true };
 let left: string[] = [];
 try {
  left = await readdir(home);
 } catch {
  // unreadable: report the directory itself
 }
 return { ok: true, note: `giữ ${home} vì còn file không phải của AgentBridge: ${left.join(", ") || "(không đọc được)"}` };
}

async function uninstallPlan(paths: InstallPaths, env: Env, io: InstallerIO): Promise<PlannedStep[]> {
 const removeCommand = mcpRemoveCommand(env);
 const extensionExists = existsSync(paths.extensionFile);
 const configExists = existsSync(paths.configFile);
 const auditExists = existsSync(paths.auditFile) || existsSync(`${paths.auditFile}.1`);
 const configInsideHome = isInside(paths.agentbridgeHome, paths.configFile);
 const auditInsideHome = isInside(paths.agentbridgeHome, paths.auditFile);
 const homeExists = existsSync(paths.agentbridgeHome);
 const unsafeHome = await unsafeHomeReason(paths);
 const steps: PlannedStep[] = [
  {
   title: "Gỡ extension OMP (dev)",
   details: [paths.extensionFile],
   ...(extensionExists ? {} : { skip: "chưa cài" }),
   perform: async () => {
    await rm(paths.extensionFile, { force: true });
    return { ok: true };
   },
  },
  {
   title: "Gỡ đăng ký MCP thủ công ở scope user (dev)",
   details: [displayCommand(removeCommand)],
   perform: async () => {
    try {
     const result = await io.run(removeCommand);
     if (result.exitCode === 0) return { ok: true };
     const detail = result.stderr.trim();
     return {
      ok: true,
      note: `claude mcp remove trả exit ${result.exitCode} (có thể chưa đăng ký)${detail.length > 0 ? `: ${detail}` : ""}`,
     };
    } catch (error) {
     return { ok: true, note: `không chạy được claude: ${error instanceof Error ? error.message : String(error)}` };
    }
   },
  },
 ];

 // Config/audit inside the home are covered by the home-removal step; listing
 // them again would offer the same destructive action twice.
 if (!configInsideHome) {
  steps.push({
   title: "Xóa config",
   details: [paths.configFile],
   optional: true,
   ...(configExists ? {} : { skip: "không có config" }),
   perform: async () => {
    await rm(paths.configFile, { force: true });
    return { ok: true };
   },
  });
 }
 if (!auditInsideHome) {
  steps.push({
   title: "Xóa audit log",
   details: [paths.auditFile, `${paths.auditFile}.1`],
   optional: true,
   ...(auditExists ? {} : { skip: "không có audit log" }),
   perform: async () => {
    await rm(paths.auditFile, { force: true });
    await rm(`${paths.auditFile}.1`, { force: true });
    return { ok: true };
   },
  });
 }

 steps.push({
  title: "Xóa thư mục AgentBridge home",
  details: [
   paths.agentbridgeHome,
   "chỉ xóa config.json, audit log và file runtime của AgentBridge; còn file khác thì giữ thư mục",
  ],
  optional: true,
  ...(homeExists ? {} : { skip: "không có thư mục home" }),
  ...(unsafeHome !== undefined ? { skip: unsafeHome } : {}),
  perform: async () => {
   const reason = await unsafeHomeReason(paths);
   if (reason !== undefined) return { ok: false, note: reason };
   return removeAgentBridgeHome(paths.agentbridgeHome);
  },
 });
 return steps;
}

export interface InstallerOptions {
 apply: boolean;
 uninstall: boolean;
 env?: Env;
 repoRoot?: string;
 io?: Partial<InstallerIO>;
}

export async function runInstaller(options: InstallerOptions): Promise<number> {
 const io: InstallerIO = { ...defaultIO(), ...options.io };
 try {
  return await runInstallerWith(options, io);
 } finally {
  // An open readline keeps stdin, and therefore the process, alive.
  io.close?.();
 }
}

async function runInstallerWith(options: InstallerOptions, io: InstallerIO): Promise<number> {
 const env = options.env ?? process.env;
 const paths = resolveInstallPaths(env, options.repoRoot);
 const mode = options.uninstall ? "GỠ CÀI ĐẶT" : "CÀI ĐẶT";
 const header = options.apply ? `${mode} — APPLY` : `${mode} — DRY RUN`;

 writeLine(io, `AgentBridge dev-mode installer: ${header}`);
 writeLine(io, `Repo: ${paths.repoRoot}`);
 writeLine(io, `HOME: ${paths.home}`);
 writeLine(io, `AgentBridge home: ${paths.agentbridgeHome}`);
 writeLine(io, "");

 if (!options.uninstall) {
  if (!existsSync(paths.distFile) && options.apply) {
   io.err(`Không thấy bundle: ${paths.distFile}\nChạy \`bun run build\` trước khi cài.\n`);
   return 1;
  }
  const comparison = await compareBundles(paths.extensionFile, paths.distFile);
  writeLine(io, "Bundle:");
  for (const line of describeBundle(comparison)) writeLine(io, `  ${line}`);
  writeLine(io, "");
 }

 const steps = options.uninstall ? await uninstallPlan(paths, env, io) : installPlan(paths, env, io);
 let failed = false;

 for (const [index, step] of steps.entries()) {
  const number = index + 1;
  writeLine(io, `[${number}/${steps.length}] ${step.title}`);
  for (const detail of step.details) writeLine(io, `  ${detail}`);

  if (step.skip !== undefined) {
   writeLine(io, `  [bỏ qua] ${step.skip}`);
   writeLine(io, "");
   continue;
  }

  if (!options.apply) {
   const marker = step.optional === true ? "[hỏi khi --apply, mặc định giữ]" : "[sẽ làm]";
   writeLine(io, `  ${marker}`);
   writeLine(io, "");
   continue;
  }

  const question = step.optional === true ? `Xóa?` : `Thực hiện?`;
  let approved: boolean;
  try {
   approved = await io.confirm(`${question} ${step.title}`, step.optional !== true);
  } catch (error) {
   if (!(error instanceof StdinClosedError)) throw error;
   failed = true;
   writeLine(io, "  [dừng] stdin đã đóng: không nhận được câu trả lời; các bước còn lại không chạy.");
   break;
  }
  if (!approved) {
   writeLine(io, step.optional === true ? "  [giữ nguyên]" : "  [bỏ qua]");
   writeLine(io, "");
   continue;
  }

  try {
   const result = await step.perform();
   if (result.ok) {
    writeLine(io, result.note === undefined ? "  [ok]" : `  [ok] ${result.note}`);
   } else {
    failed = true;
    writeLine(io, `  [lỗi] ${result.note ?? "bước thất bại"}`);
   }
  } catch (error) {
   failed = true;
   writeLine(io, `  [lỗi] ${error instanceof Error ? error.message : String(error)}`);
  }
  writeLine(io, "");
 }

 if (!options.apply) {
  writeLine(io, "Dry-run: không ghi file nào. Thêm --apply để thực hiện từng bước.");
 } else if (failed) {
  writeLine(io, "Hoàn tất với lỗi. Xem chi tiết ở trên.");
 } else {
  writeLine(io, "Hoàn tất.");
 }
 return failed ? 1 : 0;
}

export interface InstallerArgs {
 apply: boolean;
 uninstall: boolean;
 help: boolean;
}

export function parseInstallerArgs(argv: string[]): InstallerArgs {
 const args: InstallerArgs = { apply: false, uninstall: false, help: false };
 for (const arg of argv) {
  if (arg === "--apply") args.apply = true;
  else if (arg === "--uninstall") args.uninstall = true;
  else if (arg === "--help" || arg === "-h") args.help = true;
  else throw new Error(`Tham số không hỗ trợ: ${arg}`);
 }
 return args;
}

export const INSTALLER_USAGE = `Dùng: bun scripts/install.ts [--apply] [--uninstall]

  Dev mode (clone): dùng khi phát triển AgentBridge. Người dùng thường cài
  plugin qua \`claude plugin ...\` và \`omp plugin ...\` (xem README).

  (không tham số)   Chỉ in các bước cài đặt (dry-run), không ghi gì.
  --apply           Hỏi y/n từng bước rồi thực hiện.
  --uninstall       Kế hoạch gỡ dev mode (extension copy + MCP thủ công;
                    không gỡ plugin Claude/OMP). Dry-run trừ khi có --apply.
                    Config, audit log và thư mục ~/.agentbridge chỉ bị xóa
                    khi người dùng đồng ý (mặc định là giữ).
`;

async function main(argv: string[]): Promise<number> {
 let args: InstallerArgs;
 try {
  args = parseInstallerArgs(argv);
 } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(INSTALLER_USAGE);
  return 2;
 }
 if (args.help) {
  process.stdout.write(INSTALLER_USAGE);
  return 0;
 }
 return runInstaller({ apply: args.apply, uninstall: args.uninstall });
}

if (import.meta.main) {
 main(process.argv.slice(2))
  .then((code) => {
   process.exitCode = code;
  })
  .catch((error: unknown) => {
   process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
   process.exitCode = 1;
  });
}
