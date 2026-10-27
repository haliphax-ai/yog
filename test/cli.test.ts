import { describe, expect, it } from "vitest";
import { parseCliArgs, parseServeArgs } from "../src/cli.ts";

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

  it("rejects the serve subcommand (parse it with parseServeArgs)", () => {
    expect(parseCliArgs(["serve"])).toHaveProperty("error");
  });
});

describe("parseServeArgs", () => {
  it("parses `serve` with no flags (env/defaults apply)", () => {
    expect(parseServeArgs(["serve"])).toEqual({});
  });

  it("parses --host and --port in both split and = forms", () => {
    expect(parseServeArgs(["serve", "--host", "0.0.0.0", "--port", "9000"])).toEqual({
      host: "0.0.0.0",
      port: 9000,
    });
    expect(parseServeArgs(["serve", "--host=10.0.0.1", "--port=8111"])).toEqual({
      host: "10.0.0.1",
      port: 8111,
    });
  });

  it("allows port 0 (ephemeral port, used by tests)", () => {
    expect(parseServeArgs(["serve", "--port", "0"])).toEqual({ port: 0 });
  });

  it("rejects a non-serve subcommand", () => {
    expect(parseServeArgs(["run", "gpt-x", "hi"])).toHaveProperty("error");
    expect(parseServeArgs([])).toHaveProperty("error");
  });

  it("rejects malformed options and out-of-range ports", () => {
    expect(parseServeArgs(["serve", "--port"])).toHaveProperty("error");
    expect(parseServeArgs(["serve", "--host"])).toHaveProperty("error");
    expect(parseServeArgs(["serve", "--nope"])).toHaveProperty("error");
    expect(parseServeArgs(["serve", "--port", "abc"])).toHaveProperty("error");
    expect(parseServeArgs(["serve", "--port", "-1"])).toHaveProperty("error");
    expect(parseServeArgs(["serve", "--port", "70000"])).toHaveProperty("error");
    expect(parseServeArgs(["serve", "--host", ""])).toHaveProperty("error");
  });
});
