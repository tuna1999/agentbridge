import { ProtocolError } from "./errors";
import { MAX_FRAME_BYTES } from "./limits";
import { FRAME_TOO_LARGE_MESSAGE } from "./messages";

/**
 * Incremental JSON Lines reader (01 §4.1).
 * Feed raw UTF-8 bytes; complete lines are returned without the trailing `\n`.
 * Throws `ProtocolError("too_large")` once a pending frame exceeds `MAX_FRAME_BYTES`.
 */
export class LineReader {
	#buffer: Buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): string[] {
		if (chunk.length === 0) return [];

		const buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
		const lines: string[] = [];
		let start = 0;

		for (;;) {
			const newline = buffer.indexOf(0x0a, start);
			if (newline === -1) break;
			const frame = buffer.subarray(start, newline);
			if (frame.length > MAX_FRAME_BYTES) throw new ProtocolError("too_large", FRAME_TOO_LARGE_MESSAGE);
			lines.push(frame.toString("utf8"));
			start = newline + 1;
		}

		const rest = buffer.subarray(start);
		if (rest.length > MAX_FRAME_BYTES) throw new ProtocolError("too_large", FRAME_TOO_LARGE_MESSAGE);
		this.#buffer = Buffer.from(rest);
		return lines;
	}
}
