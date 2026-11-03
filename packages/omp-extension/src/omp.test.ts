import { expect, test } from "bun:test";
import { createOmpLike, type OmpContextLike, type PiLike } from "./omp";

const pi: PiLike = {
	on() { },
	registerCommand() { },
};

function ctxWith(isIdle?: () => boolean): OmpContextLike {
	const ctx: OmpContextLike = {
		ui: { setStatus() { }, notify() { } },
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "omp-session" },
	};
	if (isIdle !== undefined) ctx.isIdle = isIdle;
	return ctx;
}

test("select reports an OMP selector timeout as no answer, not as the highlighted option", async () => {
	const omp = createOmpLike(pi, "0.0.0");
	const ctx = ctxWith();
	let seen: { initialIndex?: number; timeout?: number } | undefined;
	ctx.ui.select = async (_title, options, dialogOptions) => {
		seen = dialogOptions;
		dialogOptions?.onTimeout?.();
		const highlighted = options[dialogOptions?.initialIndex ?? 0];
		return typeof highlighted === "string" ? highlighted : highlighted?.label;
	};
	expect(await omp.select(ctx, "t", ["Cho phép", "Từ chối"], { timeout: 10, initialIndex: 1 })).toBeUndefined();
	expect(seen?.initialIndex).toBe(1);
	expect(seen?.timeout).toBe(10);

	ctx.ui.select = async () => "Cho phép";
	expect(await omp.select(ctx, "t", ["Cho phép", "Từ chối"], { timeout: 10 })).toBe("Cho phép");
});

test("isIdle treats a missing or throwing API as busy so chat never omits deliverAs", () => {
	const omp = createOmpLike(pi, "0.0.0");
	expect(omp.isIdle(ctxWith())).toBe(false);
	expect(
		omp.isIdle(
			ctxWith(() => {
				throw new Error("not ready");
			}),
		),
	).toBe(false);
	expect(omp.isIdle(ctxWith(() => true))).toBe(true);
	expect(omp.isIdle(ctxWith(() => false))).toBe(false);
});
