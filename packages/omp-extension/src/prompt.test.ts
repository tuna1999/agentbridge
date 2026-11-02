import { expect, test } from "bun:test";
import type { ConsultAttachment } from "@agentbridge/protocol";
import { buildPrompt } from "./prompt";

test("buildPrompt matches the §7.5 template", () => {
	const attachments: ConsultAttachment[] = [
		{ path: "src/index.ts", startLine: 10, endLine: 12, text: "export const x = 1;" },
		{ path: "README.md", text: "no line range" },
	];
	expect(
		buildPrompt(
			"Vì sao test này flaky?\nCó nên tách không?",
			attachments,
			"01a18dd3-7bdd-71ef-9ea9-1312bd62b611",
		),
	).toMatchSnapshot();
});

test("buildPrompt handles an empty attachment list", () => {
	expect(buildPrompt("Chỉ một câu hỏi.", [], "short")).toMatchSnapshot();
});
