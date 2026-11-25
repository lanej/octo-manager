import { test, expect } from "bun:test";
import { commandTree, CommanderError } from "../src/cli/command-tree.js";
import { parseCommand } from "../src/cli/arguments.js";
test("Commander provides nested help and rejects invalid input before invoking a capability", async () => {
  let calls = 0,
    output = "";
  const program = commandTree(
    {},
    () => {
      calls++;
    },
    {
      writeOut: (value) => {
        output += value;
      },
      writeErr: () => {},
    },
  );
  try {
    await program.parseAsync(["messages", "ack", "--help"], { from: "user" });
  } catch (error) {
    expect(error).toBeInstanceOf(CommanderError);
  }
  expect(output).toContain("messages ack");
  expect(output).toContain("<id>");
  expect(calls).toBe(0);
  for (const args of [
    ["pr", "track"],
    ["messages", "ack"],
    ["pr", "show", "id", "--model", "bad"],
    ["activity", "list", "--after", "-1"],
    ["pr", "auto-merge", "id", "--on", "--off"],
  ]) {
    expect(() => parseCommand(args, {})).toThrow();
  }
  expect(
    parseCommand(["messages", "ack", "12345678"], { CODEX_THREAD_ID: "thread" })
      .positionals,
  ).toEqual(["ack", "12345678"]);
  expect(
    parseCommand(
      ["history", "policy", "owner/repo", "--policy-version", "2"],
      {},
    ).values["policy-version"],
  ).toBe("2");
});
