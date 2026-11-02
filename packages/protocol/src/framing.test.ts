import { expect, test } from "bun:test";
import { LineReader, MAX_FRAME_BYTES, ProtocolError } from "./index";

test("returns one frame per newline", () => {
	const reader = new LineReader();
	expect(reader.push(Buffer.from('{"a":1}\n'))).toEqual(['{"a":1}']);
});

test("returns many frames from one chunk", () => {
	const reader = new LineReader();
	expect(reader.push(Buffer.from('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
});

test("buffers a frame split across chunks", () => {
	const reader = new LineReader();
	const frame = '{"question":"xin chào"}';
	const bytes = Buffer.from(`${frame}\n`, "utf8");
	const cut = Math.floor(bytes.length / 2);
	expect(reader.push(bytes.subarray(0, cut))).toEqual([]);
	expect(reader.push(bytes.subarray(cut))).toEqual([frame]);
});

test("does not split a multibyte code point across chunks", () => {
	const reader = new LineReader();
	const frame = '{"q":"ế"}';
	const bytes = Buffer.from(`${frame}\n`, "utf8");
	const needle = Buffer.from("ế", "utf8");
	const cut = bytes.indexOf(needle) + 1;
	expect(reader.push(bytes.subarray(0, cut))).toEqual([]);
	expect(reader.push(bytes.subarray(cut))).toEqual([frame]);
});

test("ignores an empty chunk", () => {
	const reader = new LineReader();
	expect(reader.push(Buffer.alloc(0))).toEqual([]);
});

test("keeps an unterminated frame buffered", () => {
	const reader = new LineReader();
	expect(reader.push(Buffer.from("partial"))).toEqual([]);
	expect(reader.push(Buffer.from("\n"))).toEqual(["partial"]);
});

test("keeps empty lines", () => {
	const reader = new LineReader();
	expect(reader.push(Buffer.from("\n\n"))).toEqual(["", ""]);
});

test("accepts a frame of exactly MAX_FRAME_BYTES", () => {
	const reader = new LineReader();
	expect(reader.push(Buffer.alloc(MAX_FRAME_BYTES, 0x61))).toEqual([]);
	const [line] = reader.push(Buffer.from("\n"));
	expect(line).toHaveLength(MAX_FRAME_BYTES);
});

test("rejects an oversized frame without a newline", () => {
	const reader = new LineReader();
	try {
		reader.push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
		throw new Error("expected too_large");
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe("too_large");
	}
});

test("rejects an oversized frame even when the newline is in the same chunk", () => {
	const reader = new LineReader();
	try {
		reader.push(Buffer.alloc(MAX_FRAME_BYTES + 2, 0x61));
		throw new Error("expected too_large");
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe("too_large");
	}
});
