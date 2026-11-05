/**
 * Model information cache — loads models.dev API JSON and provides
 * context-window lookups. The cache lives in the state dir and is
 * refreshed only when it is at least 24 hours old.
 */

import { readFile, writeFile, stat } from "../host.ts";
import { logger } from "../log.ts";

export interface ModelLimit {
  context?: number;
  output?: number;
  input?: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  limit?: ModelLimit;
}

export interface ModelsDevCache {
  models: Record<string, ModelInfo>;
  lastUpdated: number;
}

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ModelInfoCache {
  private cache: ModelsDevCache | null = null;
  private readonly cachePath: string;
  private readonly sourcePath: string;

  constructor(cachePath: string, sourcePath: string) {
    this.cachePath = cachePath;
    this.sourcePath = sourcePath;
  }

  async load(): Promise<ModelsDevCache> {
    // Try to load from cache first
    try {
      const info = await stat(this.cachePath);
      const age = Date.now() - info.mtimeMs;
      if (age < CACHE_MAX_AGE_MS) {
        const data = await readFile(this.cachePath, "utf8");
        this.cache = JSON.parse(data) as ModelsDevCache;
        return this.cache;
      }
    } catch {
      // Cache doesn't exist or is stale — will refresh from source
    }

    return this.refresh();
  }

  async refresh(): Promise<ModelsDevCache> {
    try {
      const data = await readFile(this.sourcePath, "utf8");
      const source = JSON.parse(data) as Record<string, any>;

      // Flatten the provider → models structure into a simple map
      const models: Record<string, ModelInfo> = {};
      for (const [, providerData] of Object.entries(source)) {
        const pd = providerData?.models as Record<string, ModelInfo> | undefined;
        if (pd) {
          for (const [modelId, modelData] of Object.entries(pd)) {
            models[modelId] = {
              id: modelId,
              name: modelData.name,
              limit: modelData.limit,
            };
          }
        }
      }

      this.cache = { models, lastUpdated: Date.now() };

      // Persist the cache
      try {
        await writeFile(this.cachePath, JSON.stringify(this.cache));
      } catch (err) {
        logger.warn(`[modelInfo] failed to write cache: ${(err as Error).message}`);
      }

      return this.cache;
    } catch (err) {
      logger.error(`[modelInfo] failed to load models.dev data: ${(err as Error).message}`);
      throw err;
    }
  }

  getContextWindow(modelId: string): number | undefined {
    if (!this.cache) return undefined;
    const model = this.cache.models[modelId];
    return model?.limit?.context;
  }
}
