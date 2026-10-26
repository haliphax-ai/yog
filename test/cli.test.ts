import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.ts";

describe("parseCliArgs", () => {
  it("parses `run <model> <prompt>` and joins prompt words", () => {
    expect(parseCliArgs(["run", "gpt-x", "hello", "world"])).toEqual({
      modelId: "gpt-x",
      prompt: "hello world",
    });
  });

  it("rejects bare `<model> <prompt>` (replaced by the run subcommand)", () => {
    const r = parseCliArgs(["gpt-x", "hello"]);
    expect(r).toHaveProperty("error");
  });

  it("rejects a missing model id", () => {
    expect(parseCliArgs(["run"])).toHaveProperty("error");
    expect(parseCliArgs(["run", "", "hi"])).toHaveProperty("error");
  });

  it("rejects a missing prompt", () => {
    expect(parseCliArgs(["run", "gpt-x"])).toHaveProperty("error");
  });
});
