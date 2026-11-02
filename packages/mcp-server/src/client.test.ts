import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIncludeFiles } from "./client";
import { BridgeError } from "./errors";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ab-include-test-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("readIncludeFiles", () => {
	test("rejects a sparse 2 MiB file as include_too_large before reading it", async () => {
		const file = join(root, "big.txt");
		await writeFile(file, "");
		await truncate(file, 2 * 1024 * 1024);

		const error = await readIncludeFiles(root, [{ path: "big.txt" }], false).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(BridgeError);
		expect((error as BridgeError).code).toBe("include_too_large");
		expect((error as BridgeError).message).toContain("vượt quá giới hạn kích thước");
	});

	test("reads and slices a normal file", async () => {
		await writeFile(join(root, "note.txt"), "one\ntwo\nthree\n");

		const attachments = await readIncludeFiles(root, [{ path: "note.txt", startLine: 2, endLine: 2 }], false);

		expect(attachments).toEqual([{ path: "note.txt", text: "two", startLine: 2, endLine: 2 }]);
	});
});
