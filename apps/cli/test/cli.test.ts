import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgram } from "../src/index.ts";

test("CLI program registers core metadata and info subcommand", () => {
  const program = createProgram({ EEVEE_HOME: "/tmp/eevee-cli-test" });
  assert.equal(program.name(), "eevee");
  const commands = program.commands.map((command) => command.name());
  assert.ok(commands.includes("info"));
});
