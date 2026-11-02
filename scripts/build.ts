#!/usr/bin/env bun
/**
 * Build AgentBridge as GitHub-installable plugins for Claude Code and OMP.
 *
 * `bun run build` writes both single-file bundles and regenerates the plugin
 * manifests from the root package version. `bun run build --check` rebuilds
 * into a temporary directory and compares the result with the committed files
 * without mutating the working tree.
 *
 * Spec: T14 packaging. Both bundles target Bun/ESM and must only import
 * node: and bun built-ins; every other dependency is bundled.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface BundleTarget {
 readonly name: string;
 readonly entry: string;
 readonly committed: string;
}

export const BUNDLE_TARGETS: readonly BundleTarget[] = [
 {
  name: "mcp-server",
  entry: join(REPO_ROOT, "packages", "mcp-server", "src", "index.ts"),
  committed: join(REPO_ROOT, "plugins", "claude", "dist", "mcp-server.js"),
 },
 {
  name: "agentbridge",
  entry: join(REPO_ROOT, "packages", "omp-extension", "src", "index.ts"),
  committed: join(REPO_ROOT, "plugins", "omp", "dist", "agentbridge.js"),
 },
];

export interface ManifestFile {
 /** Absolute path below the repository root. */
 readonly path: string;
 readonly content: string;
}

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

/** Absolute paths that only make sense on the machine that produced the bundle. */
const GENERIC_MACHINE_PATHS = [
 /(?:^|[\s"'`(=,\[])(\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/[^\s"'`)]*)?)/gm,
 /(?:^|[\s"'`(=,\[])(\/root(?:\/[^\s"'`)]*)?)/gm,
 /(?:^|[\s"'`(=,\[])([A-Za-z]:(?:\\\\|\\)[^\s"'`)]*)/gm,
];

export interface ImportUse {
 specifier: string;
 line: number;
}

export interface BundleAudit {
 bytes: number;
 imports: ImportUse[];
 external: ImportUse[];
 machinePaths: string[];
}

/** `node:*` and Bun built-ins are the only allowed runtime imports. */
export function isBuiltinSpecifier(specifier: string): boolean {
 if (specifier.startsWith("node:")) return true;
 if (specifier === "bun" || specifier.startsWith("bun:")) return true;
 return BUILTINS.has(specifier);
}

function json(value: unknown): string {
 return `${JSON.stringify(value, null, 2)}\n`;
}

const PLUGIN_DESCRIPTION = "Bridge OMP and Claude Code sessions through a shared MCP server.";

/** Claude Code requires `.claude-plugin/plugin.json`; only `name` is required, the rest is metadata. */
export function claudePluginManifest(version: string): string {
 return json({
  name: "agentbridge",
  version,
  description: PLUGIN_DESCRIPTION,
  author: { name: "AgentBridge" },
  license: "Apache-2.0",
 });
}

/**
 * Claude reads `.mcp.json` at the plugin root as a direct server-name map
 * (not the project-scoped `mcpServers` wrapper).
 */
export function claudeMcpConfig(): string {
 return json({
  agentbridge: {
   command: "bun",
   args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"],
  },
 });
}

/** OMP resolves `omp.extensions` relative to the plugin root. */
export function ompPackageManifest(version: string): string {
 return json({
  name: "agentbridge",
  version,
  description: PLUGIN_DESCRIPTION,
  private: true,
  type: "module",
  license: "Apache-2.0",
  omp: { extensions: ["./dist/agentbridge.js"] },
 });
}

/** Claude marketplace: `name`, `owner.name` and `plugins[].name/source` are required. */
export function claudeMarketplace(version: string): string {
 return json({
  name: "agentbridge",
  description: "AgentBridge plugins for Claude Code.",
  owner: { name: "AgentBridge" },
  plugins: [
   {
    name: "agentbridge",
    source: "./plugins/claude",
    version,
    description: PLUGIN_DESCRIPTION,
   },
  ],
 });
}

/** OMP marketplace: same required fields, searched at `.omp-plugin/marketplace.json` first. */
export function ompMarketplace(version: string): string {
 return json({
  name: "agentbridge",
  description: "AgentBridge plugins for OMP.",
  owner: { name: "AgentBridge" },
  plugins: [
   {
    name: "agentbridge",
    source: "./plugins/omp",
    version,
    description: PLUGIN_DESCRIPTION,
   },
  ],
 });
}

/**
 * OMP's catalog parser (`marketplace/fetcher.ts` in omp 18.15.0) requires:
 * `name` matching its plugin-name pattern, an `owner` object with a string
 * `name`, and a `plugins` array whose entries have a valid `name` and a
 * relative `source` starting with "./" (or a supported source object).
 */
const OMP_NAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

export function validateOmpMarketplaceContent(content: string): string[] {
 const errors: string[] = [];
 let parsed: unknown;
 try {
  parsed = JSON.parse(content);
 } catch (error) {
  return [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`];
 }
 if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  return ["catalog must be a JSON object"];
 }
 const catalog = parsed as Record<string, unknown>;
 if (typeof catalog.name !== "string" || catalog.name.length > 64 || !OMP_NAME_PATTERN.test(catalog.name)) {
  errors.push("name must match OMP's plugin-name pattern");
 }
 if (typeof catalog.owner !== "object" || catalog.owner === null || Array.isArray(catalog.owner)) {
  errors.push("owner must be an object");
 } else {
  const owner = catalog.owner as Record<string, unknown>;
  if (typeof owner.name !== "string") errors.push("owner.name must be a string");
 }
 if (!Array.isArray(catalog.plugins)) {
  errors.push("plugins must be an array");
  return errors;
 }
 const seen = new Set<string>();
 for (const [index, entry] of catalog.plugins.entries()) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
   errors.push(`plugins[${index}] must be an object`);
   continue;
  }
  const plugin = entry as Record<string, unknown>;
  if (typeof plugin.name !== "string" || plugin.name.length > 64 || !OMP_NAME_PATTERN.test(plugin.name)) {
   errors.push(`plugins[${index}].name must match OMP's plugin-name pattern`);
  } else if (seen.has(plugin.name.toLowerCase())) {
   errors.push(`plugins[${index}].name is a case-equivalent duplicate`);
  } else {
   seen.add(plugin.name.toLowerCase());
  }
  if (typeof plugin.source !== "string" || !plugin.source.startsWith("./")) {
   errors.push(`plugins[${index}].source must be a relative string starting with "./"`);
  }
 }
 return errors;
}

export async function readRootVersion(root: string = REPO_ROOT): Promise<string> {
 const raw = await readFile(join(root, "package.json"), "utf8");
 const parsed: unknown = JSON.parse(raw);
 if (
  typeof parsed !== "object" ||
  parsed === null ||
  !("version" in parsed) ||
  typeof parsed.version !== "string" ||
  parsed.version.length === 0
 ) {
  throw new Error(`${join(root, "package.json")} has no non-empty version`);
 }
 return parsed.version;
}

export function generatedManifests(root: string, version: string): ManifestFile[] {
 return [
  { path: join(root, "plugins", "claude", ".claude-plugin", "plugin.json"), content: claudePluginManifest(version) },
  { path: join(root, "plugins", "claude", ".mcp.json"), content: claudeMcpConfig() },
  { path: join(root, "plugins", "omp", "package.json"), content: ompPackageManifest(version) },
  { path: join(root, ".claude-plugin", "marketplace.json"), content: claudeMarketplace(version) },
  { path: join(root, ".omp-plugin", "marketplace.json"), content: ompMarketplace(version) },
 ];
}

function lineAt(source: string, index: number): number {
 let line = 1;
 for (let cursor = 0; cursor < index; cursor += 1) {
  if (source[cursor] === "\n") line += 1;
 }
 return line;
}

function escapedPattern(value: string): string {
 return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importLine(source: string, specifier: string): number {
 const pattern = new RegExp(
  `(?:\\bfrom[ \\t]+|\\brequire[ \\t]*\\([ \\t]*|\\bimport[ \\t]*\\([ \\t]*|^[ \\t]*import[ \\t]+)["']${escapedPattern(specifier)}["']`,
  "m",
 );
 const match = pattern.exec(source);
 if (match?.index === undefined) return 1;
 return lineAt(source, match.index);
}

/**
 * Scan real imports/requires with Bun's parser instead of regexes: bundled
 * dependency source contains strings such as `require("ajv/...")` that are
 * generated code, not runtime imports.
 */
export function collectImports(source: string): ImportUse[] {
 const transpiler = new Bun.Transpiler({ loader: "js" });
 const seen = new Set<string>();
 const uses: ImportUse[] = [];
 for (const found of transpiler.scanImports(source)) {
  const key = `${found.kind}:${found.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  uses.push({ specifier: found.path, line: importLine(source, found.path) });
 }
 return uses.sort((left, right) => left.line - right.line || left.specifier.localeCompare(right.specifier));
}

export function collectMachinePaths(
 source: string,
 roots: readonly string[] = [REPO_ROOT, process.cwd(), homedir()],
): string[] {
 const found = new Set<string>();
 for (const root of roots) {
  if (root.length > 1 && source.includes(root)) found.add(root);
 }
 for (const pattern of GENERIC_MACHINE_PATHS) {
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
   const value = match[1];
   if (value === undefined) continue;
   // `/tmp` is shared and not evidence of the build machine; skip only if it is the whole match.
   if (value === tmpdir()) continue;
   found.add(value);
  }
 }
 return [...found].sort();
}

export function auditBundle(source: string, roots?: readonly string[]): BundleAudit {
 const imports = collectImports(source);
 return {
  bytes: Buffer.byteLength(source, "utf8"),
  imports,
  external: imports.filter((use) => !isBuiltinSpecifier(use.specifier)),
  machinePaths: collectMachinePaths(source, roots),
 };
}

export function formatBytes(bytes: number): string {
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB (${bytes.toLocaleString("en-US")} byte)`;
 return `${(bytes / (1024 * 1024)).toFixed(2)} MiB (${bytes.toLocaleString("en-US")} byte)`;
}

export function sha256(value: string | Uint8Array): string {
 return createHash("sha256").update(value).digest("hex");
}

async function runBundle(target: BundleTarget, outfile: string): Promise<void> {
 await mkdir(dirname(outfile), { recursive: true });
 const proc = Bun.spawn(
  [
   process.execPath,
   "build",
   target.entry,
   "--target=bun",
   "--format=esm",
   `--outfile=${outfile}`,
  ],
  { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
 );
 const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
 ]);
 if (exitCode !== 0) {
  throw new Error(
   `bun build failed for ${target.name} (exit ${exitCode})\n${stdout.trim()}\n${stderr.trim()}`.trim(),
  );
 }
}

function reportAudit(label: string, audit: BundleAudit): boolean {
 const unique = [...new Set(audit.imports.map((use) => use.specifier))].sort();
 console.log(
  `[deps] ${label}: ${audit.imports.length} import, ${unique.length} specifier: ${unique.join(", ") || "(none)"}`,
 );
 let ok = true;
 if (audit.external.length > 0) {
  ok = false;
  console.error(`[deps] ${label}: ERROR: non-builtin imports:`);
  for (const use of audit.external) console.error(`  - ${use.specifier} (line ${use.line})`);
 } else {
  console.log(`[deps] ${label}: OK (node:*/bun built-ins only)`);
 }
 if (audit.machinePaths.length > 0) {
  ok = false;
  console.error(`[paths] ${label}: ERROR: build-machine absolute paths:`);
  for (const value of audit.machinePaths) console.error(`  - ${value}`);
 } else {
  console.log(`[paths] ${label}: OK (no build-machine absolute paths)`);
 }
 return ok;
}

async function auditFile(label: string, path: string): Promise<boolean> {
 const [source, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
 const audit = auditBundle(source);
 console.log(`[build] ${label}: ${path}`);
 console.log(`[build] ${label} size: ${formatBytes(info.size)} (audit: ${formatBytes(audit.bytes)})`);
 return reportAudit(label, audit);
}

async function buildAll(outDir: string): Promise<boolean> {
 let ok = true;
 for (const target of BUNDLE_TARGETS) {
  const outfile = join(outDir, `${target.name}.js`);
  await runBundle(target, outfile);
  if (!(await auditFile(target.name, outfile))) ok = false;
 }
 return ok;
}

function verifyOmpCatalog(root: string, file: ManifestFile, content: string): boolean {
 if (file.path !== join(root, ".omp-plugin", "marketplace.json")) return true;
 const errors = validateOmpMarketplaceContent(content);
 if (errors.length === 0) {
  console.log(`[check] OMP catalog schema OK: ${file.path}`);
  return true;
 }
 console.error(`[check] OMP catalog schema invalid: ${file.path}`);
 for (const error of errors) console.error(`  - ${error}`);
 return false;
}

async function writeManifests(root: string, version: string): Promise<void> {
 for (const file of generatedManifests(root, version)) {
  if (!verifyOmpCatalog(root, file, file.content)) {
   throw new Error(`refusing to write invalid OMP catalog ${file.path}`);
  }
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.content);
  console.log(`[manifest] wrote ${file.path}`);
 }
}

async function checkManifests(root: string, version: string): Promise<boolean> {
 let ok = true;
 for (const file of generatedManifests(root, version)) {
  let actual: string;
  try {
   actual = await readFile(file.path, "utf8");
  } catch {
   console.error(`[check] manifest missing: ${file.path}`);
   ok = false;
   continue;
  }
  if (!verifyOmpCatalog(root, file, actual)) ok = false;
  if (actual !== file.content) {
   console.error(`[check] manifest mismatch: ${file.path}`);
   console.error("[check] run `bun run build` to regenerate it");
   ok = false;
  } else {
   console.log(`[check] manifest OK: ${file.path}`);
  }
 }
 return ok;
}

async function checkBundles(): Promise<boolean> {
 const temp = await mkdtemp(join(tmpdir(), "agentbridge-build-check-"));
 try {
  let ok = true;
  for (const target of BUNDLE_TARGETS) {
   const rebuilt = join(temp, `${target.name}.js`);
   await runBundle(target, rebuilt);
   if (!(await auditFile(`${target.name} (check)`, rebuilt))) ok = false;

   const [rebuiltBytes, committedBytes] = await Promise.all([
    readFile(rebuilt),
    readFile(target.committed).catch(() => null),
   ]);
   if (committedBytes === null) {
    console.error(`[check] committed bundle missing: ${target.committed}`);
    ok = false;
    continue;
   }
   const rebuiltHash = sha256(rebuiltBytes);
   const committedHash = sha256(committedBytes);
   if (rebuiltHash !== committedHash) {
    console.error(`[check] bundle mismatch: ${target.committed}`);
    console.error(`[check] committed sha256 ${committedHash}`);
    console.error(`[check] rebuilt   sha256 ${rebuiltHash}`);
    console.error("[check] run `bun run build` and commit the new bundle");
    ok = false;
   } else {
    console.log(`[check] bundle OK: ${target.committed} sha256=${rebuiltHash}`);
   }
  }
  return ok;
 } finally {
  await rm(temp, { recursive: true, force: true });
 }
}

export interface CliOptions {
 check: boolean;
 help: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
 let check = false;
 let help = false;
 for (const arg of argv) {
  if (arg === "--check") {
   check = true;
  } else if (arg === "--help" || arg === "-h") {
   help = true;
  } else {
   throw new Error(`unknown argument: ${arg}`);
  }
 }
 return { check, help };
}

const USAGE = `Usage: bun scripts/build.ts [--check]\n\n  (no flags)  build both bundles and regenerate plugin manifests\n  --check     rebuild into a temp dir and verify committed bundles/manifests\n`;

async function main(argv: readonly string[]): Promise<number> {
 const options = parseArgs(argv);
 if (options.help) {
  console.log(USAGE);
  return 0;
 }

 const version = await readRootVersion();
 console.log(`[build] version ${version} (root package.json)`);

 if (options.check) {
  const manifestsOk = await checkManifests(REPO_ROOT, version);
  const bundlesOk = await checkBundles();
  if (!manifestsOk || !bundlesOk) {
   console.error("[check] FAILED");
   return 1;
  }
  console.log("[check] OK: manifests and bundles are reproducible");
  return 0;
 }

 const temp = await mkdtemp(join(tmpdir(), "agentbridge-build-"));
 try {
  if (!(await buildAll(temp))) {
   console.error("[build] FAILED: bundle audit failed");
   return 1;
  }

  // Copy the audited temp bundles into the committed plugin locations only
  // after every check has passed.
  for (const target of BUNDLE_TARGETS) {
   const source = join(temp, `${target.name}.js`);
   await mkdir(dirname(target.committed), { recursive: true });
   await writeFile(target.committed, await readFile(source));
   console.log(`[build] wrote ${target.committed}`);
  }
 } finally {
  await rm(temp, { recursive: true, force: true });
 }

 await writeManifests(REPO_ROOT, version);
 console.log("[build] OK");
 return 0;
}

if (import.meta.main) {
 main(process.argv.slice(2))
  .then((code) => {
   process.exitCode = code;
  })
  .catch((error: unknown) => {
   console.error(`[build] ${error instanceof Error ? error.message : String(error)}`);
   process.exitCode = 1;
  });
}
