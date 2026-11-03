import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, readConfigStrict } from "./index";

let dir: string;
let configFile: string;
const savedConfig = process.env.AGENTBRIDGE_CONFIG;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ab-core-config-"));
	configFile = join(dir, "config.json");
	process.env.AGENTBRIDGE_CONFIG = configFile;
});

afterEach(() => {
	if (savedConfig === undefined) delete process.env.AGENTBRIDGE_CONFIG;
	else process.env.AGENTBRIDGE_CONFIG = savedConfig;
	rmSync(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
	writeFileSync(configFile, JSON.stringify(value));
}

test("returns safe defaults when the file is missing", async () => {
	const config = await loadConfig();
	expect(config).toEqual(DEFAULT_CONFIG);
	expect(config.projects).toEqual([]);
	expect(config.chat).toEqual({
		enabled: false,
		queueWhenBusy: false,
		consentTimeoutMs: 120_000,
		autoApprove: "off",
		autoMaxChars: 2_000,
		autoMaxMessages: 20,
		autoMinIntervalMs: 10_000,
	});
	expect(config.ui).toEqual({ liveWidget: true, widgetLines: 6, widgetHoldMs: 20_000 });
});

test("parses a complete config", async () => {
	const project = join(dir, "project");
	mkdirSync(project);
	writeConfig({
		version: 1,
		projects: [project],
		allowFrom: ["claude-code", "omp"],
		consult: {
			consent: "session",
			consentTimeoutMs: 1000,
			maxQuestionBytes: 512,
			maxAttachmentBytes: 1024,
			maxContextBytes: 2048,
			replyMaxBytes: 4096,
			maxTokens: 0,
			allowUncapped: true,
			ratePerMinute: 2,
			toolsOff: false,
		},
		audit: { content: true, maxBytes: 8192 },
		chat: {
			enabled: true,
			queueWhenBusy: true,
			consentTimeoutMs: 90_000,
			autoApprove: "limited",
			autoMaxChars: 1234,
			autoMaxMessages: 7,
			autoMinIntervalMs: 1500,
		},
		ui: { liveWidget: false, widgetLines: 6, widgetHoldMs: 0 },
	});
	const config = await loadConfig();
	expect(config.projects).toEqual([realpathSync(project)]);
	expect(config.allowFrom).toEqual(["claude-code", "omp"]);
	expect(config.consult.consent).toBe("session");
	expect(config.consult.maxTokens).toBe(0);
	expect(config.consult.allowUncapped).toBe(true);
	expect(config.chat).toEqual({
		enabled: true,
		queueWhenBusy: true,
		consentTimeoutMs: 90_000,
		autoApprove: "limited",
		autoMaxChars: 1234,
		autoMaxMessages: 7,
		autoMinIntervalMs: 1500,
	});
	expect(config.audit).toEqual({ content: true, maxBytes: 8192 });
	expect(config.ui).toEqual({ liveWidget: false, widgetLines: 6, widgetHoldMs: 0 });
});

test("merges partial config over defaults", async () => {
	writeConfig({ consult: { maxTokens: 0 } });
	const config = await loadConfig();
	expect(config.consult.maxTokens).toBe(0);
	expect(config.consult.consent).toBe(DEFAULT_CONFIG.consult.consent);
	expect(config.consult.maxQuestionBytes).toBe(DEFAULT_CONFIG.consult.maxQuestionBytes);
	expect(config.projects).toEqual([]);
});

test("accepts out-of-range autochat limits for snapshot-time clamping", async () => {
	writeConfig({
		chat: {
			enabled: true,
			autoApprove: "limited",
			autoMaxChars: 9_000,
			autoMaxMessages: 60,
			autoMinIntervalMs: 1_000,
		},
	});
	const config = await loadConfig();
	expect(config.chat).toMatchObject({
		enabled: true,
		autoApprove: "limited",
		autoMaxChars: 9_000,
		autoMaxMessages: 60,
		autoMinIntervalMs: 1_000,
	});
});

test("falls back to safe defaults for invalid JSON and logs once", async () => {
	writeFileSync(configFile, "{");
	const originalWarn = console.warn;
	let warnings = 0;
	console.warn = () => {
		warnings += 1;
	};
	try {
		expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
		expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
	} finally {
		console.warn = originalWarn;
	}
	expect(warnings).toBe(1);
});

test("falls back to safe defaults for an invalid field", async () => {
	writeConfig({ consult: { consent: "never" } });
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
});

test("falls back to safe defaults for an unsupported version", async () => {
	writeConfig({ version: 2 });
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
});

test("rejects invalid arrays and numbers", async () => {
	writeConfig({ projects: [""] });
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ allowFrom: ["unknown"] });
	utimesSync(configFile, new Date(), new Date(Date.now() + 1_000));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ consult: { maxTokens: -1 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 2_000));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ audit: { maxBytes: 0 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 3_000));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ chat: { enabled: "yes" } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 3_500));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ chat: { queueWhenBusy: 1 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 3_600));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ chat: { consentTimeoutMs: 0 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 3_700));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ chat: { autoApprove: "yes" } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 3_800));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ chat: { autoMaxChars: 0 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 3_900));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ chat: { autoMaxMessages: -1 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 4_100));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ chat: { autoMinIntervalMs: -1 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 4_200));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ ui: { liveWidget: "yes" } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 4_000));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ ui: { widgetLines: 0 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 5_000));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ ui: { widgetLines: 7 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 7_000));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

	writeConfig({ ui: { widgetHoldMs: -1 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 8_000));
	expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
});

test("accepts widgetLines at both ends of the allowed range", async () => {
	writeConfig({ ui: { widgetLines: 1 } });
	expect((await loadConfig()).ui.widgetLines).toBe(1);

	writeConfig({ ui: { widgetLines: 6 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 1_000));
	expect((await loadConfig()).ui.widgetLines).toBe(6);
});

test("readConfigStrict distinguishes missing, invalid and valid configs", async () => {
	expect(await readConfigStrict()).toEqual({ kind: "missing" });

	writeFileSync(configFile, "{");
	const invalid = await readConfigStrict();
	expect(invalid.kind).toBe("invalid");

	writeConfig({ projects: [dir], unknownField: { keep: true } });
	const valid = await readConfigStrict();
	expect(valid.kind).toBe("ok");
	if (valid.kind === "ok") {
		expect(valid.config.projects).toEqual([dir]);
		expect(valid.raw.unknownField).toEqual({ keep: true });
	}
});

test("reloads when the mtime changes", async () => {
	writeConfig({ consult: { maxTokens: 111 } });
	expect((await loadConfig()).consult.maxTokens).toBe(111);

	writeConfig({ consult: { maxTokens: 222 } });
	utimesSync(configFile, new Date(), new Date(Date.now() + 5_000));
	expect((await loadConfig()).consult.maxTokens).toBe(222);
});

test("uses AGENTBRIDGE_CONFIG for the default path", async () => {
	const project = join(dir, "via-env");
	mkdirSync(project);
	writeConfig({ projects: [project] });
	expect((await loadConfig()).projects).toEqual([realpathSync(project)]);
});

test("drops relative project entries instead of resolving them against the process cwd", async () => {
	const project = join(dir, "abs-project");
	mkdirSync(project);
	writeConfig({ projects: [".", "relative/dir", project] });

	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (message: string) => {
		warnings.push(message);
	};
	try {
		expect((await loadConfig()).projects).toEqual([realpathSync(project)]);
	} finally {
		console.warn = originalWarn;
	}
	expect(warnings.length).toBe(2);
});

test("realpaths projects, drops missing ones, and warns once", async () => {
	const project = join(dir, "project");
	mkdirSync(project);
	const link = join(dir, "link");
	symlinkSync(project, link);
	const missing = join(dir, "missing");
	writeConfig({ projects: [link, missing] });

	const originalWarn = console.warn;
	let warnings = 0;
	console.warn = () => {
		warnings += 1;
	};
	try {
		expect((await loadConfig()).projects).toEqual([realpathSync(project)]);
		utimesSync(configFile, new Date(), new Date(Date.now() + 10_000));
		expect((await loadConfig()).projects).toEqual([realpathSync(project)]);
	} finally {
		console.warn = originalWarn;
	}
	expect(warnings).toBe(1);
});

test("config.example.json at repo root is valid and matches defaults except projects", async () => {
	const examplePath = join(import.meta.dir, "../../../config.example.json");
	const result = await readConfigStrict(examplePath);
	if (result.kind !== "ok") throw new Error(`config.example.json: ${result.kind}`);
	expect(result.config.projects.length).toBeGreaterThan(0);
	expect({ ...result.config, projects: [] as string[] }).toEqual(DEFAULT_CONFIG);
});
