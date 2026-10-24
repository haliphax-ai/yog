import { describe, expect, it } from "vitest";
import { ListDescriptor } from "../src/fs/list.ts";

describe("ListDescriptor", () => {
  it("renders empty as empty string", () => {
    const s = new ListDescriptor();
    expect(s.render()).toBe("");
    expect(s.size).toBe(0);
  });

  it("renders items one per line with trailing newline", () => {
    const s = new ListDescriptor();
    s.commit("append", "alpha\nbeta\n");
    expect(s.render()).toBe("alpha\nbeta\n");
    expect(s.size).toBe(11);
  });

  it("append adds items to the end", () => {
    const s = new ListDescriptor();
    s.commit("append", "one\ntwo\n");
    s.commit("append", "three\n");
    expect(s.items).toEqual(["one", "two", "three"]);
  });

  it("append ignores NUL padding", () => {
    const s = new ListDescriptor();
    s.commit("append", "one\0\0\0");
    expect(s.items).toEqual(["one"]);
  });

  it("replace rewrites the whole list", () => {
    const s = new ListDescriptor();
    s.commit("append", "one\ntwo\n");
    s.commit("replace", "solo\n");
    expect(s.items).toEqual(["solo"]);
  });

  it("replace with empty text clears the list", () => {
    const s = new ListDescriptor();
    s.commit("append", "one\n");
    s.commit("replace", "");
    expect(s.items).toEqual([]);
    expect(s.render()).toBe("");
  });

  it("replace drops a trailing newline", () => {
    const s = new ListDescriptor();
    s.commit("replace", "a\nb\n");
    expect(s.items).toEqual(["a", "b"]);
  });

  it("reset clears the list", () => {
    const s = new ListDescriptor();
    s.commit("append", "one\n");
    s.reset();
    expect(s.items).toEqual([]);
    expect(s.render()).toBe("");
  });
});
