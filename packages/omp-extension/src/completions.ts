/**
 * Argument autocomplete for `/agentbridge` (RegisteredCommand.getArgumentCompletions,
 * extension-types.v18.14.0.ts.txt:1772).
 *
 * OMP passes the whole text after `/agentbridge ` as `argumentPrefix` and the
 * accepted item's `value` replaces that whole text (pi-tui autocomplete.ts
 * applyCompletion), so nested items must repeat the earlier tokens.
 */

/** Structural subset of pi-tui `AutocompleteItem`. */
export interface CompletionItem {
 value: string;
 label: string;
 description?: string;
}

interface Choice {
 name: string;
 description: string;
}

export const AGENTBRIDGE_SUBCOMMANDS: readonly Choice[] = [
 { name: "status", description: "Trạng thái server, phiên và autochat" },
 { name: "trust", description: "Tin cậy phiên này (chỉ trong bộ nhớ)" },
 { name: "untrust", description: "Bỏ tin cậy phiên này" },
 { name: "autochat", description: "Chế độ tự duyệt: off | limited [phút] | unlimited" },
 { name: "allow", description: "Cho phép project hiện tại" },
 { name: "disallow", description: "Bỏ cho phép project hiện tại" },
 { name: "config", description: "Xem cấu hình AgentBridge" },
 { name: "off", description: "Tắt server cho phiên này" },
 { name: "on", description: "Bật lại server cho phiên này" },
 { name: "clear", description: "Xoá widget" },
];

const AUTOCHAT_MODES: readonly Choice[] = [
 { name: "off", description: "Tắt autochat" },
 { name: "limited", description: "Tự duyệt có giới hạn, tuỳ chọn số phút (tối đa 480)" },
 { name: "unlimited", description: "Tự duyệt không giới hạn" },
];

function match(choices: readonly Choice[], typed: string, lead: string): CompletionItem[] | null {
 const lower = typed.toLowerCase();
 const items = choices
  .filter((choice) => choice.name.startsWith(lower))
  .map((choice) => ({ value: `${lead}${choice.name} `, label: choice.name, description: choice.description }));
 return items.length > 0 ? items : null;
}

export function agentbridgeArgumentCompletions(argumentPrefix: string): CompletionItem[] | null {
 const leading = argumentPrefix.match(/^\s*/)?.[0] ?? "";
 const rest = argumentPrefix.slice(leading.length);
 const space = rest.search(/\s/);
 if (space === -1) return match(AGENTBRIDGE_SUBCOMMANDS, rest, leading);

 const sub = rest.slice(0, space).toLowerCase();
 if (sub !== "autochat") return null;
 const afterSub = rest.slice(space).replace(/^\s+/, "");
 if (/\s/.test(afterSub)) return null; // past the mode token (e.g. minutes)
 const lead = argumentPrefix.slice(0, argumentPrefix.length - afterSub.length);
 return match(AUTOCHAT_MODES, afterSub, lead);
}
