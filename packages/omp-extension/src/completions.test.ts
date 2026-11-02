import { describe, expect, test } from "bun:test";
import { AGENTBRIDGE_SUBCOMMANDS, agentbridgeArgumentCompletions } from "./completions";

const values = (prefix: string) => agentbridgeArgumentCompletions(prefix)?.map((item) => item.value) ?? null;

describe("agentbridgeArgumentCompletions", () => {
 test("empty prefix lists every subcommand", () => {
  expect(values("")).toEqual(AGENTBRIDGE_SUBCOMMANDS.map((sub) => `${sub.name} `));
 });

 test("filters subcommands by prefix, case-insensitively", () => {
  expect(values("un")).toEqual(["untrust "]);
  expect(values("O")).toEqual(["off ", "on "]);
  expect(values("dis")).toEqual(["disallow "]);
 });

 test("no match returns null", () => {
  expect(values("xyz")).toBeNull();
 });

 test("autochat completes modes and keeps the subcommand in value", () => {
  expect(values("autochat ")).toEqual(["autochat off ", "autochat limited ", "autochat unlimited "]);
  expect(values("autochat li")).toEqual(["autochat limited "]);
  expect(values("AutoChat  u")).toEqual(["AutoChat  unlimited "]);
 });

 test("stops after the mode token and for other subcommands", () => {
  expect(values("autochat limited ")).toBeNull();
  expect(values("autochat limited 3")).toBeNull();
  expect(values("status ")).toBeNull();
 });

 test("items carry label and description", () => {
  const [item] = agentbridgeArgumentCompletions("cle") ?? [];
  expect(item).toEqual({ value: "clear ", label: "clear", description: expect.any(String) });
 });
});
