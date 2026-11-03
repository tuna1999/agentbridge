import { describe, expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditBundle, collectMachinePaths, isBuiltinSpecifier, withVersion } from "./build";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface RunResult {
 exitCode: number;
 stdout: string;
 stderr: string;
}

/** `--check` from the repo; `outputs` points it at a copy of the committed outputs. */
async function runCheck(cwd: string, outputs?: string): Promise<RunResult> {
 const args = outputs === undefined ? ["--check"] : ["--check", "--outputs", outputs];
 const proc = Bun.spawn([process.execPath, "run", "build", ...args], {
  cwd,
  stdout: "pipe",
  stderr: "pipe",
 });
 const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
 ]);
 return { exitCode, stdout, stderr };
}

/**
 * Copy only the committed outputs. The rebuild still runs from the repo with
 * its real node_modules, so an untampered copy must pass (see the control
 * test); a copied source tree with a symlinked node_modules would not.
 */
async function copyOutputs(destination: string): Promise<void> {
 for (const entry of ["plugins", ".claude-plugin", ".omp-plugin"]) {
  await cp(join(REPO_ROOT, entry), join(destination, entry), { recursive: true, verbatimSymlinks: true });
 }
}

describe("bun run build --check", () => {
 test("accepts the committed manifests and bundles", async () => {
  const result = await runCheck(REPO_ROOT);
  if (result.exitCode !== 0) {
   console.error(result.stdout);
   console.error(result.stderr);
  }
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("[check] OK");
 }, 60_000);

 test("accepts an untampered copy of the outputs (control for the tamper tests)", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agentbridge-build-test-"));
  try {
   await copyOutputs(temp);
   const result = await runCheck(REPO_ROOT, temp);
   if (result.exitCode !== 0) console.error(result.stderr);
   expect(result.exitCode).toBe(0);
   expect(result.stdout).toContain("[check] OK");
  } finally {
   await rm(temp, { recursive: true, force: true });
  }
 }, 60_000);

 test("fails when a committed bundle is tampered with", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agentbridge-build-test-"));
  try {
   await copyOutputs(temp);
   await appendFile(join(temp, "plugins", "claude", "dist", "mcp-server.js"), "\n// tampered\n");

   const result = await runCheck(REPO_ROOT, temp);
   expect(result.exitCode).not.toBe(0);
   expect(result.stderr).toContain(`bundle mismatch: ${join(temp, "plugins", "claude", "dist", "mcp-server.js")}`);
   // Only the tampered file differs.
   expect(result.stderr).not.toContain("agentbridge.js");
  } finally {
   await rm(temp, { recursive: true, force: true });
  }
 }, 60_000);

 test("fails when a generated manifest drifts from the root version", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agentbridge-build-test-"));
  try {
   await copyOutputs(temp);
   const manifestPath = join(temp, "plugins", "claude", ".claude-plugin", "plugin.json");
   const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
   manifest.version = "9.9.9";
   await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

   const result = await runCheck(REPO_ROOT, temp);
   expect(result.exitCode).not.toBe(0);
   expect(result.stderr).toContain("manifest mismatch");
   expect(result.stderr).toContain("plugins/claude/.claude-plugin/plugin.json");
  } finally {
   await rm(temp, { recursive: true, force: true });
  }
 }, 60_000);
});

test("every workspace package uses the root version", async () => {
 const root = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
 expect(root.version).toMatch(/^\d+\.\d+\.\d+$/);
 for (const name of ["protocol", "core", "omp-extension", "mcp-server"]) {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "packages", name, "package.json"), "utf8")) as {
   version: string;
  };
  expect(`${name}@${pkg.version}`).toBe(`${name}@${root.version}`);
 }
});

describe("bundle audits", () => {
 test("flag module loading that the import scanner cannot resolve", () => {
  const source = [
   'import { readFile } from "node:fs";',
   "const name = pick();",
   "await import(name);",
   "require(name);",
   'var __require = import.meta.require; __require("x");',
   'createRequire(import.meta.url)("y");',
   'require.resolve("z");',
  ].join("\n");
  const labels = auditBundle(source, []).dynamic.map((use) => use.specifier);
  expect(labels).toContain("non-literal import()");
  expect(labels).toContain("non-literal require()");
  expect(labels).toContain("__require()");
  expect(labels).toContain("import.meta.require");
  expect(labels).toContain("createRequire()");
  expect(labels).toContain("require.resolve()");
  expect(auditBundle('import { x } from "node:fs";\nawait import("node:path");', []).dynamic).toEqual([]);
 });

 test("only Node built-ins may be imported bare", () => {
  expect(isBuiltinSpecifier("fs")).toBe(true);
  expect(isBuiltinSpecifier("node:sqlite")).toBe(true);
  expect(isBuiltinSpecifier("bun:sqlite")).toBe(true);
  expect(isBuiltinSpecifier("sqlite")).toBe(false);
  expect(isBuiltinSpecifier("ws")).toBe(false);
  expect(isBuiltinSpecifier("undici")).toBe(false);
 });

 test("machine-path audit sees file URLs, PATH lists and escaped slashes but not /rootless", () => {
  const found = collectMachinePaths(
   [
    'const a = "file:///home/alice/project/x.js";',
    'const b = "PATH=/usr/bin:/home/alice/bin";',
    'const c = "\\/home\\/alice\\/repo";',
    'const d = "/rootless is fine";',
    'const e = "/var/home/bob/x";',
   ].join("\n"),
   [],
  );
  expect(found.some((value) => value.startsWith("/home/alice/project"))).toBe(true);
  expect(found).toContain("/home/alice/bin");
  expect(found.some((value) => value.includes("home") && value.includes("alice") && value.startsWith("\\"))).toBe(true);
  expect(found.some((value) => value.startsWith("/root"))).toBe(false);
  expect(found.some((value) => value.startsWith("/var/home/bob"))).toBe(true);
 });

 test("withVersion rewrites only the top-level version and keeps formatting", () => {
  const raw = '{\n  "name": "@agentbridge/core",\n  "version": "0.1.1",\n  "exports": { ".": "./src/index.ts" }\n}\n';
  expect(withVersion(raw, "0.2.0")).toBe(raw.replace("0.1.1", "0.2.0"));
 });
});
