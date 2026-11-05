import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, utimes, rm } from "node:fs/promises";
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

/** A fetch stub that always rejects — simulates an air-gapped/offline start. */
function stubFetchOffline(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.reject(new Error("offline")));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A fetch stub that serves a fixed document — simulates a live API. */
function stubFetchOnline(document: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => document,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Age a file past the 24h cache threshold. */
async function agePastThreshold(path: string): Promise<void> {
  const old = Date.now() / 1000 - 25 * 60 * 60;
  await utimes(path, old, old);
}

describe("ModelInfoCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flattens provider model data and serves context-window lookups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      await writeFile(sourcePath, SOURCE);
      stubFetchOffline(); // offline: parse the local source

      const cache = new ModelInfoCache(cachePath, sourcePath);
      await cache.load();

      expect(cache.getContextWindow("model-short")).toBe(8000);
      expect(cache.getContextWindow("model-long")).toBe(1_100_000);
      expect(cache.getContextWindow("model-no-limit")).toBeUndefined();
      expect(cache.getContextWindow("model-plain")).toBeUndefined();
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
      const fetchMock = stubFetchOffline();

      const cache = new ModelInfoCache(cachePath, sourcePath);
      await cache.load();
      expect(cache.getContextWindow("model-long")).toBe(1_100_000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // one refresh attempt

      // Change the source after the first load; a fresh cache must win and
      // must not touch the network again.
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
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshes from the local source when stale and offline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      await writeFile(sourcePath, SOURCE);
      stubFetchOffline();

      const cache = new ModelInfoCache(cachePath, sourcePath);
      await cache.load();
      await agePastThreshold(cachePath);
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

  it("fetches from models.dev when the local source is missing and persists it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      const fetchMock = stubFetchOnline(SOURCE); // no local source on disk

      const cache = new ModelInfoCache(cachePath, sourcePath);
      await cache.load();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cache.getContextWindow("model-long")).toBe(1_100_000);
      await expect(readFile(sourcePath, "utf8")).resolves.toBe(SOURCE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not hit the network while the flattened cache is fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      await writeFile(sourcePath, SOURCE);
      stubFetchOffline(); // seed the cache from the local mirror

      const c1 = new ModelInfoCache(cachePath, sourcePath);
      await c1.load();

      // Refuse network; the fresh cache must satisfy the next start without it.
      const strict = vi.fn(() => {
        throw new Error("network must not be used");
      });
      vi.stubGlobal("fetch", strict);

      const c2 = new ModelInfoCache(cachePath, sourcePath);
      await c2.load();
      expect(strict).not.toHaveBeenCalled();
      expect(c2.getContextWindow("model-short")).toBe(8000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers live API data over the local mirror when refresh is due", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yog-modelinfo-"));
    try {
      const sourcePath = join(dir, "models.json");
      const cachePath = join(dir, "model-info.json");
      await writeFile(sourcePath, SOURCE);
      stubFetchOffline(); // first start: cache+mirror seeded from local source

      const c1 = new ModelInfoCache(cachePath, sourcePath);
      await c1.load();
      await agePastThreshold(cachePath);

      const newer = JSON.stringify({
        "provider-a": {
          models: { "model-long": { limit: { context: 321 } } },
        },
      });
      const online = stubFetchOnline(newer);

      const c2 = new ModelInfoCache(cachePath, sourcePath);
      await c2.load();
      expect(online).toHaveBeenCalledTimes(1);
      expect(c2.getContextWindow("model-long")).toBe(321);
      // The live snapshot replaced the frozen local mirror.
      await expect(readFile(sourcePath, "utf8")).resolves.toBe(newer);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
