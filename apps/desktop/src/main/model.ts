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

/** OpenRouter's model list (public: no key), with each model's input kinds. */
const MODELS_URL = "https://openrouter.ai/api/v1/models"
const MODELS_MS = 5000

/**
 * Whether OpenRouter's model list says `model` takes images (its `input_modalities`); undefined
 * when it can't say (offline, the list failing or changed, the model not listed).
 */
export async function listedTakesImages(
  model: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean | undefined> {
  try {
    const response = await fetchFn(MODELS_URL, { signal: AbortSignal.timeout(MODELS_MS) })
    if (!response.ok) return undefined
    const list = (await response.json()) as { data?: unknown }
    if (!Array.isArray(list.data)) return undefined
    const entry = (
      list.data as { id?: unknown; architecture?: { input_modalities?: unknown } }[]
    ).find((m) => m.id === model)
    const kinds = entry?.architecture?.input_modalities
    return Array.isArray(kinds) ? kinds.includes("image") : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the model takes images, asked of OpenRouter once per model while the app runs (calls
 * meanwhile wait for that one answer). Unknown: it does for the app's run (the default model takes
 * images; a provider refusing one says so as the run's error), said once in the log.
 */
export function imageInput(
  fetchFn: typeof fetch = fetch,
  log: (line: string) => void = console.warn,
): (model: string) => Promise<boolean> {
  const asked = new Map<string, Promise<boolean>>()
  return (model) => {
    const kept = asked.get(model)
    if (kept !== undefined) return kept
    const answer = listedTakesImages(model, fetchFn).then((listed) => {
      if (listed !== undefined) return listed
      log(`couldn't tell whether ${model} takes images (OpenRouter's model list): assumed it does`)
      return true
    })
    asked.set(model, answer)
    return answer
  }
}
