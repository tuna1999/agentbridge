/** Text sanitizer for untrusted text that a person or a model will read. Spec: docs/plan/01-design-spec.md §5.3. */

/** CSI, OSC and two-character ESC sequences (plus the C1 CSI); their payload must never render. */
const ANSI_ESCAPE_SEQUENCES =
	/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)|[@-_])|\u009b[0-?]*[ -/]*[@-~]/g;

/** C0 controls except `\t` and `\n`, DEL, and C1 controls. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Characters a terminal draws as nothing while a model still reads them:
 * every Unicode `Cf` code point (zero-width space/joiners, bidi controls, word
 * joiner, BOM, soft hyphen, tag characters U+E0000..E007F), variation
 * selectors, the combining grapheme joiner and the Hangul fillers.
 */
const INVISIBLE_CHARS =
	/[\p{Cf}\u{034f}\u{115f}\u{1160}\u{3164}\u{ffa0}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/gu;

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. */
const LINE_SEPARATORS = /[\u{2028}\u{2029}]/gu;

/**
 * Remove terminal escapes, control characters (keeping `\t` and `\n`) and
 * invisible format characters; normalize CR/CRLF and U+2028/U+2029 to `\n`.
 *
 * Apply it to the exact text that is shown to the operator *and* sent onward,
 * so a consent dialog can never display less than the model receives.
 * Idempotent: `sanitizeText(sanitizeText(x)) === sanitizeText(x)`.
 */
export function sanitizeText(text: string): string {
	return text
		.replace(ANSI_ESCAPE_SEQUENCES, "")
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL_CHARS, "")
		.replace(INVISIBLE_CHARS, "")
		.replace(LINE_SEPARATORS, "\n");
}

/** One-line variant for labels (session names, paths): whitespace runs become one space. */
export function sanitizeLabel(text: string, maxChars = 160): string {
	const clean = sanitizeText(text).replace(/\s+/g, " ").trim();
	return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}\u{2026}` : clean;
}
