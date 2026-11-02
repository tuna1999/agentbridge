#!/usr/bin/env bun
/** Debug CLI `ab`. Spec: 01 §8.5. Never writes stdout for the MCP server; this is a human tool. */
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertSecureDir, gitInfo, loadConfig, resolveDirs, sweepStale } from "@agentbridge/core";
import { isRecord } from "@agentbridge/protocol";
import {
	type CallerContext,
	chatTarget,
	collectSessions,
	consultTarget,
	filterByScope,
	type IncludeFileInput,
	readIncludeFiles,
	resolveTarget,
	type Scope,
	statusOf,
} from "./client";
import { failureFrom, formatFailure } from "./errors";
import {
	formatChatResult,
	formatConsultHeader,
	formatConsultResult,
	formatSessionTable,
	formatStatus,
	sessionJson,
} from "./format";
import { CLI_USAGE, MCP_MESSAGES } from "./messages";

export interface CliIO {
	stdout(text: string): void;
	stderr(text: string): void;
	cwd: string;
}

function defaultIO(): CliIO {
	return {
		stdout: (text) => {
			process.stdout.write(text);
		},
		stderr: (text) => {
			process.stderr.write(text);
		},
		cwd: process.cwd(),
	};
}

function line(io: CliIO, text: string, stream: "stdout" | "stderr" = "stdout"): void {
	io[stream](text.endsWith("\n") ? text : `${text}\n`);
}

/** `homedir()` caches at startup under Bun; HOME/USERPROFILE must win for `ab doctor` overrides. */
function homeDirectory(): string {
	const envHome = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	return envHome ?? homedir();
}

export interface LegacyXdgDir {
	kind: "config" | "state" | "runtime";
	path: string;
}

/**
 * Old XDG defaults (removed from the resolution order). `ab doctor` only warns
 * when they still exist; AgentBridge never reads or migrates them automatically.
 */
export function legacyXdgDirs(
	env: Record<string, string | undefined> = process.env,
	home: string = homeDirectory(),
): LegacyXdgDir[] {
	const configHome =
		env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
			? env.XDG_CONFIG_HOME
			: join(home, ".config");
	const stateHome =
		env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.length > 0
			? env.XDG_STATE_HOME
			: join(home, ".local", "state");
	const dirs: LegacyXdgDir[] = [
		{ kind: "config", path: resolve(configHome, "agentbridge") },
		{ kind: "state", path: resolve(stateHome, "agentbridge") },
	];
	const runtimeHome = env.XDG_RUNTIME_DIR;
	if (runtimeHome !== undefined && runtimeHome.length > 0) {
		dirs.push({ kind: "runtime", path: resolve(runtimeHome, "agentbridge") });
	}
	return dirs;
}

async function cliCaller(cwd: string): Promise<CallerContext> {
	let root: string;
	try {
		root = await realpath(cwd);
	} catch {
		root = resolve(cwd);
	}
	const git = await gitInfo(root);
	const caller: CallerContext = {
		peer: { agent: "claude-code", sessionId: `cli-${process.pid}`, pid: process.pid },
		root,
		caseInsensitive: process.platform === "win32",
	};
	if (git?.worktree !== undefined) caller.worktree = git.worktree;
	if (git?.commonDir !== undefined) caller.commonDir = git.commonDir;
	return caller;
}

/** `path:start-end`; anything else is a plain path. */
export function parseFileSpec(spec: string): IncludeFileInput {
	const ranged = /^(.*):(\d+)-(\d+)$/.exec(spec);
	if (ranged !== null) {
		const path = ranged[1] ?? "";
		const start = Number(ranged[2]);
		const end = Number(ranged[3]);
		if (path.length > 0 && Number.isInteger(start) && Number.isInteger(end)) {
			return { path, startLine: start, endLine: end };
		}
	}
	return { path: spec };
}

export interface ParsedCommand {
	positional: string[];
	flags: Map<string, string[]>;
	noStream: boolean;
	json: boolean;
}

export function parseCommand(argv: string[]): ParsedCommand {
	const parsed: ParsedCommand = { positional: [], flags: new Map(), noStream: false, json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--no-stream") {
			parsed.noStream = true;
			continue;
		}
		if (arg === "--scope" || arg === "--target" || arg === "--file") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`Thiếu giá trị cho ${arg}`);
			const list = parsed.flags.get(arg) ?? [];
			list.push(value);
			parsed.flags.set(arg, list);
			index += 1;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`Tham số không hỗ trợ: ${arg}`);
		parsed.positional.push(arg);
	}
	return parsed;
}

function singleFlag(parsed: ParsedCommand, name: string): string | undefined {
	const values = parsed.flags.get(name);
	if (values === undefined) return undefined;
	if (values.length > 1) throw new Error(`${name} chỉ được dùng một lần`);
	return values[0];
}

function scopeFlag(parsed: ParsedCommand): Scope {
	const value = singleFlag(parsed, "--scope") ?? "repo";
	if (value !== "worktree" && value !== "repo" && value !== "all") {
		throw new Error(`--scope phải là worktree, repo hoặc all (nhận: ${value})`);
	}
	return value;
}

function includeFiles(parsed: ParsedCommand): IncludeFileInput[] {
	return (parsed.flags.get("--file") ?? []).map(parseFileSpec);
}

async function runList(parsed: ParsedCommand, io: CliIO): Promise<number> {
	const scope = scopeFlag(parsed);
	if (parsed.positional.length > 0) throw new Error("ab list không nhận tham số vị trí");
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller, { fetchStatus: true });
	const scoped = filterByScope(views, caller, scope);
	if (parsed.json) line(io, JSON.stringify(scoped.map(sessionJson), null, 2));
	else line(io, formatSessionTable(scoped));
	return 0;
}

async function runStatus(parsed: ParsedCommand, io: CliIO): Promise<number> {
	if (parsed.positional.length > 1) throw new Error("ab status nhận tối đa một target");
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller);
	const selected = resolveTarget(caller, views, parsed.positional[0]);
	const status = await statusOf(caller, selected.record);
	line(io, formatStatus(selected, status));
	return 0;
}

async function runConsult(parsed: ParsedCommand, io: CliIO): Promise<number> {
	const question = parsed.positional.join(" ").trim();
	if (question.length === 0) throw new Error('ab consult cần câu hỏi: ab consult "<question>"');
	const target = singleFlag(parsed, "--target");
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller);
	const attachments = await readIncludeFiles(caller.root, includeFiles(parsed), caller.caseInsensitive);
	const stream = !parsed.noStream;

	let wroteDelta = false;
	const { record, result } = await consultTarget(caller, views, target, question, attachments, {
		timeoutMs: 600_000,
		stream,
		onProgress: (progress) => {
			if (progress.phase === "awaiting_consent") {
				line(io, MCP_MESSAGES.awaitingConsent, "stderr");
				return;
			}
			if (progress.phase === "delta" && progress.delta !== undefined && progress.delta.length > 0 && stream) {
				io.stdout(progress.delta);
				wroteDelta = true;
			}
		},
	});

	if (stream) {
		if (wroteDelta) io.stdout("\n");
		line(io, formatConsultHeader(record, result));
	} else {
		line(io, formatConsultResult(record, result));
	}
	return 0;
}

async function runChat(parsed: ParsedCommand, io: CliIO): Promise<number> {
	const message = parsed.positional.join(" ").trim();
	if (message.length === 0) throw new Error('ab chat cần tin nhắn: ab chat "<message>"');
	if (parsed.json) throw new Error("ab chat không hỗ trợ --json");
	const target = singleFlag(parsed, "--target");
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller);
	const { record, result } = await chatTarget(caller, views, target, message, {
		timeoutMs: 600_000,
		onProgress: (progress) => {
			if (progress.phase === "awaiting_consent") line(io, MCP_MESSAGES.awaitingConsent, "stderr");
		},
	});
	line(io, formatChatResult(record, result));
	return 0;
}

export interface InstalledPluginRecord {
	id: string;
	name: string;
	marketplace: string;
	scope?: string;
	installPath?: string;
	version?: string;
	enabled: boolean;
}

export interface ListedPluginRecord extends InstalledPluginRecord {
	mcpServers: string[];
}

export interface ClaudePluginState {
	source: "registry" | "cli" | "none";
	installed: boolean;
	enabled: boolean;
	id?: string;
	installPath?: string;
	mcpRegistered: boolean;
	mcpKnown: boolean;
}

export interface OmpPluginPackage {
	name?: string;
	version?: string;
	manifestName?: string;
	extensions: string[];
}

export interface OmpPluginState {
	installed: boolean;
	enabled: boolean;
	name?: string;
	version?: string;
	path?: string;
	hasExtension: boolean;
}

const CLAUDE_PLUGIN_LIST_TIMEOUT_MS = 3_000;

function splitPluginId(id: string): { name: string; marketplace: string } {
	const at = id.lastIndexOf("@");
	return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

function isAgentBridgePluginName(name: string): boolean {
	const base = name.slice(name.lastIndexOf("/") + 1);
	return base.toLowerCase() === "agentbridge";
}

/**
 * Claude Code and OMP both store plugin registries as
 * `{version, plugins: {"<plugin>@<marketplace>": [entry, ...]}}`.
 * Entries carry `scope`, `installPath`, `version` and optionally `enabled`.
 */
export function parseInstalledPluginsJson(raw: string): InstalledPluginRecord[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.version !== "number" || !isRecord(parsed.plugins)) return undefined;
	const records: InstalledPluginRecord[] = [];
	for (const [id, value] of Object.entries(parsed.plugins)) {
		const entries: unknown[] = Array.isArray(value) ? value : [value];
		for (const entry of entries) {
			if (!isRecord(entry)) continue;
			const { name, marketplace } = splitPluginId(id);
			const record: InstalledPluginRecord = { id, name, marketplace, enabled: entry.enabled !== false };
			if (typeof entry.scope === "string") record.scope = entry.scope;
			if (typeof entry.installPath === "string") record.installPath = entry.installPath;
			if (typeof entry.version === "string") record.version = entry.version;
			records.push(record);
		}
	}
	return records;
}

/** `claude plugin list --json` is an array; `mcpServers` is inline or read from `.mcp.json`. */
export function parsePluginListJson(raw: string): ListedPluginRecord[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const records: ListedPluginRecord[] = [];
	for (const item of parsed) {
		if (!isRecord(item) || typeof item.id !== "string") continue;
		const { name, marketplace } = splitPluginId(item.id);
		const record: ListedPluginRecord = {
			id: item.id,
			name,
			marketplace,
			enabled: item.enabled !== false,
			mcpServers: isRecord(item.mcpServers) ? Object.keys(item.mcpServers) : [],
		};
		if (typeof item.scope === "string") record.scope = item.scope;
		if (typeof item.installPath === "string") record.installPath = item.installPath;
		if (typeof item.version === "string") record.version = item.version;
		records.push(record);
	}
	return records;
}

async function readPluginMcpServerNames(installPath: string | undefined): Promise<string[] | undefined> {
	if (installPath === undefined) return undefined;
	const files = [join(installPath, ".mcp.json"), join(installPath, ".claude-plugin", "plugin.json")];
	const names = new Set<string>();
	let sawConfig = false;
	for (const file of files) {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (isRecord(parsed.mcpServers)) {
			sawConfig = true;
			for (const name of Object.keys(parsed.mcpServers)) names.add(name);
			continue;
		}
		// Claude plugin `.mcp.json` is a direct server map; plugin.json uses mcpServers.
		if (file.endsWith(".mcp.json")) {
			sawConfig = true;
			for (const name of Object.keys(parsed)) {
				if (!name.startsWith("$")) names.add(name);
			}
		}
	}
	return sawConfig ? [...names] : undefined;
}

async function runClaudePluginListJson(): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["claude", "plugin", "list", "--json"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			env: process.env,
		});
		const timer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// already exited
			}
		}, CLAUDE_PLUGIN_LIST_TIMEOUT_MS);
		try {
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return exitCode === 0 ? stdout : undefined;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return undefined;
	}
}

/** Prefer the installed_plugins.json registry; fall back to the read-only CLI when it is missing/unreadable. */
export async function detectClaudePlugin(home: string): Promise<ClaudePluginState> {
	const registryPath = join(home, ".claude", "plugins", "installed_plugins.json");
	let registryMatch: InstalledPluginRecord | undefined;
	try {
		const records = parseInstalledPluginsJson(await readFile(registryPath, "utf8"));
		if (records !== undefined) {
			const matches = records.filter((record) => isAgentBridgePluginName(record.name));
			if (matches.length === 0) {
				return { source: "registry", installed: false, enabled: false, mcpRegistered: false, mcpKnown: false };
			}
			const chosen = matches.find((record) => record.enabled) ?? matches[0];
			if (chosen !== undefined) {
				const servers = await readPluginMcpServerNames(chosen.installPath);
				if (servers !== undefined) {
					const state: ClaudePluginState = {
						source: "registry",
						installed: true,
						enabled: chosen.enabled,
						id: chosen.id,
						mcpRegistered: servers.includes("agentbridge"),
						mcpKnown: true,
					};
					if (chosen.installPath !== undefined) state.installPath = chosen.installPath;
					return state;
				}
				registryMatch = chosen;
			}
		}
	} catch {
		// Missing/unreadable registry: try the CLI.
	}

	const listed = parsePluginListJson((await runClaudePluginListJson()) ?? "");
	if (listed !== undefined) {
		const matches = listed.filter((record) => isAgentBridgePluginName(record.name));
		const chosen = matches.find((record) => record.enabled) ?? matches[0];
		if (chosen !== undefined) {
			const state: ClaudePluginState = {
				source: "cli",
				installed: true,
				enabled: chosen.enabled,
				id: chosen.id,
				mcpRegistered: chosen.mcpServers.includes("agentbridge"),
				mcpKnown: true,
			};
			if (chosen.installPath !== undefined) state.installPath = chosen.installPath;
			return state;
		}
		if (registryMatch === undefined) {
			return { source: "cli", installed: false, enabled: false, mcpRegistered: false, mcpKnown: false };
		}
	}

	if (registryMatch !== undefined) {
		const state: ClaudePluginState = {
			source: "registry",
			installed: true,
			enabled: registryMatch.enabled,
			id: registryMatch.id,
			mcpRegistered: false,
			mcpKnown: false,
		};
		if (registryMatch.installPath !== undefined) state.installPath = registryMatch.installPath;
		return state;
	}
	return { source: "none", installed: false, enabled: false, mcpRegistered: false, mcpKnown: false };
}

/**
 * OMP plugin packages are npm packages under `~/.omp/plugins/node_modules/`
 * (marketplace installs link the cached plugin there) with an `omp` or `pi`
 * manifest in package.json. `extensions` names the loadable extension entries.
 */
export function parseOmpPluginPackage(raw: string): OmpPluginPackage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const manifest = isRecord(parsed.omp) ? parsed.omp : isRecord(parsed.pi) ? parsed.pi : undefined;
	if (manifest === undefined) return undefined;
	const pkg: OmpPluginPackage = { extensions: [] };
	if (typeof parsed.name === "string") pkg.name = parsed.name;
	if (typeof parsed.version === "string") pkg.version = parsed.version;
	if (typeof manifest.name === "string") pkg.manifestName = manifest.name;
	if (Array.isArray(manifest.extensions)) {
		pkg.extensions = manifest.extensions.filter((value): value is string => typeof value === "string");
	}
	return pkg;
}

function isAgentBridgeOmpPackage(pkg: OmpPluginPackage): boolean {
	return (
		(pkg.manifestName !== undefined && isAgentBridgePluginName(pkg.manifestName)) ||
		(pkg.name !== undefined && isAgentBridgePluginName(pkg.name))
	);
}

async function readOmpPackage(file: string): Promise<OmpPluginPackage | undefined> {
	try {
		return parseOmpPluginPackage(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

async function listOmpPackageDirs(nodeModules: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(nodeModules, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = join(nodeModules, entry.name);
		if (entry.name.startsWith("@")) {
			try {
				for (const child of await readdir(full, { withFileTypes: true })) {
					if (child.isDirectory() || child.isSymbolicLink()) dirs.push(join(full, child.name));
				}
			} catch {
				// unreadable scope
			}
		} else if (entry.isDirectory() || entry.isSymbolicLink()) {
			dirs.push(full);
		}
	}
	return dirs;
}

async function readOmpPluginEnabled(pluginsRoot: string): Promise<Map<string, boolean>> {
	const enabled = new Map<string, boolean>();
	try {
		const parsed: unknown = JSON.parse(await readFile(join(pluginsRoot, "omp-plugins.lock.json"), "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.plugins)) return enabled;
		for (const [name, value] of Object.entries(parsed.plugins)) {
			if (isRecord(value) && typeof value.enabled === "boolean") enabled.set(name, value.enabled);
		}
	} catch {
		// missing/unreadable lock: plugins default to enabled
	}
	return enabled;
}

/** OMP marketplace installs live in installed_plugins.json + a node_modules link; npm/link installs only have the link. */
export async function detectOmpPlugin(home: string): Promise<OmpPluginState> {
	const pluginsRoot = join(home, ".omp", "plugins");
	const candidates: Array<{ path: string; pkg: OmpPluginPackage }> = [];
	for (const dir of await listOmpPackageDirs(join(pluginsRoot, "node_modules"))) {
		const pkg = await readOmpPackage(join(dir, "package.json"));
		if (pkg !== undefined && isAgentBridgeOmpPackage(pkg)) candidates.push({ path: dir, pkg });
	}
	if (candidates.length === 0) {
		try {
			const records = parseInstalledPluginsJson(
				await readFile(join(pluginsRoot, "installed_plugins.json"), "utf8"),
			);
			for (const record of records ?? []) {
				if (!isAgentBridgePluginName(record.name) || record.installPath === undefined) continue;
				const pkg = await readOmpPackage(join(record.installPath, "package.json"));
				if (pkg !== undefined && isAgentBridgeOmpPackage(pkg)) {
					candidates.push({ path: record.installPath, pkg });
				}
			}
		} catch {
			// no registry: npm/link installs are already covered by node_modules
		}
	}
	if (candidates.length === 0) return { installed: false, enabled: false, hasExtension: false };

	const enabledMap = await readOmpPluginEnabled(pluginsRoot);
	const chosen = candidates.find((candidate) => enabledMap.get(candidate.pkg.name ?? "") !== false) ?? candidates[0];
	if (chosen === undefined) return { installed: false, enabled: false, hasExtension: false };
	const state: OmpPluginState = {
		installed: true,
		enabled: enabledMap.get(chosen.pkg.name ?? "") !== false,
		path: chosen.path,
		hasExtension: chosen.pkg.extensions.length > 0,
	};
	if (chosen.pkg.name !== undefined) state.name = chosen.pkg.name;
	if (chosen.pkg.version !== undefined) state.version = chosen.pkg.version;
	return state;
}

interface DoctorCheck {
	status: "ok" | "warn" | "fail";
	label: string;
	detail?: string;
}

async function secureDirCheck(label: string, path: string): Promise<DoctorCheck> {
	if (!existsSync(path)) return { status: "warn", label, detail: `${path} chưa tồn tại (OMP chưa chạy?)` };
	try {
		await assertSecureDir(path);
		return { status: "ok", label, detail: path };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { status: "fail", label, detail };
	}
}

async function mcpRegistration(file: string): Promise<"yes" | "no" | "unreadable" | "missing"> {
	if (!existsSync(file)) return "missing";
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!isRecord(parsed)) return "unreadable";
		const servers = parsed.mcpServers;
		if (!isRecord(servers)) return "no";
		return Object.hasOwn(servers, "agentbridge") ? "yes" : "no";
	} catch {
		return "unreadable";
	}
}

/** Local scope lives in `~/.claude.json` at `projects[<project path>].mcpServers`; read only that key. */
async function localMcpRegistration(file: string, cwd: string): Promise<"yes" | "no" | "unreadable" | "missing"> {
	if (!existsSync(file)) return "missing";
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return "unreadable";
	}
	if (!isRecord(parsed)) return "unreadable";
	const projects = parsed.projects;
	if (!isRecord(projects)) return "no";

	const keys = new Set<string>([cwd, resolve(cwd)]);
	try {
		keys.add(await realpath(cwd));
	} catch {
		// cwd may have been removed; exact keys are still worth checking.
	}
	for (const key of keys) {
		const entry = projects[key];
		if (!isRecord(entry)) continue;
		const servers = entry.mcpServers;
		if (isRecord(servers) && Object.hasOwn(servers, "agentbridge")) return "yes";
	}
	return "no";
}

/** T4 in research 08: OMP loads `.omp/extensions/*` from the repo without asking. */
async function projectExtensionCheck(cwd: string): Promise<DoctorCheck | undefined> {
	const dir = join(cwd, ".omp", "extensions");
	let matches: string[];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		matches = entries
			.filter((entry) => /agentbridge/i.test(entry.name))
			.map((entry) => join(dir, entry.name))
			.sort();
	} catch {
		return undefined;
	}
	if (matches.length === 0) return undefined;
	return {
		status: "warn",
		label: "extension cấp project",
		detail: `${matches.join(", ")} — OMP nạp extension trong repo mà không hỏi; xóa file này và chỉ dùng bản ở ~/.omp/agent/extensions`,
	};
}

async function runDoctor(parsed: ParsedCommand, io: CliIO): Promise<number> {
	if (parsed.positional.length > 0) throw new Error("ab doctor không nhận tham số");
	const checks: DoctorCheck[] = [];
	const home = homeDirectory();
	const dirs = resolveDirs(process.env, process.platform, home);

	line(io, "Đường dẫn đang dùng:");
	line(io, `  config file: ${dirs.configFile}`);
	line(io, `  state dir:   ${dirs.stateDir}`);
	line(io, `  runtime dir: ${dirs.runtimeDir}`);
	line(io, "");

	checks.push({ status: "ok", label: "bun", detail: Bun.version });

	for (const binary of ["claude", "omp"]) {
		const found = Bun.which(binary);
		checks.push(
			found === null
				? { status: "warn", label: binary, detail: "không thấy trong PATH" }
				: { status: "ok", label: binary, detail: found },
		);
	}

	checks.push(await secureDirCheck("runtime dir", dirs.runtimeDir));
	checks.push(await secureDirCheck("sessions dir", dirs.sessionsDir));

	const legacy = legacyXdgDirs(process.env, home).filter((entry) => existsSync(entry.path));
	if (legacy.length > 0) {
		const listing = legacy.map((entry) => `${entry.path} (${entry.kind})`).join(", ");
		checks.push({
			status: "warn",
			label: "thư mục legacy XDG",
			detail: `${listing} vẫn tồn tại — đây là đường dẫn legacy, không còn là mặc định và không được tự di chuyển; chuyển config/state vào ${dirs.homeDir} hoặc đặt AGENTBRIDGE_HOME`,
		});
	}
	if (!existsSync(dirs.configFile)) {
		checks.push({
			status: "warn",
			label: "config",
			detail: `${dirs.configFile} chưa có (mặc định an toàn: projects = [])`,
		});
	} else {
		try {
			JSON.parse(await readFile(dirs.configFile, "utf8"));
			const config = await loadConfig(dirs.configFile);
			checks.push({ status: "ok", label: "config", detail: `${config.projects.length} project được phép` });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			checks.push({ status: "fail", label: "config", detail });
		}
	}

	const [claudePlugin, ompPlugin] = await Promise.all([detectClaudePlugin(home), detectOmpPlugin(home)]);

	const extension = join(home, ".omp", "agent", "extensions", "agentbridge.js");
	const extensionExists = existsSync(extension);
	if (extensionExists) {
		checks.push({ status: "ok", label: "extension OMP (dev)", detail: extension });
	} else if (ompPlugin.installed) {
		const name = ompPlugin.name ?? "agentbridge";
		checks.push({
			status: ompPlugin.enabled ? "ok" : "warn",
			label: "extension OMP",
			detail: ompPlugin.enabled ? `do OMP plugin ${name} cung cấp` : `OMP plugin ${name} đang tắt`,
		});
	} else {
		checks.push({ status: "warn", label: "extension OMP", detail: `chưa cài tại ${extension}` });
	}

	const projectExtension = await projectExtensionCheck(io.cwd);
	if (projectExtension !== undefined) checks.push(projectExtension);

	const userConfig = join(home, ".claude.json");
	const projectConfig = join(io.cwd, ".mcp.json");
	const [userRegistration, localRegistration, projectRegistration] = await Promise.all([
		mcpRegistration(userConfig),
		localMcpRegistration(userConfig, io.cwd),
		mcpRegistration(projectConfig),
	]);
	const registrations = [
		{ scope: "user", file: userConfig, state: userRegistration },
		{ scope: "local", file: userConfig, state: localRegistration },
		{ scope: "project", file: projectConfig, state: projectRegistration },
	];
	const registered = registrations.filter((item) => item.state === "yes");
	if (registered.length > 0) {
		const where = registered.map((item) => `${item.scope}: ${item.file}`).join("; ");
		checks.push({ status: "ok", label: "MCP agentbridge", detail: `đã đăng ký thủ công (${where})` });
	} else if (claudePlugin.installed && claudePlugin.enabled && claudePlugin.mcpRegistered) {
		checks.push({
			status: "ok",
			label: "MCP agentbridge",
			detail: `do Claude plugin ${claudePlugin.id ?? "agentbridge@agentbridge"} cung cấp`,
		});
	} else if (registrations.some((item) => item.state === "unreadable")) {
		checks.push({ status: "warn", label: "MCP agentbridge", detail: "không đọc được file cấu hình Claude" });
	} else {
		checks.push({
			status: "warn",
			label: "MCP agentbridge",
			detail:
				"chưa đăng ký; cài `claude plugin install agentbridge@agentbridge` hoặc chạy `bun scripts/install.ts --apply` (dev)",
		});
	}

	if (claudePlugin.installed) {
		const id = claudePlugin.id ?? "agentbridge@agentbridge";
		const commands = `cập nhật: claude plugin update ${id}; gỡ: claude plugin uninstall ${id}`;
		if (!claudePlugin.enabled) {
			checks.push({
				status: "warn",
				label: "Claude plugin AgentBridge",
				detail: `${id} đang tắt; bật: claude plugin enable ${id}`,
			});
		} else if (!claudePlugin.mcpKnown) {
			checks.push({
				status: "warn",
				label: "Claude plugin AgentBridge",
				detail: `${id} đã cài nhưng không đọc được .mcp.json để xác minh MCP; ${commands}`,
			});
		} else if (!claudePlugin.mcpRegistered) {
			checks.push({
				status: "warn",
				label: "Claude plugin AgentBridge",
				detail: `${id} không khai báo MCP server agentbridge; ${commands}`,
			});
		} else {
			checks.push({
				status: "ok",
				label: "Claude plugin AgentBridge",
				detail: `${id} — MCP: agentbridge${claudePlugin.installPath === undefined ? "" : ` (${claudePlugin.installPath})`}; ${commands}`,
			});
		}
	}

	if (ompPlugin.installed) {
		const name = ompPlugin.name ?? "agentbridge";
		const commands = `cập nhật: omp plugin upgrade ${name}; gỡ: omp plugin uninstall ${name}`;
		if (!ompPlugin.enabled) {
			checks.push({
				status: "warn",
				label: "OMP plugin AgentBridge",
				detail: `${name} đang tắt; bật: omp plugin enable ${name}`,
			});
		} else if (!ompPlugin.hasExtension) {
			checks.push({
				status: "warn",
				label: "OMP plugin AgentBridge",
				detail: `${name} không khai báo extension OMP trong package.json; ${commands}`,
			});
		} else {
			const version = ompPlugin.version === undefined ? "" : ` ${ompPlugin.version}`;
			checks.push({
				status: "ok",
				label: "OMP plugin AgentBridge",
				detail: `${name}${version}${ompPlugin.path === undefined ? "" : ` (${ompPlugin.path})`}; ${commands}`,
			});
		}
	}

	if (extensionExists && ompPlugin.installed) {
		checks.push({
			status: "warn",
			label: "trùng cách cài AgentBridge",
			detail: `có cả extension dev ${extension} và OMP plugin ${ompPlugin.name ?? "agentbridge"}; gỡ một bên: \`bun scripts/install.ts --uninstall\` hoặc \`omp plugin uninstall ${ompPlugin.name ?? "agentbridge"}\``,
		});
	}
	if (registered.length > 0 && claudePlugin.installed) {
		const manual = registered.map((item) => item.scope).join(", ");
		checks.push({
			status: "warn",
			label: "trùng cách cài AgentBridge",
			detail: `MCP agentbridge đăng ký thủ công (${manual}) và Claude plugin ${claudePlugin.id ?? "agentbridge@agentbridge"}; gỡ một bên: \`claude mcp remove -s <scope> agentbridge\` hoặc \`claude plugin uninstall ${claudePlugin.id ?? "agentbridge@agentbridge"}\``,
		});
	}

	for (const check of checks) {
		const marker = check.status === "ok" ? "[ok]" : check.status === "warn" ? "[warn]" : "[fail]";
		line(io, `${marker} ${check.label}${check.detail === undefined ? "" : ` — ${check.detail}`}`);
	}
	return checks.some((check) => check.status === "fail") ? 1 : 0;
}

async function runSweep(parsed: ParsedCommand, io: CliIO): Promise<number> {
	if (parsed.positional.length > 0) throw new Error("ab sweep không nhận tham số");
	const removed = await sweepStale();
	line(io, `Đã dọn ${removed} bản ghi stale.`);
	return 0;
}

export async function runCli(argv: string[], overrides: Partial<CliIO> = {}): Promise<number> {
	const io: CliIO = { ...defaultIO(), ...overrides };
	const command = argv[0];
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		line(io, CLI_USAGE);
		return command === undefined ? 2 : 0;
	}

	let parsed: ParsedCommand;
	try {
		parsed = parseCommand(argv.slice(1));
	} catch (error) {
		line(io, failureFrom(error).detail ?? String(error), "stderr");
		return 2;
	}

	try {
		switch (command) {
			case "list":
				return await runList(parsed, io);
			case "status":
				return await runStatus(parsed, io);
			case "consult":
				return await runConsult(parsed, io);
			case "chat":
				return await runChat(parsed, io);
			case "doctor":
				return await runDoctor(parsed, io);
			case "sweep":
				return await runSweep(parsed, io);
			default:
				line(io, `Lệnh không hỗ trợ: ${command}`, "stderr");
				line(io, CLI_USAGE, "stderr");
				return 2;
		}
	} catch (error) {
		line(io, formatFailure(failureFrom(error)), "stderr");
		return 1;
	}
}

if (import.meta.main) {
	runCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			process.stderr.write(`${failureFrom(error).message}\n`);
			process.exitCode = 1;
		});
}
