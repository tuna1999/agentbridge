/**
 * Argument autocomplete for `/agentbridge` (RegisteredCommand.getArgumentCompletions,
 * extension-types.v18.14.0.ts.txt:1772).
 *
 * OMP passes the whole text after `/agentbridge ` as `argumentPrefix` and the
 * accepted item's `value` replaces that whole text (pi-tui autocomplete.ts
 * applyCompletion), so nested items must repeat the earlier tokens.
 */

import { COMPLETION_TEXT } from "./messages";

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

const SUBCOMMAND_NAMES = ["status", "trust", "untrust", "autochat", "allow", "disallow", "config", "off", "on", "clear"] as const;
const AUTOCHAT_MODE_NAMES = ["off", "limited", "unlimited"] as const;

export const AGENTBRIDGE_SUBCOMMANDS: readonly Choice[] = SUBCOMMAND_NAMES.map((name) => ({
 name,
 description: COMPLETION_TEXT.subcommands[name],
}));

const AUTOCHAT_MODES: readonly Choice[] = AUTOCHAT_MODE_NAMES.map((name) => ({
 name,
 description: COMPLETION_TEXT.autochatModes[name],
}));

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
