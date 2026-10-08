import { Action, appOf, firstApp, type ProjectConfig, type SetupItem } from "@kiframe/schema"
import { StepError, type StepRef } from "../errors.ts"
import { type Ctx, guard, type SessionLanding } from "./context.ts"
import { syncPage } from "./pages.ts"
import { runOne } from "./step.ts"

// Setup: presets inlined (session presets skipped or replaced by their landing). An `ensure` (from
// before teardowns were removed, OBJECT-MODEL §0.4) is skipped: the runner says so.

/**
 * A setup item once presets are inlined: an action (with the app it means, worked out from the
 * text: `run/apps.ts`), or the end of a preset.
 */
type PresetOrigin = { name: string; session: boolean }
type SetupEntry =
  | {
      kind: "action"
      index: number
      action: Action
      app: string
      preset?: PresetOrigin
      /** A reused session preset's check (its landing, its own last checks): failing, expired. */
      probe?: boolean
    }
  /** A preset's end; `held`: a reused session's checks passed (its state saved again, not a login). */
  | ({ kind: "preset_done"; index: number; held?: boolean } & PresetOrigin)

/** A preset's last checks (its trailing waitFor/expect): what says its session holds. */
export function sessionChecks(steps: readonly (Action | { ensure: unknown })[]): Action[] {
  const out: Action[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s === undefined || "ensure" in s || (s.action !== "waitFor" && s.action !== "expect")) break
    out.unshift(s)
  }
  return out
}

/**
 * Whether a preset's last checks can tell signed in from out: one of them waits for something the
 * signed-in page shows (an element, a text), never only the network, a hidden thing or a URL (a
 * signed-out app may keep those).
 */
export function checksSignedIn(steps: readonly (Action | { ensure: unknown })[]): boolean {
  return sessionChecks(steps).some((c) => {
    const condition = c.action === "waitFor" ? c.until : c.action === "expect" ? c.that : undefined
    return condition !== undefined && ("visible" in condition || "text" in condition)
  })
}

/** What a reused session's check failing says: it doesn't hold (not a slow page, a network error). */
const SIGNED_OUT = new Set([
  "expectation-failed",
  "condition-timeout",
  "target-not-found",
  "off-app",
  "off-origin",
])

/**
 * Inlines presets into setup, and drops session presets the page already has (`skipSessionPresets`).
 * Error indexes are post-expansion, like the `setup[i]` of runtime errors (an `ensure` skipped still
 * counts: the indexes stay those of the file). Each step means the scene's start app (`start`) when
 * it names none; a preset's steps its own app (the first by default), a skipped session preset's
 * landing its app.
 */
export function expandSetup(
  items: readonly SetupItem[],
  project: ProjectConfig,
  skip: readonly string[],
  landings: Readonly<Record<string, SessionLanding>>,
  start: string,
): SetupEntry[] {
  const out: SetupEntry[] = []
  // Setup indexes count actions and ensures only (`preset_done` is a marker, not a step).
  let n = 0
  const invalid = (detail: string) =>
    new StepError({ phase: "setup", index: n, action: "setup" }, "invalid-setup", detail)
  for (const item of items) {
    if ("preset" in item) {
      const preset = Object.hasOwn(project.presets, item.preset)
        ? project.presets[item.preset]
        : undefined
      if (preset === undefined) throw invalid(`unknown preset "${item.preset}"`)
      const from = { name: item.preset, session: preset.session }
      if (preset.session && skip.includes(item.preset)) {
        // Its state is kept, not its page: back where it ended (a setup may rely on that page),
        // then its own last checks, which say the session still holds (else: expired).
        const landing = Object.hasOwn(landings, item.preset) ? landings[item.preset] : undefined
        const goto =
          landing === undefined
            ? undefined
            : Action.safeParse({ action: "goto", app: landing.app, url: landing.url })
        if (goto?.success === true && landing !== undefined) {
          out.push({
            kind: "action",
            index: n++,
            action: goto.data,
            app: landing.app,
            preset: from,
            probe: true,
          })
          // The checks under the landing's index: a setup's indexes stay those of the file.
          const own = preset.app ?? firstApp(project).name
          for (const check of sessionChecks(preset.steps)) {
            out.push({
              kind: "action",
              index: n - 1,
              action: check,
              app: own,
              preset: from,
              probe: true,
            })
          }
          // Held: its state saved again (a refresh token the reuse spent, renewed).
          out.push({ kind: "preset_done", index: n - 1, held: true, ...from })
        }
        continue
      }
      const own = preset.app ?? firstApp(project).name
      for (const s of preset.steps) {
        if ("ensure" in s) n++
        else out.push({ kind: "action", index: n++, action: s, app: own, preset: from })
      }
      out.push({ kind: "preset_done", index: n - 1, ...from })
    } else if ("ensure" in item) {
      n++
    } else {
      out.push({ kind: "action", index: n++, action: item, app: start })
    }
  }
  return out
}

/**
 * The goto that opens a scene in a fresh browser (`fresh`): its start app's own URL, when the
 * scene's first action doesn't go to a page itself (a setup that starts with a handover or a check,
 * a preset that doesn't navigate, no setup at all).
 */
export function openingGoto(
  setup: readonly SetupEntry[],
  steps: readonly Action[],
  project: ProjectConfig,
  start: string,
): Action | undefined {
  const first = setup.find((e) => e.kind === "action")?.action ?? steps[0]
  if (first?.action === "goto") return undefined
  const app = appOf(project, start)
  if (app === undefined) return undefined
  const url = new URL(app.url)
  const goto = Action.safeParse({ action: "goto", url: `${url.pathname}${url.search}` })
  return goto.success ? goto.data : undefined
}

export async function runSetupEntry(ctx: Ctx, entry: SetupEntry): Promise<void> {
  if (entry.kind === "preset_done") {
    // Stopped in the preset's last step: its session isn't followed nor saved.
    if (ctx.options.signal?.aborted === true) {
      const ref: StepRef = { phase: "setup", index: Math.max(0, entry.index), action: "preset" }
      throw new StepError(ref, "stopped", "the run was stopped")
    }
    // A login done (never a reuse: no preset ran).
    if (entry.held !== true) {
      ctx.options.onEvent?.({ kind: "preset_done", name: entry.name, session: entry.session })
    }
    const ready = ctx.options.onSessionReady
    if (entry.session && ready !== undefined) {
      // Named after the preset's last step.
      const ref: StepRef = {
        phase: "setup",
        index: Math.max(0, entry.index),
        action: `save session ${entry.name}`,
      }
      // On the page the login ended on: back from an OAuth popup that closed, settled (its
      // callback's cookies set). A preset should end with a `waitFor` on the app's page.
      await syncPage(ctx, ref)
      await guard(ref, async () => ready(entry.name, ctx.page, entry.held === true))
    }
    return
  }
  const { action } = entry
  const ref: StepRef = {
    phase: "setup",
    index: entry.index,
    stepId: action.id,
    action: action.action,
    ...(entry.preset !== undefined && { preset: entry.preset.name }),
  }
  try {
    await runOne(ctx, action, ref, entry.app)
  } catch (error) {
    // A reused session's check failing: it expired (signed out, a redirect to the sign-in).
    if (
      entry.probe === true &&
      error instanceof StepError &&
      SIGNED_OUT.has(error.reason) &&
      entry.preset !== undefined
    ) {
      throw new StepError(
        ref,
        "session-expired",
        `the saved sign-in of "${entry.preset.name}" doesn't hold any more (${error.reason}): run again, it signs in fresh`,
      )
    }
    throw error
  }
}
