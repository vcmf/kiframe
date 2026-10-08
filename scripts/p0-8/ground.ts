// P0-8 (throwaway): the grounding experiment.
// Kept as the reference for M2-5/M2-7 until they ship. A minimal agent (the `openai` SDK against OpenRouter,
// like cooldown's byok-client; not the full agent loop yet) writes a scene for a goal and grounds
// every step on the live app, then the scene is replayed from scratch to check it. Logs tokens,
// cost, time, turns and questions (APPROACHES §12, IMPLEMENTATION-PLAN P0-8).
//
// Usage: node scripts/p0-8/ground.ts --project p.yaml --goal "…" --out scene.yaml
//          [--model deepseek/deepseek-v4.1-flash] [--secrets calcom.username,calcom.password] [--headed]
// Keys and secrets come from the environment or a git-ignored `.env` (see .env.example): secret
// `a.b` is read from `A_B`. The model only ever sees names.
// Risky steps are approved automatically: run it on sandbox / throwaway accounts only (each
// approval is printed).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseArgs } from "node:util"
import { runScenario, scrubSecrets, StepError, visibleOnly, locatorFor } from "@kiframe/runtime"
import {
  checkScenarioAgainstProject,
  parseProjectYaml,
  parseScenarioYaml,
  firstApp,
  Action,
  Ensure,
  Locator,
  PresetRef,
  SetupItem,
  Step,
  type ProjectConfig,
} from "@kiframe/schema"
import OpenAI from "openai"
import { envSecretResolver, loadDotEnv, providedSecrets } from "../lib/secrets.ts"
import { parse as parseYaml } from "yaml"
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"
import { chromium, type Browser, type Page } from "playwright"
import { sceneIdOf } from "../lib/scenes.ts"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    goal: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "deepseek/deepseek-v4.1-flash" },
    secrets: { type: "string", default: "" },
    "max-turns": { type: "string", default: "80" },
    headed: { type: "boolean", default: false },
    /** Another OpenAI-compatible endpoint (OpenAI directly, or a local stub for testing). */
    "base-url": { type: "string", default: "https://openrouter.ai/api/v1" },
  },
})
if (!values.project || !values.goal || !values.out) {
  console.error(
    'usage: --project <yaml> --goal "<what the demo shows>" --out <scene.yaml> [--model id] [--secrets a.b,c.d]',
  )
  process.exit(2)
}
loadDotEnv()
const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey === "") {
  console.error("OPENROUTER_API_KEY is not set")
  process.exit(2)
}
// One run per output: a second run would write the same log and report (and fight over the app).
// Taken atomically (`wx`); a lock whose pid is gone (or unreadable) is stale.
const lock = `${values.out}.lock`
const takeLock = (): boolean => {
  if (!existsSync(dirname(lock))) {
    console.error(`the output folder ${dirname(lock)} doesn't exist`)
    process.exit(2)
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" })
    return true
  } catch {
    let pid = NaN
    try {
      pid = Number(readFileSync(lock, "utf8"))
    } catch {
      // gone in between: try once more below
    }
    let alive = false
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        alive = true
      } catch (error) {
        // EPERM: alive, but someone else's
        alive = (error as NodeJS.ErrnoException).code === "EPERM"
      }
    }
    if (alive) return false
    // Stale: moved aside atomically (only one run wins the rename), then taken with `wx` again.
    try {
      renameSync(lock, `${lock}.stale-${process.pid}`)
      rmSync(`${lock}.stale-${process.pid}`, { force: true })
    } catch {
      // someone else moved it first
    }
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" })
      return true
    } catch {
      return false
    }
  }
}
if (!takeLock()) {
  console.error(`another run writes ${values.out} (${lock})`)
  process.exit(2)
}
process.on("exit", () => rmSync(lock, { force: true }))
// Ctrl-C: stop after the current call, then close the browser and still write the report (the
// partial run's tokens and cost are measurements too). A second signal exits at once.
let stopRequested = false
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopRequested) process.exit(130)
    stopRequested = true
    console.error("stopping after the current call (again to quit now)")
  })
}
const project = parseProjectYaml(readFileSync(values.project, "utf8"))
/** The app every scene starts in (the project's first). */
const start = firstApp(project).app
const model = values.model
// The scene being grounded (its steps and its replays are one scene: they share approvals).
const sceneId = sceneIdOf(values.out)
const maxTurns = Number(values["max-turns"])
if (!Number.isInteger(maxTurns) || maxTurns < 1) {
  console.error("--max-turns takes a positive whole number")
  process.exit(2)
}

// ─── Secrets: names for the model, values only for the runner ────────────────
const secretNames = values.secrets.split(",").filter(Boolean)
const resolveSecret = envSecretResolver(secretNames, start.url)
const provided = providedSecrets(secretNames)
const secretValues = provided.map((s) => s.value)
/** Every string the model sees goes through this. */
const scrub = (text: string) => scrubSecrets(text, secretValues)

// ─── The scene format, as the model is told ──────────────────────────────────
const SYSTEM = `You write and ground demo scenes for Kiframe. A scene is a YAML scenario that a runtime replays
deterministically in a real browser to film a product demo. You work on the LIVE app through tools:
look with \`snapshot\`, act and check each step with \`run_step\` (the step really runs on the page), and
when the whole scene is grounded, submit it with \`finish\`. It is then replayed from scratch; fix what fails.

Scenario format (YAML, version 1):
version: 1
setup:        # off camera, runs first: navigation, login, making the app ready
  - { preset: <name> }                       # a project preset (see below)
  - { action: goto, url: /path }             # relative to the app
steps:        # ON CAMERA, 5-50 steps (most scenes 5-15), each with a unique kebab-case id
  - { id: open-new, action: click, target: <locator>, caption: "Short caption for the video" }
  - { id: name, action: type, target: <locator>, value: "Text", clear: true, submit: false }
  - { id: save, action: press, keys: Enter }           # keys like Enter, Mod+k, Escape
  - { id: done, action: waitFor, until: { text: "Saved" } }   # or { visible: <locator> } / { url: /x }
  - { id: check, action: expect, that: { visible: <locator> } }
  - { id: more, action: scroll, by: { y: 400 } }
  - { id: menu, action: hover, target: <locator> }
  - { id: beat, action: pause, ms: 800 }
  - { id: send, action: click, target: <locator>, risky: true }  # risky: true on deletes/sends/pays the demo shows

Locators (prefer in this order; they must match exactly ONE visible element):
  { by: role, role: button, name: "Save", exact: true }   # roles from the snapshot (button, link, textbox, heading…)
  { by: label, name: "Email" }                             # form fields by their label
  { by: placeholder, text: "Search" }
  { by: text, text: "Exact visible text", exact: true }
  { by: css, selector: "…" }                               # last resort
  Add "nth: <n>" (0-based, visible matches only) only when there is no better way.

Rules:
- Never invent a locator: take it from a snapshot, and run the step to confirm it.
- Secrets: never type credentials literally. Use value: "{{secrets.<name>}}" with a name from \`list_secrets\`.
  You can't see secret values; if a needed secret is missing, ask the user.
- No conditions or loops in steps. Wait on conditions (waitFor), never fixed sleeps (pause is only a beat).
- Captions: short, marketing tone, on the steps that matter (not every step).
- Ask the user (\`ask_user\`) only for real blockers (a missing secret, an ambiguous goal). Questions are counted.
- run_step runs steps on the live page in order. Nothing is cleaned up after a scene.
- As soon as every step ran ok once, call finish. Don't start over by hand to re-check:
  finish itself replays the whole scene from scratch in a fresh browser and tells you what fails.
- A target reported "off screen" is inside a collapsed panel: open the panel first, or use a visible element.
- The replay starts in a FRESH browser (no cookies, no storage): panels, sidebars and menus are in their
  default state there, whatever you left open on the live page. Steps must not rely on UI state from your
  exploration: open what they need explicitly.
Project presets available: ${Object.keys(project.presets).join(", ") || "none"}.
App: ${start.url}`

// ─── Browser ─────────────────────────────────────────────────────────────────
// Our own Ctrl-C handling closes the browser after the current call (Playwright would at once).
const browser: Browser = await chromium.launch({
  headless: !values.headed,
  handleSIGINT: false,
  handleSIGTERM: false,
})
const viewport = {
  width: start.viewport.width,
  height: start.viewport.height,
}
const page: Page = await browser.newPage({ viewport })

const quickProject: ProjectConfig = {
  ...project,
  defaults: {
    ...project.defaults,
    pacing: { ...project.defaults.pacing, cursor: "instant", typing: "instant", settleMs: 0 },
  },
}

/** One zod issue as the model reads it. */
const formatIssue = (issue: { message: string; path: PropertyKey[] } | undefined) =>
  `${issue?.message ?? "?"}${issue?.path.length ? ` at ${issue.path.map(String).join(".")}` : ""}`

/** Models sometimes send an object as a JSON or YAML string: accept both. */
function asObject(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    try {
      return parseYaml(raw) as unknown
    } catch {
      return raw
    }
  }
}

/**
 * One item on the live page, through the real runner: an on-camera step (with its id), or a
 * setup / teardown item (an action without id, `{ preset: … }`, `{ ensure: … }`).
 */
async function runStep(input: unknown): Promise<string> {
  const raw = asObject(input)
  if (typeof raw !== "object" || raw === null) {
    return "invalid step: expected an object like {id: open-new, action: click, target: {...}}"
  }
  const step = Step.safeParse(raw)
  const setupItem = step.success ? undefined : SetupItem.safeParse(raw)
  if (!step.success && setupItem?.success !== true) {
    // A step has an id; a setup item is a preset, an ensure or an action without id. Parse against
    // the exact shape the model meant (a union's error only says "Invalid input").
    const r = raw as Record<string, unknown>
    const [what, schema] =
      "preset" in r
        ? (["preset", PresetRef] as const)
        : "ensure" in r
          ? (["ensure", Ensure] as const)
          : "id" in r
            ? (["step", Step] as const)
            : (["setup action", Action] as const)
    const result = schema.safeParse(raw)
    return `invalid ${what}: ${result.success ? "?" : formatIssue(result.error.issues[0])}`
  }
  const scenario = step.success
    ? { version: 1 as const, steps: [step.data] }
    : { version: 1 as const, setup: [setupItem!.data!], steps: [] }
  try {
    await runScenario(page, scenario, quickProject, {
      scope: "phase0",
      sceneId,
      resolveSecret,
      approveRisky: logApproval,
      timeoutMs: STEP_TIMEOUT_MS,
    })
    return `ok. url: ${new URL(page.url()).pathname}`
  } catch (error) {
    // An ensure run alone doesn't know the scene's teardown or setup: say so, not "no teardown".
    const alone =
      !step.success && "ensure" in (raw as Record<string, unknown>)
        ? " (ensure checked alone: your teardown and setup aren't known here; the finish replay runs them)"
        : ""
    return error instanceof StepError
      ? `failed (${error.reason}): ${error.detail}${alone}`
      : `failed: ${String(error)}`
  }
}

// Real SaaS pages can take seconds to hydrate (Cal.com's login needs more than 6 s): FAILURE-CATALOGUE #8.
const STEP_TIMEOUT_MS = 15_000
const SNAPSHOT_MAX = 14_000
/** Sandbox accounts only: every risky step the model marks is approved, and printed. */
const logApproval = (step: { phase: string; index: number; action: string }) => {
  console.log(`[approved risky] ${step.phase}[${step.index}] ${step.action}`)
  return true
}
async function snapshot(within?: unknown): Promise<string> {
  let root = page.locator("body")
  if (within !== undefined) {
    const parsed = Locator.safeParse(within)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return `invalid \`within\` locator: ${formatIssue(issue)}`
    }
    try {
      root = visibleOnly(await locatorFor(page, parsed.data)).first()
    } catch (e) {
      // A selector the secrets rules refuse (SECRETS-DESIGN §3 A8): the model gets the reason.
      return `refused \`within\` locator: ${String(e)}`
    }
  }
  const text = await root
    .ariaSnapshot({ timeout: 5000 })
    .catch((e: unknown) => `snapshot failed: ${String(e)}`)
  const cut =
    text.length > SNAPSHOT_MAX
      ? `${text.slice(0, SNAPSHOT_MAX)}\n… (cut: ${text.length} chars; use \`within\` to look at a region)`
      : text
  return `url: ${new URL(page.url()).pathname}\n${cut}`
}

// ─── Replay from scratch (the grounding check) ───────────────────────────────
async function replay(yaml: string): Promise<string> {
  let scenario
  try {
    scenario = parseScenarioYaml(yaml)
  } catch (error) {
    return `invalid scenario: ${String(error).slice(0, 1500)}`
  }
  const issues = checkScenarioAgainstProject(scenario, project)
  if (issues.length > 0) return `invalid scenario: ${issues.join("; ")}`
  if (scenario.steps.length < 5 || scenario.steps.length > 50) {
    return `a scene has 5-50 on-camera steps (this one has ${scenario.steps.length})`
  }
  const context = await browser.newContext({ viewport })
  const fresh = await context.newPage()
  try {
    await runScenario(fresh, scenario, quickProject, {
      scope: "phase0",
      sceneId,
      resolveSecret,
      approveRisky: logApproval,
      timeoutMs: STEP_TIMEOUT_MS,
    })
    return "ok"
  } catch (error) {
    return error instanceof StepError
      ? `replay failed at ${error.message}`
      : `replay failed: ${String(error)}`
  } finally {
    await context.close()
  }
}

// ─── Tools ───────────────────────────────────────────────────────────────────
const locatorSchema = {
  type: "object",
  description: "A locator, e.g. {by: role, role: button, name: Save}",
}
const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "snapshot",
      description: "Accessibility snapshot of the page (or of one region) and its URL.",
      parameters: { type: "object", properties: { within: locatorSchema } },
    },
  },
  {
    type: "function",
    function: {
      name: "run_step",
      description:
        "Run ONE step on the live page (a steps item, or a setup action given an id). Returns ok or why it failed.",
      parameters: {
        type: "object",
        properties: {
          step: { type: "object", description: "The step, same fields as in the YAML" },
        },
        required: ["step"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_secrets",
      description: "Names of the secrets the user provided (never their values).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Ask the user a question when blocked. Counted: ask only for real blockers.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "Submit the complete scenario YAML. It's validated and replayed from scratch in a fresh browser; the result comes back.",
      parameters: { type: "object", properties: { yaml: { type: "string" } }, required: ["yaml"] },
    },
  },
]

const client = new OpenAI({ apiKey, baseURL: values["base-url"] })
const messages: ChatCompletionMessageParam[] = [
  { role: "system", content: SYSTEM },
  { role: "user", content: `Goal of the demo scene: ${values.goal}` },
]
const stats = {
  model,
  turns: 0,
  toolCalls: 0,
  stepsRun: 0,
  stepFailures: 0,
  questions: [] as string[],
  replays: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
  ms: 0,
  result: "unfinished" as string,
}
const started = Date.now()
let finalYaml: string | undefined

try {
  await page.goto(start.url)
  for (let turn = 0; turn < maxTurns && finalYaml === undefined && !stopRequested; turn++) {
    stats.turns++
    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
      max_tokens: 4096,
      // OpenRouter: report the cost of each call.
      ...({ usage: { include: true } } as object),
    })
    const usage = response.usage as
      | (typeof response.usage & {
          cost?: number
          prompt_tokens_details?: { cached_tokens?: number }
        })
      | undefined
    stats.promptTokens += usage?.prompt_tokens ?? 0
    stats.completionTokens += usage?.completion_tokens ?? 0
    stats.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0
    stats.costUsd += usage?.cost ?? 0
    const message = response.choices[0]?.message
    if (message === undefined) break
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      ...(message.tool_calls && { tool_calls: message.tool_calls }),
    })
    if (message.content) console.log(`[model] ${message.content.slice(0, 300)}`)
    if (!message.tool_calls || message.tool_calls.length === 0) {
      messages.push({
        role: "user",
        content: "Continue with the tools; call finish with the YAML when the scene is grounded.",
      })
      continue
    }
    for (const call of message.tool_calls) {
      if (stopRequested || finalYaml !== undefined) {
        // Stopped, or already grounded: answer the remaining calls without running them.
        const content = stopRequested ? "stopped by the user" : "already finished: not run"
        messages.push({ role: "tool", tool_call_id: call.id, content })
        continue
      }
      if (call.type !== "function") {
        // Every tool call needs a reply, or the next request is rejected.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "unsupported tool call type",
        })
        continue
      }
      stats.toolCalls++
      let args: Record<string, unknown> = {}
      let badArgs = false
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || "{}")
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        } else badArgs = true
      } catch {
        badArgs = true
      }
      if (badArgs) {
        // Cut off by max_tokens (a long finish YAML), or not JSON: say so, don't run a tool on {}.
        const cut = response.choices[0]?.finish_reason === "length"
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: cut
            ? "Your arguments were cut off (output token limit): send them again, shorter (e.g. finish with a compact YAML)."
            : "Your arguments aren't valid JSON: send them again.",
        })
        continue
      }
      let result: string
      switch (call.function.name) {
        case "snapshot":
          result = await snapshot(asObject(args.within))
          break
        case "run_step":
          stats.stepsRun++
          result = await runStep(args.step)
          if (!result.startsWith("ok")) stats.stepFailures++
          console.log(`[step] ${JSON.stringify(args.step).slice(0, 160)} → ${result.slice(0, 160)}`)
          break
        case "list_secrets":
          result =
            secretNames.length === 0
              ? "none"
              : secretNames
                  .map((n) => `${n}${provided.some((s) => s.name === n) ? "" : " (missing)"}`)
                  .join(", ")
          break
        case "ask_user":
          stats.questions.push(String(args.question))
          console.log(`[question] ${String(args.question)}`)
          result =
            "No answer is available in this run: make the most reasonable choice, and state it in the scene as a YAML comment."
          break
        case "finish": {
          stats.replays++
          const yaml = typeof args.yaml === "string" ? args.yaml : ""
          result = await replay(yaml)
          console.log(`[finish] replay → ${result.slice(0, 200)}`)
          if (result === "ok") finalYaml = yaml
          break
        }
        default:
          result = `unknown tool ${call.function.name}`
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: scrub(result) })
    }
  }
  stats.result = finalYaml !== undefined ? "grounded" : stopRequested ? "stopped" : "not grounded"
} catch (error) {
  stats.result = `error: ${scrub(String(error)).slice(0, 300)}`
} finally {
  stats.ms = Date.now() - started
  await browser.close()
}

if (finalYaml !== undefined) writeFileSync(values.out, scrub(finalYaml))
writeFileSync(
  `${values.out}.report.json`,
  JSON.stringify({ goal: values.goal, ...stats }, null, 2) + "\n",
)
console.log(JSON.stringify({ ...stats, questions: stats.questions.length }))
