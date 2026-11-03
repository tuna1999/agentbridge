import { expect, test } from "bun:test";
import * as protocol from "./index";

test("public surface exposes the protocol v1 API", () => {
	expect(protocol.PROTOCOL_VERSION).toBe(1);
	expect(protocol.isErrorCode("consent_timeout")).toBe(true);
	expect(protocol.isRecord({})).toBe(true);
	expect(typeof protocol.LineReader).toBe("function");
	expect(typeof protocol.parseEnvelope).toBe("function");
	expect(typeof protocol.newId).toBe("function");
	expect(typeof protocol.redact).toBe("function");
	expect(typeof protocol.resolveInside).toBe("function");
	expect(typeof protocol.sanitizeText).toBe("function");
});
