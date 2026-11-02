import { describe, expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface RunResult {
 exitCode: number;
 stdout: string;
 stderr: string;
}

async function runCheck(cwd: string): Promise<RunResult> {
 const proc = Bun.spawn([process.execPath, "run", "build", "--check"], {
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

/** Copy only the inputs the build reads, then link the shared dependency store. */
async function copyBuildTree(destination: string): Promise<void> {
 const entries = [
  "package.json",
  "bunfig.toml",
  "tsconfig.base.json",
  "scripts",
  "packages",
  "plugins",
  ".claude-plugin",
  ".omp-plugin",
 ];
 for (const entry of entries) {
  await cp(join(REPO_ROOT, entry), join(destination, entry), { recursive: true, verbatimSymlinks: true });
 }
 await symlink(join(REPO_ROOT, "node_modules"), join(destination, "node_modules"), "dir");
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

 test("fails when a committed bundle is tampered with", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agentbridge-build-test-"));
  try {
   await copyBuildTree(temp);
   await appendFile(join(temp, "plugins", "claude", "dist", "mcp-server.js"), "\n// tampered\n");

   const result = await runCheck(temp);
   expect(result.exitCode).not.toBe(0);
   expect(result.stderr).toContain("bundle mismatch");
   expect(result.stderr).toContain("plugins/claude/dist/mcp-server.js");
  } finally {
   await rm(temp, { recursive: true, force: true });
  }
 }, 60_000);

 test("fails when a generated manifest drifts from the root version", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agentbridge-build-test-"));
  try {
   await copyBuildTree(temp);
   const manifestPath = join(temp, "plugins", "claude", ".claude-plugin", "plugin.json");
   const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
   manifest.version = "9.9.9";
   await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

   const result = await runCheck(temp);
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
