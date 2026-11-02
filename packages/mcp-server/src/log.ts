/** Diagnostics for the stdio MCP server. NEVER writes to stdout (01 §8, T8). */
import { appendFileSync } from "node:fs";

function write(line: string): void {
	const file = process.env.AGENTBRIDGE_LOG;
	if (file !== undefined && file.length > 0) {
		try {
			appendFileSync(file, line, { mode: 0o600 });
			return;
		} catch {
			// Fall back to stderr; a broken log path must not kill the server.
		}
	}
	try {
		process.stderr.write(line);
	} catch {
		// stderr may be closed during shutdown.
	}
}

export function log(message: string): void {
	write(`[agentbridge] ${new Date().toISOString()} ${message}\n`);
}

/** One line on stderr even when AGENTBRIDGE_LOG redirects other diagnostics. */
export function writeStderrLine(line: string): void {
	try {
		process.stderr.write(`${line}\n`);
	} catch {
		// stderr may be closed during shutdown.
	}
}

export function logError(message: string, error: unknown): void {
	const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	write(`[agentbridge] ${new Date().toISOString()} ${message}: ${detail}\n`);
}
