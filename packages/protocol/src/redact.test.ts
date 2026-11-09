import { expect, test } from "bun:test";
import { redact } from "./index";

const AWS_EXAMPLE_1 = "AKIA" + "IOSFODNN7EXAMPLE";
const AWS_EXAMPLE_2 = "AKIA" + "I44QH8DHBEXAMPLE";
const SLACK_EXAMPLE = "xoxb-" + "1234567890";

function assertRedacted(input: string, kind: string): void {
	const result = redact(input);
	expect(result.hits).toBe(1);
	expect(result.text).toContain(`[REDACTED:${kind}]`);
	expect(result.text).not.toContain(input);
}

test("redacts PEM private keys", () => {
	const dash = "-".repeat(5);
	const pem = [`${dash}BEGIN RSA PRIVATE KEY${dash}`, "MIIBOgIBAAJBAK", `${dash}END RSA PRIVATE KEY${dash}`].join("\n");
	assertRedacted(pem, "private_key");
});

test("redacts several PEM blocks and keeps the text between them", () => {
	const dash = "-".repeat(5);
	const block = (body: string) => [`${dash}BEGIN EC PRIVATE KEY${dash}`, body, `${dash}END EC PRIVATE KEY${dash}`].join("\n");
	const result = redact(`a\n${block("K1")}\nb\n${block("K2")}\nc ${dash}BEGIN RSA PRIVATE KEY${dash} tail`);
	expect(result.hits).toBe(3);
	expect(result.text).toBe(`a\n[REDACTED:private_key]\nb\n[REDACTED:private_key]\nc [REDACTED:private_key]`);
});

test("a PEM block cut before its END line is redacted to the end of the input", () => {
	const dash = "-".repeat(5);
	const keyBody = "MIIEowIBAAKCAQEA1234567890abcdef";
	const sliced = ["deploy notes", `${dash}BEGIN OPENSSH PRIVATE KEY${dash}`, keyBody, `${keyBody}xyz`].join("\n");
	const result = redact(sliced);
	expect(result.hits).toBe(1);
	expect(result.text).toBe("deploy notes\n[REDACTED:private_key]");
	expect(result.text).not.toContain(keyBody);
	expect(redact(result.text)).toEqual({ text: result.text, hits: 0 });
});

test("unterminated PEM headers are handled in linear time", () => {
	const header = `${"-".repeat(5)}BEGIN A PRIVATE KEY${"-".repeat(5)}\n`;
	const input = header.repeat(Math.floor(1_048_576 / header.length));
	const started = performance.now();
	expect(redact(input)).toEqual({ text: "[REDACTED:private_key]", hits: 1 });
	expect(performance.now() - started).toBeLessThan(1_000);
});

test("does not redact a harmless private-key mention", () => {
	const text = "This document explains what a PRIVATE KEY is.";
	expect(redact(text)).toEqual({ text, hits: 0 });
});

test("redacts AWS access keys", () => {
	assertRedacted(AWS_EXAMPLE_1, "aws_access_key");
	expect(redact("AKIA123").hits).toBe(0);
});

test("redacts GitHub tokens", () => {
	assertRedacted(`ghp_${"a".repeat(36)}`, "github_token");
	assertRedacted(`github_pat_${"b".repeat(20)}`, "github_token");
	expect(redact(`ghx_${"a".repeat(36)}`).hits).toBe(0);
});

test("redacts OpenAI and Anthropic keys", () => {
	assertRedacted(`sk-${"a".repeat(24)}`, "openai_key");
	assertRedacted(`sk-ant-${"b".repeat(24)}`, "openai_key");
	expect(redact("sk-short").hits).toBe(0);
});

test("redacts Slack tokens", () => {
	assertRedacted(SLACK_EXAMPLE, "slack_token");
	expect(redact("xoxz-1234567890").hits).toBe(0);
});

test("redacts Google API keys", () => {
	assertRedacted(`AIza${"a".repeat(35)}`, "google_api_key");
	expect(redact(`AIza${"a".repeat(34)}`).hits).toBe(0);
});

test("redacts JWTs", () => {
	assertRedacted(`eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`, "jwt");
	expect(redact(`eyJ${"a".repeat(10)}.${"b".repeat(10)}`).hits).toBe(0);
});

test("redacts JWTs after a space, a quote, a dot and a dash, but not inside a word", () => {
	const jwt = `eyJhbGciOiJIUzI1NiJ9.${"b".repeat(12)}.${"c-d_".repeat(4)}`;
	for (const prefix of ["Bearer ", '"', "x.", "--token-"]) {
		const result = redact(`${prefix}${jwt} tail`);
		expect(result.hits).toBe(1);
		expect(result.text).toBe(`${prefix}[REDACTED:jwt] tail`);
	}
	expect(redact(`abc${jwt}`).hits).toBe(0);
	expect(redact(`_${jwt}`).hits).toBe(0);
});

test("adversarial JWT-like runs are redacted in linear time", () => {
	// Quadratic matching took ~6 s on 256 KiB of `eyJ-`.
	for (const unit of ["eyJ-", "-eyJ", "eyJ_-", `eyJ${"a".repeat(12)}.`, `-eyJ${"a".repeat(12)}.b-`]) {
		const input = unit.repeat(Math.floor(262_144 / unit.length));
		const started = performance.now();
		redact(input);
		expect(performance.now() - started).toBeLessThan(1_000);
	}
});

test("redacts named secret assignments but keeps the key", () => {
	const result = redact('password = "correct-horse-battery"');
	expect(result.hits).toBe(1);
	expect(result.text).toBe('password = "[REDACTED:secret]"');

	expect(redact("api_key=abcdefgh").text).toBe("api_key=[REDACTED:secret]");
	expect(redact("TOKEN: abcdefgh").text).toBe("TOKEN: [REDACTED:secret]");
	expect(redact("secret: short").hits).toBe(0);
});

test("redacts quoted JSON and YAML assignment keys", () => {
	expect(redact('{"password": "hunter2hunter2"}')).toEqual({
		text: '{"password": "[REDACTED:secret]"}',
		hits: 1,
	});
	expect(redact("password: 'abcdefgh1'")).toEqual({
		text: "password: '[REDACTED:secret]'",
		hits: 1,
	});
});

test("does not redact the phrase token bucket algorithm", () => {
	const text = "The token bucket algorithm smooths bursts.";
	expect(redact(text)).toEqual({ text, hits: 0 });
});

test("prefers the assignment rule over inner token patterns", () => {
	const secret = `sk-${"a".repeat(24)}`;
	const result = redact(`api_key = ${secret}`);
	expect(result.hits).toBe(1);
	expect(result.text).toBe("api_key = [REDACTED:secret]");
	expect(result.text).not.toContain("openai_key");
});

test("counts every replacement", () => {
	const result = redact(`${AWS_EXAMPLE_1} and ${AWS_EXAMPLE_2}`);
	expect(result.hits).toBe(2);
});

test("does not redact an existing placeholder twice", () => {
	const dash = "-".repeat(5);
	const pem = [`${dash}BEGIN RSA PRIVATE KEY${dash}`, "MIIBOgIBAAJBAK", `${dash}END RSA PRIVATE KEY${dash}`].join("\n");
	const result = redact(`secret: ${pem}`);
	expect(result.hits).toBe(1);
	expect(result.text).toBe("secret: [REDACTED:private_key]");
});

test("returns empty input unchanged", () => {
	expect(redact("")).toEqual({ text: "", hits: 0 });
});
