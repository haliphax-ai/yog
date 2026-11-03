import { describe, expect, it } from "vitest";
import { parseServeArgs } from "../src/cli.ts";

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
