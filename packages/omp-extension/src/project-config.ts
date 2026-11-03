/** Secure project allowlist edits for `/agentbridge allow|disallow`. */
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	type Config,
	DEFAULT_CONFIG,
	ensureSecureDir,
	readConfigStrict,
	writeFileAtomic,
} from "@agentbridge/core";
import { isPathInside } from "./autochat";
import { CONFIG_TEXT } from "./messages";

export type ProjectAction = "allow" | "disallow";

export type ConfigInspection =
	| { kind: "missing"; configPath: string }
	| { kind: "invalid"; configPath: string; reason: string }
	| { kind: "insecure"; configPath: string; reason: string }
	| {
		kind: "ok";
		configPath: string;
		realPath: string;
		config: Config;
		raw: Record<string, unknown>;
	};

export type ProjectChangeResult =
	| { kind: "changed"; configPath: string; projects: string[] }
	| { kind: "unchanged"; configPath: string; projects: string[]; present: boolean }
	| { kind: "invalid"; configPath: string; reason: string }
	| { kind: "insecure"; configPath: string; reason: string }
	| { kind: "config_inside_project"; configPath: string; project: string; projects: string[] }
	| { kind: "write_failed"; configPath: string; reason: string };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Existing configs must be regular 0600 files owned by this user; missing is allowed. */
export async function inspectConfig(
	configPath: string,
	options: { requireSecureMode?: boolean } = {},
): Promise<ConfigInspection> {
	const path = resolve(configPath);
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", configPath: path };
		return { kind: "insecure", configPath: path, reason: errorText(error) };
	}
	if (info.isSymbolicLink() || !info.isFile()) {
		return { kind: "insecure", configPath: path, reason: CONFIG_TEXT.notRegularFile };
	}

	let realPath: string;
	try {
		realPath = await realpath(path);
	} catch (error) {
		return { kind: "insecure", configPath: path, reason: errorText(error) };
	}

	const read = await readConfigStrict(path);
	if (read.kind === "missing") return { kind: "missing", configPath: path };
	if (read.kind === "invalid") return { kind: "invalid", configPath: path, reason: read.reason };

	if (options.requireSecureMode !== false && process.platform !== "win32") {
		const uid = process.getuid?.();
		if (uid === undefined || info.uid !== uid || (info.mode & 0o777) !== 0o600) {
			return { kind: "insecure", configPath: path, reason: CONFIG_TEXT.badMode };
		}
	}
	return { kind: "ok", configPath: path, realPath, config: read.config, raw: read.raw };
}

/**
 * A config entry as the loader sees it: absolute entries are realpath-ed (a
 * missing path keeps its normalized form); relative entries are ignored by the
 * loader, so they never match a project.
 */
async function canonicalProject(entry: string): Promise<string | undefined> {
	if (!isAbsolute(entry)) return undefined;
	try {
		return await realpath(entry);
	} catch {
		return resolve(entry);
	}
}

/** Real path for a config that may not exist yet: canonicalize the parent. */
async function canonicalConfigPath(configPath: string): Promise<string> {
	try {
		return join(await realpath(dirname(configPath)), basename(configPath));
	} catch {
		return configPath;
	}
}

/** The autochat gate forbids keeping a config file inside any allowed project. */
async function firstContainingProject(configRealPath: string, projects: string[]): Promise<string | undefined> {
	for (const project of projects) {
		// The loader ignores relative entries; so does this check.
		if (!isAbsolute(project)) continue;
		let realProject: string;
		try {
			realProject = await realpath(project);
		} catch {
			realProject = resolve(project);
		}
		if (isPathInside(configRealPath, realProject)) return realProject;
	}
	return undefined;
}

/** Create a missing config parent as 0700; never follow a symlinked parent. */
async function ensureConfigParent(parent: string): Promise<void> {
	try {
		const info = await lstat(parent);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(CONFIG_TEXT.unsafeParent);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await ensureSecureDir(parent);
}

/**
 * Add/remove one canonical project while preserving every other config field
 * (including unknown keys). Invalid or insecure files are never overwritten.
 */
export async function changeProjectConfig(options: {
	action: ProjectAction;
	project: string;
	configPath: string;
	homeDir: string;
}): Promise<ProjectChangeResult> {
	const configPath = resolve(options.configPath);
	const inspected = await inspectConfig(configPath);
	if (inspected.kind === "invalid") {
		return { kind: "invalid", configPath, reason: inspected.reason };
	}
	if (inspected.kind === "insecure") {
		return { kind: "insecure", configPath, reason: inspected.reason };
	}

	// Compare entries the way the loader resolves them (realpath, no trailing
	// slash), so `disallow` also removes `/repo/` or a symlinked alias that would
	// otherwise keep the project allowed at runtime.
	const entries = inspected.kind === "ok" ? inspected.config.projects : [];
	const canonical = await Promise.all(entries.map(canonicalProject));
	const present = canonical.some((entry) => entry === options.project);
	if (options.action === "allow" && present) {
		return {
			kind: "unchanged",
			configPath,
			projects: entries,
			present: true,
		};
	}
	if (options.action === "disallow" && !present) {
		return {
			kind: "unchanged",
			configPath,
			projects: entries,
			present: false,
		};
	}

	const raw: Record<string, unknown> =
		inspected.kind === "ok" ? { ...inspected.raw } : { ...DEFAULT_CONFIG, projects: [] };
	const projects =
		options.action === "allow"
			? [...entries, options.project]
			: entries.filter((_, index) => canonical[index] !== options.project);

	const configRealPath =
		inspected.kind === "ok" ? inspected.realPath : await canonicalConfigPath(configPath);
	const containing = await firstContainingProject(configRealPath, projects);
	if (containing !== undefined) {
		return { kind: "config_inside_project", configPath, project: containing, projects };
	}

	try {
		await ensureSecureDir(options.homeDir);
		await ensureConfigParent(dirname(configPath));
	} catch (error) {
		return { kind: "insecure", configPath, reason: errorText(error) };
	}

	raw.projects = projects;
	try {
		await writeFileAtomic(configPath, `${JSON.stringify(raw, null, 2)}\n`);
	} catch (error) {
		return { kind: "write_failed", configPath, reason: errorText(error) };
	}
	return { kind: "changed", configPath, projects };
}
