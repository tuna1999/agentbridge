/** Secret redaction. Spec: docs/plan/01-design-spec.md §5.1. */

export interface RedactResult {
	text: string;
	hits: number;
}

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SECRET_ASSIGNMENT =
	/(password|passwd|secret|token|api[_-]?key|access[_-]?key)['"]?\s*[:=]\s*['"]?((?!\[REDACTED:)[^\s'"]{8,})/gi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const OPENAI_KEY = /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g;
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

const TOKEN_RULES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
	{ kind: "github_token", pattern: GITHUB_TOKEN },
	{ kind: "aws_access_key", pattern: AWS_ACCESS_KEY },
	{ kind: "openai_key", pattern: OPENAI_KEY },
	{ kind: "slack_token", pattern: SLACK_TOKEN },
	{ kind: "google_api_key", pattern: GOOGLE_API_KEY },
	{ kind: "jwt", pattern: JWT },
];

function placeholder(kind: string): string {
	return `[REDACTED:${kind}]`;
}

export function redact(input: string): RedactResult {
	let text = input;
	let hits = 0;

	// Multi-line PEM blocks first, so their body cannot trip the assignment rule.
	text = text.replace(PRIVATE_KEY, () => {
		hits += 1;
		return placeholder("private_key");
	});

	// `name = value` assignments: replace only the value, keep the name and operator.
	text = text.replace(SECRET_ASSIGNMENT, (match, _name: string, value: string) => {
		hits += 1;
		return `${match.slice(0, match.length - value.length)}${placeholder("secret")}`;
	});

	for (const rule of TOKEN_RULES) {
		text = text.replace(rule.pattern, () => {
			hits += 1;
			return placeholder(rule.kind);
		});
	}

	return { text, hits };
}
