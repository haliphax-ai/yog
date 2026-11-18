/**
 * The model-provider transport: the one place that constructs an OpenAI
 * (or OpenAI-compatible) client for the daemon. dependency-cruiser pins
 * the value import of the SDK to `server/serve.ts` and these `daemon/`
 * modules — everything else receives the client injected.
 *
 * Per AGENTS.md ("progressive provider enhancement"): the base
 * OpenAI-compatible spec is the contract; OpenRouter's host-specific
 * headers are added only when the endpoint actually is OpenRouter.
 */
import OpenAI from "openai";
import type { YogConfig } from "../../config.ts";

/** Check if a hostname is openrouter.ai or a subdomain. */
export function isOpenRouterHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");
  return normalized === "openrouter.ai" || normalized.endsWith(".openrouter.ai");
}

/** The attribution headers OpenRouter keys dashboards on. */
function openRouterHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": "https://github.com/haliphax-ai/yog",
    "X-OpenRouter-Title": "yog",
    "X-OpenRouter-Categories": "cli-agent,cloud-agent",
  };
}

/** OpenAI client built from the injected configuration (proxy/key overrides; SDK defaults when unset). */
export function openaiClient(config: YogConfig): OpenAI {
  const baseURL = config.providerBaseUrl;
  const extraHeaders: Record<string, string> = {};
  if (baseURL !== undefined) {
    try {
      if (isOpenRouterHostname(new URL(baseURL).hostname)) {
        Object.assign(extraHeaders, openRouterHeaders());
      }
    } catch {
      // Invalid URL - ignore extra headers
    }
  }
  return new OpenAI({
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(config.providerApiKey !== undefined ? { apiKey: config.providerApiKey } : {}),
    ...(Object.keys(extraHeaders).length > 0 ? { defaultHeaders: extraHeaders } : {}),
  });
}
