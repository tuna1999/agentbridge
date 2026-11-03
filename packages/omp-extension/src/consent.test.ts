import { expect, test } from "bun:test";
import { buildConsentView, type PagedConsentOptions, runPagedConsent } from "./consent";
import { CONSENT_TEXT } from "./messages";

const DENY = "Từ chối";
const ALLOW = "Cho phép lần này";
/** Truncated payload: a snippet dialog, then 5 pages of at most 14 lines. */
const LONG = Array.from({ length: 60 }, (_, index) => `dòng ${index}`).join("\n");

interface Clock {
	now: number;
}

interface Dialog {
	options: string[];
	initialIndex: number;
	timeoutMs: number;
}

/** A reader who pages through everything, spending `readMs` on each dialog. */
function reader(clock: Clock, readMs: number, dialogs: Dialog[]): PagedConsentOptions["select"] {
	return async (_title, options, initialIndex, timeoutMs) => {
		dialogs.push({ options, initialIndex, timeoutMs });
		clock.now += readMs;
		if (options.includes(CONSENT_TEXT.viewFull)) return CONSENT_TEXT.viewFull;
		if (options.includes(CONSENT_TEXT.nextPage)) return CONSENT_TEXT.nextPage;
		return ALLOW;
	};
}

function pagedConsent(
	payload: string,
	clock: Clock,
	select: PagedConsentOptions["select"],
	budget: { dialogMs: number; totalMs: number },
): PagedConsentOptions {
	return {
		view: buildConsentView(payload),
		title: (body) => body,
		approveOptions: [ALLOW],
		denyOption: DENY,
		dialogTimeoutMs: budget.dialogMs,
		totalTimeoutMs: budget.totalMs,
		select,
		now: () => clock.now,
	};
}

test("every dialog lists the deny option first and highlights it", async () => {
	const clock = { now: 0 };
	const dialogs: Dialog[] = [];

	const choice = await runPagedConsent(
		pagedConsent(LONG, clock, reader(clock, 0, dialogs), { dialogMs: 1_000, totalMs: 300_000 }),
	);

	expect(choice).toBe(ALLOW);
	expect(dialogs).toHaveLength(6);
	expect(dialogs.every((dialog) => dialog.options[0] === DENY && dialog.initialIndex === 0)).toBe(true);
	expect(dialogs[0]?.options).toEqual([DENY, CONSENT_TEXT.viewFull]);
	expect(dialogs[1]?.options).toEqual([DENY, CONSENT_TEXT.nextPage]);
	expect(dialogs.at(-1)?.options).toEqual([DENY, ALLOW]);
});

test("each dialog gets its own budget, so paging longer than one budget in total still approves", async () => {
	const clock = { now: 0 };
	const dialogs: Dialog[] = [];

	// 6 dialogs × 900 ms = 5.4 s against a 1 s budget per dialog.
	const choice = await runPagedConsent(
		pagedConsent(LONG, clock, reader(clock, 900, dialogs), { dialogMs: 1_000, totalMs: 300_000 }),
	);

	expect(choice).toBe(ALLOW);
	expect(dialogs.map((dialog) => dialog.timeoutMs)).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 1_000]);
});

test("the total budget caps the exchange and shortens the dialog it ends in", async () => {
	const clock = { now: 0 };
	const dialogs: Dialog[] = [];

	const choice = await runPagedConsent(
		pagedConsent(LONG, clock, reader(clock, 900, dialogs), { dialogMs: 1_000, totalMs: 2_500 }),
	);

	expect(choice).toBeUndefined();
	expect(dialogs.map((dialog) => dialog.timeoutMs)).toEqual([1_000, 1_000, 700]);
});

test("no dialog opens once the total budget is spent", async () => {
	const clock = { now: 0 };
	const dialogs: Dialog[] = [];
	const options = pagedConsent(LONG, clock, reader(clock, 100, dialogs), { dialogMs: 1_000, totalMs: 1_500 });
	options.beforeDialog = () => {
		// Something slow between two dialogs, e.g. a busy event loop.
		if (dialogs.length === 1) clock.now = 1_500;
	};

	expect(await runPagedConsent(options)).toBeUndefined();
	expect(dialogs).toHaveLength(1);
});

test("an answer at a dialog's deadline is a timeout, never an approval", async () => {
	const clock = { now: 0 };
	// A host that ignores onTimeout and answers when its countdown ends.
	const lateHost: PagedConsentOptions["select"] = async (_title, _options, _index, timeoutMs) => {
		clock.now += timeoutMs;
		return ALLOW;
	};

	const choice = await runPagedConsent(pagedConsent("Ngắn?", clock, lateHost, { dialogMs: 1_000, totalMs: 300_000 }));

	expect(choice).toBeUndefined();
});

test("the total budget is never shorter than one dialog's budget", async () => {
	const clock = { now: 0 };
	const dialogs: Dialog[] = [];

	const choice = await runPagedConsent(
		pagedConsent("Ngắn?", clock, reader(clock, 0, dialogs), { dialogMs: 5_000, totalMs: 1_000 }),
	);

	expect(choice).toBe(ALLOW);
	expect(dialogs[0]?.timeoutMs).toBe(5_000);
});

test("a label that was not offered in that dialog counts as deny", async () => {
	const clock = { now: 0 };
	const budget = { dialogMs: 1_000, totalMs: 300_000 };

	// Approving from the snippet of a truncated payload is not possible.
	expect(await runPagedConsent(pagedConsent(LONG, clock, async () => ALLOW, budget))).toBe(DENY);
	expect(await runPagedConsent(pagedConsent("Ngắn?", clock, async () => "Có", budget))).toBe(DENY);
});
