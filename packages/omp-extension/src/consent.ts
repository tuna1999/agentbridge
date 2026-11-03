/**
 * Consent dialogs shared by consult and chat. Spec: docs/plan/01-design-spec.md §7.4 step 7, §7.4b step 8, §5.3.
 *
 * The operator must be able to read the whole question or message the model
 * will receive. Callers pass that exact payload (already `sanitizeText`ed and
 * redacted); this module only normalizes whitespace for display. When the first
 * dialog cannot show the whole payload, no approving option is offered until
 * every page was shown. Consult attachments are listed by path only: their text
 * reaches the model fenced as data that must not be followed (01 §7.5).
 *
 * A timeout is never an approval: OMP's selector picks the highlighted option
 * when its countdown ends, so the adapter turns that into `undefined`; the deny
 * option comes first and is highlighted, so a host that ignores `onTimeout` or
 * `initialIndex` still lands on it; and an answer after a dialog's deadline
 * counts as a timeout.
 *
 * Each dialog has its own `consentTimeoutMs`: paging proves the operator is
 * present, so a long payload is not cut off by a budget sized for one dialog.
 * `CONSENT_TOTAL_MAX_MS` bounds the whole exchange.
 */
import { sanitizeLabel, sanitizeText } from "@agentbridge/protocol";
import { CONSENT_TEXT } from "./messages";

/**
 * The caller's self-declared session id as every surface shows it — consent
 * dialog, widget, consult prompt and chat frame — so the operator never sees
 * less than the model does: one line, sanitized, no brackets that could close
 * a frame label early.
 */
export function callerLabel(sessionId: string): string {
	return sanitizeLabel(sessionId, 128).replace(/[()[\]]/g, "_");
}

export const CONSENT_SNIPPET_CHARS = 300;
export const CONSENT_MAX_LINES = 8;
const VIEW_PAGE_CHARS = 1_000;
const VIEW_PAGE_LINES = 14;
const TAB_AS_SPACES = "  ";

/**
 * Make untrusted text safe to show in `ctx.ui.select`: no terminal escapes,
 * control or invisible characters, tabs drawn as spaces, at most one blank line
 * in a row, at most `maxLines` lines, and only then a character cap.
 */
export function sanitizeDialogText(
	text: string,
	maxChars: number = Number.POSITIVE_INFINITY,
	maxLines: number = CONSENT_MAX_LINES,
): string {
	const cleaned = sanitizeText(text).replace(/\t/g, TAB_AS_SPACES);
	const lines: string[] = [];
	for (const raw of cleaned.split("\n")) {
		const line = raw.replace(/\s+$/u, "");
		const previousBlank = lines.length === 0 || lines[lines.length - 1] === "";
		if (line.length === 0 && previousBlank) continue;
		lines.push(line);
		if (lines.length === maxLines) break;
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const bounded = lines.join("\n");
	return bounded.length > maxChars ? bounded.slice(0, maxChars) : bounded;
}

export interface ConsentView {
	/** The whole payload as displayed (whitespace-normalized). */
	full: string;
	/** First dialog body; ends with `…` when it hides anything. */
	snippet: string;
	/** "Kích thước: N dòng · M ký tự (đã ẩn K ký tự)". */
	sizeLine: string;
	truncated: boolean;
}

/** `payload` must be the exact text the model will receive. */
export function buildConsentView(payload: string): ConsentView {
	const full = sanitizeDialogText(payload, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	const shown = sanitizeDialogText(full, CONSENT_SNIPPET_CHARS, CONSENT_MAX_LINES);
	const truncated = full.length > shown.length;
	const lines = full.length === 0 ? 1 : full.split("\n").length;
	const hidden = truncated ? full.length - shown.length : 0;
	return {
		full,
		snippet: truncated ? `${shown}…` : shown,
		sizeLine: CONSENT_TEXT.size(lines, full.length, hidden),
		truncated,
	};
}

/**
 * Split sanitized full text without dropping anything. Pages keep line
 * boundaries where possible; a single overlong line is chunked by code point.
 */
export function paginateText(
	text: string,
	maxChars: number = VIEW_PAGE_CHARS,
	maxLines: number = VIEW_PAGE_LINES,
): string[] {
	if (maxChars <= 0 || maxLines <= 0) return [text];
	const pages: string[] = [];
	let current: string[] = [];
	let currentChars = 0;
	const flush = (): void => {
		if (current.length === 0) return;
		pages.push(current.join("\n"));
		current = [];
		currentChars = 0;
	};

	for (const rawLine of text.split("\n")) {
		let points = Array.from(rawLine);
		while (points.length > maxChars) {
			flush();
			pages.push(points.slice(0, maxChars).join(""));
			points = points.slice(maxChars);
		}
		const line = points.join("");
		const lineChars = points.length;
		if (current.length > 0 && (current.length >= maxLines || currentChars + 1 + lineChars > maxChars)) {
			flush();
		}
		current.push(line);
		currentChars = current.length === 1 ? lineChars : currentChars + 1 + lineChars;
	}
	flush();
	return pages.length > 0 ? pages : [""];
}

export interface PagedConsentOptions {
	view: ConsentView;
	/** Dialog title for the snippet (`page` undefined) or for one page of the full text. */
	title(body: string, page?: { index: number; total: number }): string;
	/** Approving options, offered once the operator has seen everything. */
	approveOptions: readonly string[];
	denyOption: string;
	/** Budget for each dialog, counted from the moment it opens. */
	dialogTimeoutMs: number;
	/** Budget for the whole exchange; never shorter than one dialog's budget. */
	totalTimeoutMs: number;
	/**
	 * Shows one dialog for at most `timeoutMs`; resolves to the chosen label, or
	 * `undefined` on timeout/dismiss. `options[initialIndex]` is the deny option:
	 * OMP highlights it, so a reflexive Enter (or a host that auto-picks on
	 * timeout) cannot approve.
	 */
	select(title: string, options: string[], initialIndex: number, timeoutMs: number): Promise<string | undefined>;
	/** Throws to stop (request settled). Runs before every dialog. */
	beforeDialog?(): void;
	/** Clock for the deadlines; defaults to `Date.now`. */
	now?(): number;
}

/**
 * Snippet dialog, then "Xem toàn văn" pages when the snippet hides anything.
 * Every dialog lists `denyOption` first. Resolves to a label from
 * `approveOptions`, `denyOption` for any other choice, or `undefined` when a
 * dialog timed out, was dismissed, or the total budget ran out.
 */
export async function runPagedConsent(options: PagedConsentOptions): Promise<string | undefined> {
	const now = options.now ?? (() => Date.now());
	const dialogMs = Math.max(1, options.dialogTimeoutMs);
	const totalDeadline = now() + Math.max(dialogMs, options.totalTimeoutMs);
	const approvals = options.approveOptions.filter((label) => label !== options.denyOption);

	/** One dialog; a choice made at or after its deadline is a timeout. */
	const ask = async (body: string, page: { index: number; total: number } | undefined, labels: string[]) => {
		options.beforeDialog?.();
		const opened = now();
		const deadline = Math.min(opened + dialogMs, totalDeadline);
		if (opened >= deadline) return undefined;
		const offered = [options.denyOption, ...labels];
		const choice = await options.select(options.title(body, page), offered, 0, deadline - opened);
		return choice !== undefined && now() >= deadline ? undefined : choice;
	};
	const finalChoice = (choice: string | undefined): string | undefined => {
		if (choice === undefined) return undefined;
		return approvals.includes(choice) ? choice : options.denyOption;
	};

	if (!options.view.truncated) {
		return finalChoice(await ask(options.view.snippet, undefined, approvals));
	}

	// The snippet is not the whole payload: nothing can be approved yet.
	const initial = await ask(options.view.snippet, undefined, [CONSENT_TEXT.viewFull]);
	if (initial === undefined) return undefined;
	if (initial !== CONSENT_TEXT.viewFull) return options.denyOption;

	const pages = paginateText(options.view.full);
	for (let index = 0; index < pages.length; index += 1) {
		const last = index === pages.length - 1;
		const choice = await ask(
			pages[index] ?? "",
			{ index: index + 1, total: pages.length },
			last ? approvals : [CONSENT_TEXT.nextPage],
		);
		if (choice === undefined) return undefined;
		if (last) return finalChoice(choice);
		if (choice !== CONSENT_TEXT.nextPage) return options.denyOption;
	}
	return options.denyOption;
}
