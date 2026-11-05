import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelInfoCache } from "../src/server/modelInfo.ts";

/** Minimal models.dev-shaped fixture: providers → models, each with a limit. */
const SOURCE = JSON.stringify({
  "provider-a": {
    id: "provider-a",
    name: "Provider A",
    models: {
      "model-short": {
        id: "model-short",
        name: "Short context",
        limit: { context: 8000, output: 2000 },
      },
      "model-long": {
        id: "model-long",
        name: "Long context",
        limit: { context: 1_100_000, output: 16000 },
      },
      "model-no-limit": {
        id: "model-no-limit",
        name: "No limit info",
      },
    },
  },
  "provider-b": {
    id: "provider-b",
    models: {
      "model-plain": { id: "model-plain" },
    },
  },
});

describe("ModelInfoCache", () => {
  it("flattens provider model data and serves context-window lookups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      await writeFile(sourcePath, SOURCE);

      const cache = new ModelInfoCache(cachePath, sourcePath);
      await cache.load();

      expect(cache.getContextWindow("model-short")).toBe(8000);
      expect(cache.getContextWindow("model-long")).toBe(1_100_000);
      // Entries without limit info still flatten; context is undefined.
      expect(cache.getContextWindow("model-no-limit")).toBeUndefined();
      expect(cache.getContextWindow("model-plain")).toBeUndefined();
      // Unknown model id is not an error.
      expect(cache.getContextWindow("nope")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reuses a fresh cache instead of re-reading the source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      await writeFile(sourcePath, SOURCE);

      const cache = new ModelInfoCache(cachePath, sourcePath);
      await cache.load();
      expect(cache.getContextWindow("model-long")).toBe(1_100_000);

      // Change the source after the first load; a fresh cache must win.
      await writeFile(
        sourcePath,
        JSON.stringify({
          "provider-a": {
            models: { "model-long": { limit: { context: 999 } } },
          },
        }),
      );

      const cache2 = new ModelInfoCache(cachePath, sourcePath);
      await cache2.load();
      expect(cache2.getContextWindow("model-long")).toBe(1_100_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshes when the cache is stale (older than 24h)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      await writeFile(sourcePath, SOURCE);

      const cache = new ModelInfoCache(cachePath, sourcePath);
      await cache.load();
      expect(cache.getContextWindow("model-long")).toBe(1_100_000);

      // Age the cache file past the 24h threshold, then change the source.
      const old = Date.now() / 1000 - 25 * 60 * 60;
      await utimes(cachePath, old, old);
      await writeFile(
        sourcePath,
        JSON.stringify({
          "provider-a": {
            models: { "model-long": { limit: { context: 777 } } },
          },
        }),
      );

      const cache2 = new ModelInfoCache(cachePath, sourcePath);
      await cache2.load();
      expect(cache2.getContextWindow("model-long")).toBe(777);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
