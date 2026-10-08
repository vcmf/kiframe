import { describe, expect, it } from "vitest"
import { imageInput, listedTakesImages, modelConfig } from "../src/main/model.ts"

describe("the agent's model", () => {
  it("is served by OpenRouter's fastest provider (the default route took minutes a turn)", () => {
    expect(modelConfig("k")).toEqual({
      apiKey: "k",
      model: "deepseek/deepseek-v4.1-flash",
      fastestProvider: true,
    })
  })
})

/** OpenRouter's model list as it answers (a fetch counting its calls). */
function listing(body: unknown, status = 200) {
  const calls: string[] = []
  const fetchFn = ((url: string) => {
    calls.push(url)
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }) as typeof fetch
  return { fetchFn, calls }
}

const MODELS = {
  data: [
    { id: "a/sees", architecture: { input_modalities: ["text", "image"] } },
    { id: "a/reads", architecture: { input_modalities: ["text"] } },
    { id: "a/odd", architecture: {} },
  ],
}

describe("whether the model takes images", () => {
  it("is what OpenRouter's model list says, unknown when it can't say", async () => {
    const { fetchFn, calls } = listing(MODELS)
    expect(await listedTakesImages("a/sees", fetchFn)).toBe(true)
    expect(await listedTakesImages("a/reads", fetchFn)).toBe(false)
    expect(await listedTakesImages("a/odd", fetchFn)).toBeUndefined()
    expect(await listedTakesImages("a/unlisted", fetchFn)).toBeUndefined()
    expect(calls[0]).toBe("https://openrouter.ai/api/v1/models")
    expect(await listedTakesImages("a/sees", listing(MODELS, 500).fetchFn)).toBeUndefined()
    expect(await listedTakesImages("a/sees", listing({ models: [] }).fetchFn)).toBeUndefined()
    const offline = (() => Promise.reject(new Error("offline"))) as typeof fetch
    expect(await listedTakesImages("a/sees", offline)).toBeUndefined()
  })

  it("is asked once per model (calls meanwhile wait for it), unknown taken as yes", async () => {
    const { fetchFn, calls } = listing(MODELS)
    const logged: string[] = []
    const sees = imageInput(fetchFn, (line) => logged.push(line))
    expect(await Promise.all([sees("a/reads"), sees("a/reads")])).toEqual([false, false])
    expect(await sees("a/reads")).toBe(false)
    expect(calls).toHaveLength(1)
    expect(await sees("a/unlisted")).toBe(true)
    expect(await sees("a/unlisted")).toBe(true)
    expect(calls).toHaveLength(2)
    expect(logged).toEqual([
      "couldn't tell whether a/unlisted takes images (OpenRouter's model list): assumed it does",
    ])
  })
})
