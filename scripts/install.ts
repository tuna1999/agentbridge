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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, rm } from "node:fs/promises";
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
  extensionFile: join(home, ".omp", "agent", "extensions", "agentbridge.js"),
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
 confirm(question: string, defaultYes: boolean): Promise<boolean>;
 run(argv: string[]): Promise<CommandResult>;
}

async function defaultRun(argv: string[]): Promise<CommandResult> {
 const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
 const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
 return { exitCode, stderr };
}

async function defaultConfirm(question: string, defaultYes: boolean): Promise<boolean> {
 const rl = createInterface({ input: process.stdin, output: process.stderr });
 try {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes" || answer === "c" || answer === "có";
 } finally {
  rl.close();
 }
}

function defaultIO(): InstallerIO {
 return {
  out: (text) => {
   process.stdout.write(text);
  },
  err: (text) => {
   process.stderr.write(text);
  },
  confirm: defaultConfirm,
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

async function createSampleConfig(file: string): Promise<StepResult> {
 await mkdir(dirname(file), { recursive: true, mode: 0o700 });
 let handle: Awaited<ReturnType<typeof open>>;
 try {
  handle = await open(file, "wx", 0o600);
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
   return { ok: true, note: "config đã tồn tại, không ghi đè" };
  }
  throw error;
 }
 try {
  await handle.writeFile(`${JSON.stringify(SAMPLE_CONFIG, null, 2)}\n`);
  await handle.sync();
 } finally {
  await handle.close();
 }
 return { ok: true };
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
    await copyFile(paths.distFile, paths.extensionFile);
    await chmod(paths.extensionFile, 0o600);
    return { ok: true };
   },
  },
  {
   title: "Đăng ký MCP thủ công ở scope user (dev)",
   details: [displayCommand(addCommand), "dev mode: MCP single-file từ plugins/claude/dist"],
   perform: async () => {
    const result = await io.run(addCommand);
    if (result.exitCode === 0) return { ok: true };
    const detail = result.stderr.trim();
    return { ok: false, note: `claude mcp add lỗi (exit ${result.exitCode})${detail.length > 0 ? `: ${detail}` : ""}` };
   },
  },
  {
   title: "Tạo config mẫu",
   details: [paths.configFile, "projects = [] (consult sẽ bị project_not_allowed cho tới khi thêm project)"],
   ...(configExists ? { skip: "config đã tồn tại, giữ nguyên" } : {}),
   perform: () => createSampleConfig(paths.configFile),
  },
 ];
}

/** True when `target` is `base` or lives inside it. */
function isInside(base: string, target: string): boolean {
 const rel = relative(base, target);
 return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuse recursive deletion of the OS home, filesystem root, repo, or the installed extension. */
function unsafeHomeReason(paths: InstallPaths): string | undefined {
 if (paths.agentbridgeHome === paths.home) return "AGENTBRIDGE_HOME trùng thư mục home của user; không xóa";
 if (paths.agentbridgeHome === dirname(paths.agentbridgeHome)) return "AGENTBRIDGE_HOME là filesystem root; không xóa";
 if (paths.agentbridgeHome === paths.repoRoot || isInside(paths.agentbridgeHome, paths.repoRoot)) {
  return "AGENTBRIDGE_HOME chứa repo; không xóa";
 }
 if (isInside(paths.agentbridgeHome, paths.extensionFile)) {
  return "AGENTBRIDGE_HOME chứa extension OMP; không xóa";
 }
 return undefined;
}

function uninstallPlan(paths: InstallPaths, env: Env, io: InstallerIO): PlannedStep[] {
 const removeCommand = mcpRemoveCommand(env);
 const extensionExists = existsSync(paths.extensionFile);
 const configExists = existsSync(paths.configFile);
 const auditExists = existsSync(paths.auditFile) || existsSync(`${paths.auditFile}.1`);
 const configInsideHome = isInside(paths.agentbridgeHome, paths.configFile);
 const auditInsideHome = isInside(paths.agentbridgeHome, paths.auditFile);
 const homeExists = existsSync(paths.agentbridgeHome);
 const unsafeHome = unsafeHomeReason(paths);
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
  details: [paths.agentbridgeHome, "config, state và runtime mặc định nằm trong thư mục này"],
  optional: true,
  ...(homeExists ? {} : { skip: "không có thư mục home" }),
  ...(unsafeHome !== undefined ? { skip: unsafeHome } : {}),
  perform: async () => {
   const reason = unsafeHomeReason(paths);
   if (reason !== undefined) return { ok: false, note: reason };
   await rm(paths.agentbridgeHome, { recursive: true, force: true });
   return { ok: true };
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
 const env = options.env ?? process.env;
 const paths = resolveInstallPaths(env, options.repoRoot);
 const io: InstallerIO = { ...defaultIO(), ...options.io };
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

 const steps = options.uninstall ? uninstallPlan(paths, env, io) : installPlan(paths, env, io);
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
  const approved = await io.confirm(`${question} ${step.title}`, step.optional !== true);
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
