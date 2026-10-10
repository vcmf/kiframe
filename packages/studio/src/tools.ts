import { defineTool, isWithImages, needsUser, type Tool, withImages } from "@kiframe/agent"
import { saveScene } from "@kiframe/project"
import { AppName, firstApp, RuleName, SceneId, webAppsOf } from "@kiframe/schema"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { fileTools } from "./file-tools.ts"
import { isCyclic } from "./refs.ts"
import { asObject, type ScenarioPart, type StepResult, type Studio } from "./studio.ts"

// The agent's tools for Kiframe: look at and act on the live app, write and check scenes, record
// them. Each heeds the run's signal (a stop ends a step, a replay or a recording at its next step,
// and closes a question to the user).

/**
 * An outcome as the model and the chat read it: its text when it worked, a failure as `{ error }`
 * (the loop's and the chat's own protocol: never told apart by its words).
 */
function said(result: StepResult): string | { error: string } {
  return result.ok ? result.text : { error: result.text }
}

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
  description:
    "Accessibility snapshot of the live page (or of one region) and its URL; each element has a ref ([ref=e12]) to point at it in run_step.",
  parameters: z.object({
    within: z
      .unknown()
      .optional()
      .describe("A locator for a region, e.g. {by: role, role: dialog}"),
    find: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Text to look for: only the elements that mention it, with where they are and their refs (as a reader: case, dashes and quotes don't matter; a phrase may run over a paragraph's links; with no exact match, the blocks holding all its words). For content further down a long page, past the snapshot's cut",
      ),
  }),
  run: async ({ within, find }, studio: Studio, signal) =>
    said(await studio.snapshot(within, find, signal)),
})

const look = defineTool({
  name: "look",
  description:
    "See the live page as an image (secrets painted over): where the snapshot can't see (a canvas, a chart, a map, an image) and to check what a step did on screen. With `ref` (of the last snapshot), the image is that element: an `at` fraction on it is a position in the image.",
  parameters: z.object({
    ref: z
      .string()
      .optional()
      .describe("an element of the last snapshot (e.g. the drawing canvas): only it is shown"),
  }),
  run: async ({ ref }, studio: Studio, signal) => {
    const refused = await studio.refusedImages()
    if (refused !== undefined) return refused
    const seen = await studio.look(ref, signal)
    if ("error" in seen) return seen
    return withImages(seen.text, [{ url: seen.image }])
  },
})

const handOver = defineTool({
  name: "hand_over",
  description:
    "Hand the live browser to the user for a moment: a one-time or 2FA code, a CAPTCHA, a payment, anything you can't do with steps. You see nothing until they're done (then take a snapshot). Never for a password (the user adds it in Secrets).",
  parameters: z.object({
    task: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("what the user should do, one sentence they can act on"),
    done_when: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("how they'll know it's done (e.g. 'the dashboard shows')"),
  }),
  run: ({ task, done_when }, studio: Studio, signal) => studio.handOver(task, done_when, signal),
})

const savePresetTool = defineTool({
  name: "save_preset",
  description:
    "Save a project preset: off-camera steps several scenes share (a sign-in, its handover included). `session: true` for a sign-in: checking and recording a scene that starts with { preset: <name> } sign in once, then reuse it (the user is asked for a code once). A session preset ends with a waitFor or expect on the signed-in page. A new name only.",
  parameters: z.object({
    name: RuleName.describe("a new name (kebab-case)"),
    session: z.boolean(),
    app: AppName.optional().describe("the app its steps start in (default: the first)"),
    yaml: z.string().min(1).describe("its steps: a YAML list of off-camera actions"),
  }),
  run: ({ name, session, app, yaml }, studio: Studio) => {
    let steps: unknown
    try {
      steps = parseYaml(yaml)
    } catch (error) {
      return Promise.resolve({ error: `yaml: ${String(error).split("\n")[0]}` })
    }
    return Promise.resolve(
      studio.savePreset({ name, session, ...(app !== undefined && { app }), steps }),
    )
  },
})

/** A run_step's scene start app (by name; checked against the project's apps in the studio). */
const startApp = AppName.optional().describe(
  "the scene's start app (its top-level `app:`): steps without an app mean it. Default: the one its last step ran in, else its saved `app:`, else the first app",
)

const runStep = defineTool({
  name: "run_step",
  description:
    "Run ONE step on the live page (a steps item, or a setup action). Returns ok or why it failed.",
  parameters: z.object({
    scene: SceneId.describe("the id you'll save this scene under (its approvals are that scene's)"),
    step: z
      .unknown()
      .describe(
        "The step, same fields as in the YAML; where it takes a locator, { ref: e12 } from the last snapshot works too",
      ),
    part: z
      .enum(["setup", "steps"])
      .default("steps")
      .describe("the part of the scene it's for (its approvals are that part's)"),
    start_app: startApp,
  }),
  run: async ({ scene, step, part, start_app }, studio: Studio, signal) =>
    said(await studio.runStep(step, scene, signal, part, start_app)),
})

const runSteps = defineTool({
  name: "run_steps",
  description:
    "Run SEVERAL steps on the live page, in order (each like run_step's); stops at the first that fails. Use it once you know the locators: one call instead of one per step.",
  parameters: z.object({
    scene: SceneId.describe("the id you'll save this scene under"),
    steps: z
      .union([z.array(z.unknown()).min(1).max(20), z.string().max(50_000)])
      .describe(
        "The steps, same fields as in the YAML (a list); refs of the last snapshot work too",
      ),
    part: z.enum(["setup", "steps"]).default("steps").describe("the part they're for"),
    start_app: startApp,
  }),
  run: async ({ scene, steps, part, start_app }, studio: Studio, signal) => {
    // A list sent as YAML or JSON text (FAILURE-CATALOGUE #11) is read as the list it says.
    const list = asObject(steps)
    if (!Array.isArray(list) || list.length === 0 || list.length > 20) {
      return { error: "steps: a list of 1 to 20 steps" }
    }
    // Every item read once (an item sent as text too), and its refs checked before anything runs.
    const items = (list as unknown[]).map((item) => asObject(item))
    if (isCyclic(items))
      return { error: "nothing ran: a YAML alias refers to itself (or it nests too deep)" }
    const notStep = items.findIndex((item) => typeof item !== "object" || item === null)
    if (notStep >= 0) return { error: `nothing ran: item ${notStep + 1} isn't a step (an object)` }
    let refused: string | undefined
    try {
      refused = await studio.refusedRefs(items, signal)
    } catch (error) {
      // A stop ends the call; a page that closed or moved while the refs were checked is said.
      if (signal.aborted) throw error
      refused = `the refs couldn't be checked: ${studio.scrub(error instanceof Error ? error.message : String(error))}`
    }
    if (refused !== undefined) return { error: `nothing ran: ${refused}` }
    return runAll(items, scene, part, studio, signal, start_app)
  },
})

async function runAll(
  list: unknown[],
  scene: string,
  part: ScenarioPart,
  studio: Studio,
  signal: AbortSignal,
  startApp: string | undefined,
): Promise<string | { error: string }> {
  const out: string[] = []
  for (const [i, step] of list.entries()) {
    let result: StepResult
    try {
      result = await studio.runStep(step, scene, signal, part, startApp)
    } catch (error) {
      // A stop ends the call; anything else is this step's failure, the ones before it kept.
      if (signal.aborted) throw error
      result = {
        ok: false,
        text: `failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    out.push(`${i + 1}. ${result.text}`)
    const left = list.length - i - 1
    const stopped = left > 0 ? [`stopped there: the ${left} after it didn't run`] : []
    // The first line says the outcome (the line the chat shows), then every step's.
    // A failed step: the call fails, that step's reason first.
    if (!result.ok) {
      return { error: [`step ${i + 1} ${result.text}`, ...out, ...stopped].join("\n") }
    }
    // On another site: what follows would run there (not a failure: said, and stopped).
    if (result.site === "other") {
      return [`step ${i + 1} left the project's apps`, ...out, ...stopped].join("\n")
    }
  }
  return [`${list.length} ${list.length === 1 ? "step" : "steps"} ok`, ...out].join("\n")
}

const listSecrets = defineTool({
  name: "list_secrets",
  description:
    "Names of the secrets the user provided (never their values), each with the app it's typed on.",
  parameters: z.object({}),
  run: (_args, studio: Studio) => {
    // App by app (each its exact origin): a secret is typed only on its own app; a desktop app
    // takes none (the user signs in by hand).
    const apps = Object.entries(webAppsOf(studio.options.config.apps))
    const secrets = apps.flatMap(([app, { url }]) =>
      (studio.options.secrets?.(new URL(url).origin) ?? []).map((s) => ({ ...s, app })),
    )
    const named = apps.length > 1
    return Promise.resolve(
      secrets.length === 0
        ? "none"
        : secrets
            .map((s) => {
              const notes = [...(named ? [s.app] : []), ...(s.provided ? [] : ["missing"])]
              return `${s.name}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`
            })
            .join(", "),
    )
  },
})

const addApp = defineTool({
  name: "add_app",
  description:
    "Ask the user to add a site to the project's apps (a scene needs it: docs, a login on another host). Web sites only (a desktop app can't be added yet). The user approves or declines.",
  parameters: z.object({
    name: AppName.describe("its name in the project (lowercase: docs, auth…)"),
    url: z.string().min(1).max(2048).describe("its address (https://docs.example.com)"),
    why: z.string().min(1).max(400).describe("one line: what the scene needs it for"),
  }),
  run: async (args, studio: Studio, signal) => {
    const result = await studio.addApp(args, signal)
    if ("error" in result) return result
    return `added: "${result.added}" is one of the project's apps now (your instructions above don't list it yet). A step there names it: { action: goto, app: ${result.added}, url: /path }; a scene that starts there says \`app: ${result.added}\` and you pass start_app: ${result.added}.`
  },
})

const askUser = defineTool({
  name: "ask_user",
  description:
    "Ask the user a question when blocked (a missing secret, an ambiguous goal). Ask only for real blockers.",
  parameters: z.object({ question: z.string().min(1) }),
  run: async ({ question }, studio: Studio, signal) => {
    const answer = await studio.options.requestUser({ kind: "question", question }, signal)
    // A question is answered with text, or declined (false); a handover's end never answers one.
    return { answer: typeof answer === "object" ? "" : String(answer) }
  },
})

const saveSceneTool = defineTool({
  name: "save_scene",
  description:
    "Save a scene: its complete scenario YAML is validated and replayed from scratch in a fresh browser at the recording's pace; saved only if the replay passes (the result comes back).",
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
    // Grounded from another start app than the scene says: the replay passed, but say it.
    const grounded = studio.groundedApp(id)
    const starts = checked.scenario.app ?? firstApp(studio.options.config).name
    studio.saved(id, starts)
    const note =
      grounded !== undefined && grounded !== starts
        ? ` Note: you grounded it with start_app "${grounded}" but it starts in "${starts}" (its \`app:\`): check that's what you meant.`
        : ""
    return `saved: the replay passed. Record it with record_scene.${note}`
  },
})

const recordScene = defineTool({
  name: "record_scene",
  description:
    "Record a saved scene at human pace for the video (takes as long as the scene plays).",
  parameters: z.object({ id: sceneId }),
  run: async ({ id }, studio: Studio, signal) => said(await studio.record(id, signal)),
})

/**
 * A tool whose result and error are scrubbed on their way to the model: once, here, for every path
 * (this tool's and any added later; a user's answer quoting a value too). And its arguments
 * checked by the same scrubber: the agent never knows a value, so one in what it wrote is a guess
 * (written, typed, a path, then read back as "[secret]" would confirm it): refused, and the run
 * ends (one guess per run, never a guessing game).
 */
function scrubbed(tool: Tool<Studio>): Tool<Studio> {
  return {
    ...tool,
    run: async (args, studio, signal) => {
      if (holdsValue(args, studio.secretTest())) {
        studio.options.stopRun(
          `Kif wrote a secret's value itself (${tool.name}): refused, and the run stopped`,
        )
        return {
          error: "refused: that holds a secret's value (you never write one); the run stops",
        }
      }
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
        // Whether the user settles it (an app to allow): the agent tells them, never retries.
        if (needsUser(error)) Object.assign(scrubbed, { needsUser: true })
        throw scrubbed
      }
      // A tool's images are made safe where they're made (a screenshot masked; a project's image
      // file, its pixels made again: never a capture, only the user's files or bytes the agent
      // wrote, checked as it wrote them): only its text is scrubbed here (scrubbing an image's
      // bytes would break it, and never hide anything in its pixels).
      if (isWithImages(result)) {
        // Every tool's images, whichever: none to a model that takes none (it would fail the run).
        const refused = await studio.refusedImages()
        if (refused !== undefined) return refused
        return withImages(scrubDeep(result.result, studio.scrubber()), result.images)
      }
      return scrubDeep(result, studio.scrubber())
    },
  }
}

/** Whether any string in a tool's arguments holds a known secret's value. */
function holdsValue(value: unknown, holds: (text: string) => boolean): boolean {
  if (typeof value === "string") return holds(value)
  if (Array.isArray(value)) return value.some((v) => holdsValue(v, holds))
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([k, v]) => holds(k) || holdsValue(v, holds))
  }
  return false
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
  look,
  handOver,
  runStep,
  runSteps,
  listSecrets,
  addApp,
  askUser,
  saveSceneTool,
  savePresetTool,
  recordScene,
  ...fileTools,
].map(scrubbed)
