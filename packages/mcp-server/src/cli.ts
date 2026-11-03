#!/usr/bin/env bun
/** Debug CLI `ab`. Spec: 01 §8.5. Never writes stdout for the MCP server; this is a human tool. */
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertSecureDir, gitInfo, readConfigStrict, resolveDirs, sweepStale } from "@agentbridge/core";
import { isRecord, sanitizeText } from "@agentbridge/protocol";
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
import { CLI_MESSAGES, CLI_USAGE, MCP_MESSAGES } from "./messages";

export interface CliIO {
	stdout(text: string): void;
	stderr(text: string): void;
	cwd: string;
}

function defaultIO(cwd?: string): CliIO {
	return {
		stdout: (text) => {
			process.stdout.write(text);
		},
		stderr: (text) => {
			process.stderr.write(text);
		},
		cwd: cwd ?? process.cwd(),
	};
}

/** Consult/chat transport budget; matches the MCP tools' default `timeout_s`. */
const CLI_TIMEOUT_MS = 600_000;

function line(io: CliIO, text: string, stream: "stdout" | "stderr" = "stdout"): void {
	io[stream](text.endsWith("\n") ? text : `${text}\n`);
}

/** `homedir()` caches at startup under Bun; HOME/USERPROFILE must win for `ab doctor` overrides. */
function homeDirectory(): string {
	const envHome = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	// Same rule as core `resolveDirs`: an empty HOME is ignored.
	return envHome !== undefined && envHome.length > 0 ? envHome : homedir();
}

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.length > 0 ? value : undefined;
}

/** OMP 18.14: `path.join(homedir, PI_CONFIG_DIR || ".omp")` — always below home (mirrors scripts/install.ts). */
function ompConfigRoot(home: string): string {
	return join(home, nonEmpty(process.env.PI_CONFIG_DIR) ?? ".omp");
}

/** A profile selects `<root>/profiles/<name>/agent` and ignores `PI_CODING_AGENT_DIR`. */
function ompAgentDir(home: string): string {
	const profile = nonEmpty(process.env.OMP_PROFILE) ?? nonEmpty(process.env.PI_PROFILE);
	if (profile !== undefined) return join(ompConfigRoot(home), "profiles", profile, "agent");
	const agentDir = nonEmpty(process.env.PI_CODING_AGENT_DIR);
	return agentDir !== undefined ? resolve(agentDir) : join(ompConfigRoot(home), "agent");
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

/** A usage mistake: printed as-is with exit code 2, never reported as an internal error. */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export interface ParsedCommand {
	positional: string[];
	flags: Map<string, string[]>;
	noStream: boolean;
	json: boolean;
	help: boolean;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--scope", "--target", "--file"]);
/** `-x`, `--name`, `--name=value`. Prose such as "- liệt kê" or "-5 độ" is text, not a flag. */
const FLAG_LIKE = /^--?[A-Za-z][\w-]*(?:=.*)?$/;

/**
 * `--flag value` and `--flag=value`; `--` ends options; `-h`/`--help` anywhere
 * asks for usage. Any other flag-shaped token is an error instead of becoming
 * message text, and a value never swallows the next flag.
 */
export function parseCommand(argv: string[]): ParsedCommand {
	const parsed: ParsedCommand = { positional: [], flags: new Map(), noStream: false, json: false, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--") {
			parsed.positional.push(...argv.slice(index + 1));
			break;
		}
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--no-stream") {
			parsed.noStream = true;
			continue;
		}
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = equals > 0 ? arg.slice(0, equals) : arg;
		if (VALUE_FLAGS.has(name)) {
			let value: string | undefined;
			if (equals > 0) {
				value = arg.slice(equals + 1);
			} else {
				const next = argv[index + 1];
				if (next !== undefined && next !== "--" && !FLAG_LIKE.test(next)) {
					value = next;
					index += 1;
				}
			}
			if (value === undefined || value.length === 0) throw new UsageError(CLI_MESSAGES.missingValue(name));
			const list = parsed.flags.get(name) ?? [];
			list.push(value);
			parsed.flags.set(name, list);
			continue;
		}
		if (FLAG_LIKE.test(arg)) throw new UsageError(CLI_MESSAGES.unsupportedFlag(arg));
		parsed.positional.push(arg);
	}
	return parsed;
}

/** Reject flags that the command would otherwise silently ignore. */
function allowFlags(parsed: ParsedCommand, command: string, allowed: readonly string[]): void {
	const present = [...parsed.flags.keys()];
	if (parsed.json) present.push("--json");
	if (parsed.noStream) present.push("--no-stream");
	for (const flag of present) {
		if (!allowed.includes(flag)) throw new UsageError(CLI_MESSAGES.flagNotForCommand(command, flag));
	}
}

function singleFlag(parsed: ParsedCommand, name: string): string | undefined {
	const values = parsed.flags.get(name);
	if (values === undefined) return undefined;
	if (values.length > 1) throw new UsageError(CLI_MESSAGES.flagOnce(name));
	return values[0];
}

function scopeFlag(parsed: ParsedCommand): Scope {
	const value = singleFlag(parsed, "--scope") ?? "repo";
	if (value !== "worktree" && value !== "repo" && value !== "all") {
		throw new UsageError(CLI_MESSAGES.badScope(value));
	}
	return value;
}

function includeFiles(parsed: ParsedCommand): IncludeFileInput[] {
	return (parsed.flags.get("--file") ?? []).map(parseFileSpec);
}

async function runList(parsed: ParsedCommand, io: CliIO): Promise<number> {
	allowFlags(parsed, "list", ["--scope", "--json"]);
	const scope = scopeFlag(parsed);
	if (parsed.positional.length > 0) throw new UsageError(CLI_MESSAGES.listNoPositional);
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller, { fetchStatus: true });
	const scoped = filterByScope(views, caller, scope);
	if (parsed.json) line(io, JSON.stringify(scoped.map(sessionJson), null, 2));
	else line(io, formatSessionTable(scoped));
	return 0;
}

async function runStatus(parsed: ParsedCommand, io: CliIO): Promise<number> {
	allowFlags(parsed, "status", ["--target"]);
	if (parsed.positional.length > 1) throw new UsageError(CLI_MESSAGES.statusOneTarget);
	const flagTarget = singleFlag(parsed, "--target");
	if (flagTarget !== undefined && parsed.positional.length > 0) throw new UsageError(CLI_MESSAGES.statusTargetTwice);
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller);
	const selected = resolveTarget(caller, views, flagTarget ?? parsed.positional[0]);
	const status = await statusOf(caller, selected.record);
	line(io, formatStatus(selected, status));
	return 0;
}

async function runConsult(parsed: ParsedCommand, io: CliIO): Promise<number> {
	allowFlags(parsed, "consult", ["--target", "--file", "--no-stream"]);
	const question = parsed.positional.join(" ").trim();
	if (question.length === 0) throw new UsageError(CLI_MESSAGES.consultNeedsQuestion);
	const target = singleFlag(parsed, "--target");
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller);
	const attachments = await readIncludeFiles(caller.root, includeFiles(parsed), caller.caseInsensitive);
	const stream = !parsed.noStream;

	// Deltas are a live preview; the reply in the result is authoritative.
	let streamed = "";
	const { record, result } = await consultTarget(caller, views, target, question, attachments, {
		timeoutMs: CLI_TIMEOUT_MS,
		stream,
		onProgress: (progress) => {
			if (progress.phase === "awaiting_consent") {
				line(io, MCP_MESSAGES.awaitingConsent, "stderr");
				return;
			}
			if (!stream || progress.phase !== "delta" || progress.delta === undefined) return;
			const delta = sanitizeText(progress.delta);
			if (delta.length === 0) return;
			io.stdout(delta);
			streamed += delta;
		},
	});

	if (!stream) {
		line(io, formatConsultResult(record, result));
		return 0;
	}
	const reply = sanitizeText(result.replyText);
	if (reply.startsWith(streamed)) {
		// The host never streams an unterminated last line: print what is missing.
		const tail = reply.slice(streamed.length);
		if (tail.length > 0) io.stdout(tail);
		if (reply.length > 0 && !reply.endsWith("\n")) io.stdout("\n");
	} else {
		// Dedupe, truncation or a muted key block changed the text: print it whole.
		if (streamed.length > 0 && !streamed.endsWith("\n")) io.stdout("\n");
		line(io, CLI_MESSAGES.fullReplyFollows);
		line(io, reply);
	}
	line(io, formatConsultHeader(record, result));
	return 0;
}

async function runChat(parsed: ParsedCommand, io: CliIO): Promise<number> {
	allowFlags(parsed, "chat", ["--target"]);
	const message = parsed.positional.join(" ").trim();
	if (message.length === 0) throw new UsageError(CLI_MESSAGES.chatNeedsMessage);
	const target = singleFlag(parsed, "--target");
	const caller = await cliCaller(io.cwd);
	const views = await collectSessions(caller);
	const { record, result } = await chatTarget(caller, views, target, message, {
		timeoutMs: CLI_TIMEOUT_MS,
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

export interface ClaudePluginState {
	/** `unknown`: the registry exists but cannot be read; doctor never spawns `claude` (01 §10). */
	source: "registry" | "unknown" | "none";
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

/**
 * Read `~/.claude/plugins/installed_plugins.json` only. Spec §10 forbids
 * spawning `claude` other than `claude agents --json`, and `claude plugin list`
 * can write files under HOME, so an unreadable registry is reported instead.
 */
export async function detectClaudePlugin(home: string): Promise<ClaudePluginState> {
	const absent: ClaudePluginState = { source: "none", installed: false, enabled: false, mcpRegistered: false, mcpKnown: false };
	const registryPath = join(home, ".claude", "plugins", "installed_plugins.json");
	let raw: string;
	try {
		raw = await readFile(registryPath, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? absent : { ...absent, source: "unknown" };
	}
	const records = parseInstalledPluginsJson(raw);
	if (records === undefined) return { ...absent, source: "unknown" };
	const matches = records.filter((record) => isAgentBridgePluginName(record.name));
	const chosen = matches.find((record) => record.enabled) ?? matches[0];
	if (chosen === undefined) return { ...absent, source: "registry" };
	const servers = await readPluginMcpServerNames(chosen.installPath);
	const state: ClaudePluginState = {
		source: "registry",
		installed: true,
		enabled: chosen.enabled,
		id: chosen.id,
		mcpRegistered: servers?.includes("agentbridge") ?? false,
		mcpKnown: servers !== undefined,
	};
	if (chosen.installPath !== undefined) state.installPath = chosen.installPath;
	return state;
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
	const pluginsRoot = join(ompConfigRoot(home), "plugins");
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

/** lstat-based: a symlink or foreign/loose directory fails like it does for the host. */
async function dirCheck(label: string, path: string, missingHint: string): Promise<DoctorCheck> {
	try {
		await assertSecureDir(path);
		return { status: "ok", label, detail: path };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "warn", label, detail: CLI_MESSAGES.dirMissing(path, missingHint) };
		}
		return { status: "fail", label, detail: error instanceof Error ? error.message : String(error) };
	}
}

/** Strict read: a schema error is a failure, not the loader's silent safe defaults. */
async function configChecks(configFile: string): Promise<DoctorCheck[]> {
	const read = await readConfigStrict(configFile);
	if (read.kind === "missing") {
		return [{ status: "warn", label: "config", detail: CLI_MESSAGES.configMissing(configFile) }];
	}
	if (read.kind === "invalid") {
		return [{ status: "fail", label: "config", detail: CLI_MESSAGES.configInvalid(configFile, read.reason) }];
	}
	const checks: DoctorCheck[] = [];
	const relative = read.config.projects.filter((project) => !isAbsolute(project));
	const missing: string[] = [];
	for (const project of read.config.projects) {
		if (!isAbsolute(project)) continue;
		try {
			await realpath(project);
		} catch {
			missing.push(project);
		}
	}
	const usable = read.config.projects.length - relative.length - missing.length;
	checks.push({ status: "ok", label: "config", detail: CLI_MESSAGES.configOk(usable) });
	if (relative.length > 0) {
		checks.push({ status: "warn", label: "config projects", detail: CLI_MESSAGES.relativeProjects(relative) });
	}
	if (missing.length > 0) {
		checks.push({ status: "warn", label: "config projects", detail: CLI_MESSAGES.missingProjects(missing) });
	}
	try {
		const info = await lstat(configFile);
		const uid = process.getuid?.();
		// Autochat and /agentbridge allow|disallow require exactly 0600, same uid, no symlink.
		if (info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid)) {
			checks.push({ status: "warn", label: "config permissions", detail: CLI_MESSAGES.configPermissions(configFile) });
		}
	} catch {
		// read succeeded a moment ago; a vanished file is reported on the next run
	}
	return checks;
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
	allowFlags(parsed, "doctor", []);
	if (parsed.positional.length > 0) throw new UsageError(CLI_MESSAGES.doctorNoArgs);
	const checks: DoctorCheck[] = [];
	const home = homeDirectory();
	const dirs = resolveDirs(process.env, process.platform, home);

	line(io, "Đường dẫn đang dùng:");
	line(io, `  config file: ${dirs.configFile}`);
	line(io, `  state dir:   ${dirs.stateDir}`);
	line(io, `  runtime dir: ${dirs.runtimeDir}`);
	line(io, "");

	checks.push(
		Bun.semver.satisfies(Bun.version, ">=1.4.0")
			? { status: "ok", label: "bun", detail: Bun.version }
			: { status: "warn", label: "bun", detail: CLI_MESSAGES.bunTooOld(Bun.version) },
	);

	for (const binary of ["claude", "omp"]) {
		const found = Bun.which(binary);
		checks.push(
			found === null
				? { status: "warn", label: binary, detail: "không thấy trong PATH" }
				: { status: "ok", label: binary, detail: found },
		);
	}

	// The host requires all four (core `ensureRuntimeDirs`); the state dir is created on first audit.
	// A missing runtime dir implies its children: report it once instead of three times.
	checks.push(await dirCheck("home dir", dirs.homeDir, CLI_MESSAGES.hintNotInstalled));
	const runtimeCheck = await dirCheck("runtime dir", dirs.runtimeDir, CLI_MESSAGES.hintOmpNotRunning);
	checks.push(runtimeCheck);
	if (runtimeCheck.status === "ok") {
		checks.push(await dirCheck("sessions dir", dirs.sessionsDir, CLI_MESSAGES.hintOmpNotRunning));
		checks.push(await dirCheck("socket dir", dirs.socketsDir, CLI_MESSAGES.hintOmpNotRunning));
	}
	// A missing state dir is normal until the first audit; anything present (even a dangling symlink) is checked.
	if (await lstat(dirs.stateDir).then(() => true, () => false)) {
		checks.push(await dirCheck("state dir", dirs.stateDir, CLI_MESSAGES.hintNoAudit));
	}

	const legacy = legacyXdgDirs(process.env, home).filter((entry) => existsSync(entry.path));
	if (legacy.length > 0) {
		const listing = legacy.map((entry) => `${entry.path} (${entry.kind})`).join(", ");
		checks.push({
			status: "warn",
			label: "thư mục legacy XDG",
			detail: `${listing} vẫn tồn tại — đây là đường dẫn legacy, không còn là mặc định và không được tự di chuyển; chuyển config/state vào ${dirs.homeDir} hoặc đặt AGENTBRIDGE_HOME`,
		});
	}
	checks.push(...(await configChecks(dirs.configFile)));

	const [claudePlugin, ompPlugin] = await Promise.all([detectClaudePlugin(home), detectOmpPlugin(home)]);

	const extension = join(ompAgentDir(home), "extensions", "agentbridge.js");
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

	if (claudePlugin.source === "unknown") {
		checks.push({ status: "warn", label: "Claude plugin AgentBridge", detail: CLI_MESSAGES.pluginRegistryUnreadable(home) });
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
	allowFlags(parsed, "sweep", []);
	if (parsed.positional.length > 0) throw new UsageError(CLI_MESSAGES.sweepNoArgs);
	const removed = await sweepStale();
	line(io, CLI_MESSAGES.swept(removed));
	return 0;
}

export async function runCli(argv: string[], overrides: Partial<CliIO> = {}): Promise<number> {
	let io: CliIO;
	try {
		io = { ...defaultIO(overrides.cwd), ...overrides };
	} catch (error) {
		// e.g. the working directory was deleted under the shell
		process.stderr.write(`${CLI_MESSAGES.noCwd(error instanceof Error ? error.message : String(error))}\n`);
		return 1;
	}
	const command = argv[0];
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		line(io, CLI_USAGE);
		return command === undefined ? 2 : 0;
	}

	let parsed: ParsedCommand;
	try {
		parsed = parseCommand(argv.slice(1));
	} catch (error) {
		line(io, error instanceof Error ? error.message : String(error), "stderr");
		return 2;
	}
	if (parsed.help) {
		line(io, CLI_USAGE);
		return 0;
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
				line(io, CLI_MESSAGES.unknownCommand(command), "stderr");
				line(io, CLI_USAGE, "stderr");
				return 2;
		}
	} catch (error) {
		if (error instanceof UsageError) {
			line(io, error.message, "stderr");
			return 2;
		}
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
