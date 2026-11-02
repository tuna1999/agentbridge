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
