import { defineTool, type Tool } from "@kiframe/agent"
import { saveScene } from "@kiframe/project"
import { SceneId } from "@kiframe/schema"
import { z } from "zod"
import { parse as parseYaml } from "yaml"
import { type Studio, stepOutcome } from "./studio.ts"

// The agent's tools for Kiframe: look at and act on the live app, write and check scenes, record
// them. Each heeds the run's signal (a stop ends a step, a replay or a recording at its next step,
// and closes a question to the user).

const sceneId = SceneId.describe("the scene's id (kebab-case, unique in the project)")

const listScenes = defineTool({
  name: "list_scenes",
  description:
    "The project's scenes, in story order: id, title, and whether each is grounded and recorded.",
  parameters: z.object({}),
  run: (_args, studio: Studio) =>
    Promise.resolve(
      studio.project.project.sequence.map((id) => {
        const stored = studio.project.scenes.get(id)
        return {
          id,
          title: stored?.scene.title ?? "(unreadable)",
          grounded: stored?.scenario !== undefined,
          recorded: stored?.composition !== undefined,
        }
      }),
    ),
})

const snapshot = defineTool({
  name: "snapshot",
  description: "Accessibility snapshot of the live page (or of one region) and its URL.",
  parameters: z.object({
    within: z
      .unknown()
      .optional()
      .describe("A locator for a region, e.g. {by: role, role: dialog}"),
  }),
  run: ({ within }, studio: Studio) => studio.snapshot(within),
})

const runStep = defineTool({
  name: "run_step",
  description:
    "Run ONE step on the live page (a steps item, or a setup/teardown action). Returns ok or why it failed.",
  parameters: z.object({
    scene: SceneId.describe("the id you'll save this scene under (its approvals are that scene's)"),
    step: z.unknown().describe("The step, same fields as in the YAML"),
    part: z
      .enum(["setup", "steps", "teardown"])
      .default("steps")
      .describe("the part of the scene it's for (its approvals are that part's)"),
  }),
  run: ({ scene, step, part }, studio: Studio, signal) => studio.runStep(step, scene, signal, part),
})

const runSteps = defineTool({
  name: "run_steps",
  description:
    "Run SEVERAL steps on the live page, in order (each like run_step's); stops at the first that fails. Use it once you know the locators: one call instead of one per step.",
  parameters: z.object({
    scene: SceneId.describe("the id you'll save this scene under"),
    steps: z
      .union([z.array(z.unknown()).min(1).max(20), z.string().max(50_000)])
      .describe("The steps, same fields as in the YAML (a list)"),
    part: z.enum(["setup", "steps", "teardown"]).default("steps").describe("the part they're for"),
  }),
  run: async ({ scene, steps, part }, studio: Studio, signal) => {
    // A list sent as YAML or JSON text (FAILURE-CATALOGUE #11) is read as the list it says.
    const list = typeof steps === "string" ? (parseYaml(steps) as unknown) : steps
    if (!Array.isArray(list) || list.length === 0 || list.length > 20) {
      return { error: "steps: a list of 1 to 20 steps" }
    }
    const out: string[] = []
    for (const [i, step] of list.entries()) {
      const result = await studio.runStep(step, scene, signal, part)
      out.push(`${i + 1}. ${result}`)
      // Only on: a step that failed, closed every page or left the app's site stops the rest.
      if (stepOutcome(result) !== "ok") {
        const left = list.length - i - 1
        if (left > 0) out.push(`stopped there: the ${left} after it didn't run`)
        break
      }
    }
    return out.join("\n")
  },
})

const listSecrets = defineTool({
  name: "list_secrets",
  description: "Names of the secrets the user provided (never their values).",
  parameters: z.object({}),
  run: (_args, studio: Studio) => {
    const secrets = studio.options.secrets?.() ?? []
    return Promise.resolve(
      secrets.length === 0
        ? "none"
        : secrets.map((s) => `${s.name}${s.provided ? "" : " (missing)"}`).join(", "),
    )
  },
})

const askUser = defineTool({
  name: "ask_user",
  description:
    "Ask the user a question when blocked (a missing secret, an ambiguous goal). Ask only for real blockers.",
  parameters: z.object({ question: z.string().min(1) }),
  run: async ({ question }, studio: Studio, signal) => {
    const answer = await studio.options.requestUser({ kind: "question", question }, signal)
    return { answer: String(answer) }
  },
})

const saveSceneTool = defineTool({
  name: "save_scene",
  description:
    "Save a scene: its complete scenario YAML is validated and replayed from scratch in a fresh browser; saved only if the replay passes (the result comes back).",
  parameters: z.object({
    id: sceneId,
    title: z.string().min(1).max(200),
    notes: z
      .string()
      .min(1)
      .max(10_000)
      .optional()
      .describe("The brief: what the scene shows and why"),
    yaml: z.string().min(1),
  }),
  run: async ({ id, title, notes, yaml }, studio: Studio, signal) => {
    // An existing scene keeps what the agent doesn't set (its transition, its notes); a card is
    // never turned into a recording.
    // One whose scene.json didn't read may be anything (a card with a typo): never overwritten.
    if (studio.project.problems.some((p) => p.sceneId === id && p.part === "scene")) {
      return { error: `scene "${id}" didn't read: pick another id, or fix its scene.json` }
    }
    const existing = studio.project.scenes.get(id)?.scene
    if (existing !== undefined && existing.source.kind !== "recording") {
      return { error: `scene "${id}" is a ${existing.source.kind} scene: pick another id` }
    }
    const checked = studio.check(yaml)
    if ("error" in checked) return { error: checked.error }
    const result = await studio.replay(checked.scenario, id, signal)
    if (result !== "ok") return { error: result }
    const scene = {
      version: 1 as const,
      source: { kind: "recording" as const },
      duration: { mode: "auto" as const },
      ...existing,
      id,
      title,
      ...(notes !== undefined && { notes }),
    }
    // A new scenario: its old composition (of another take) goes; record the scene again.
    saveScene(studio.project, scene, { scenario: checked.scenario, composition: null })
    return "saved: the replay passed. Record it with record_scene."
  },
})

const recordScene = defineTool({
  name: "record_scene",
  description:
    "Record a saved scene at human pace for the video (takes as long as the scene plays).",
  parameters: z.object({ id: sceneId }),
  run: ({ id }, studio: Studio, signal) => studio.record(id, signal),
})

/**
 * A tool whose result and error are scrubbed on their way to the model: once, here, for every path
 * (this tool's and any added later; a user's answer quoting a value too).
 */
function scrubbed(tool: Tool<Studio>): Tool<Studio> {
  return {
    ...tool,
    run: async (args, studio, signal) => {
      let result: unknown
      try {
        // The run's signal, and the studio's: closing it stops every tool and dialog.
        result = await tool.run(args, studio, AbortSignal.any([signal, studio.closed]))
      } catch (error) {
        // A new error of the same name (the caught one may not be writable: a DOMException), and
        // no cause: that's the unscrubbed one.
        const scrub = studio.scrubber()
        const scrubbed = new Error(scrub(error instanceof Error ? error.message : String(error)))
        if (error instanceof Error) scrubbed.name = error.name
        throw scrubbed
      }
      return scrubDeep(result, studio.scrubber())
    },
  }
}

function scrubDeep(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value)
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)]))
  }
  return value
}

/** Every tool of the studio. */
export const studioTools: Tool<Studio>[] = [
  listScenes,
  snapshot,
  runStep,
  runSteps,
  listSecrets,
  askUser,
  saveSceneTool,
  recordScene,
].map(scrubbed)
