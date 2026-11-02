import { expect, test } from "bun:test";
import { newId } from "./index";

test("newId returns distinct UUIDv7 values", () => {
	const first = newId();
	const second = newId();
	expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	expect(first).not.toBe(second);
});
