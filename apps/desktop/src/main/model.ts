// The agent's model: which one, and how OpenRouter serves it.
import type { LlmConfig } from "@kiframe/agent"

/** The agent's model by default (OpenRouter ids; a picker comes later). */
export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash"

/**
 * The agent's model, served by OpenRouter's fastest provider for it (as `:nitro`): the default
 * route ran at 95–188 tokens/s against 245–318, and the agent's turns took minutes.
 */
export function modelConfig(apiKey: string): LlmConfig {
  return { apiKey, model: DEFAULT_MODEL, fastestProvider: true }
}
