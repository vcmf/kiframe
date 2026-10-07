import { Action, firstApp, type ProjectConfig, type SetupItem } from "@kiframe/schema"
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
  | { kind: "action"; index: number; action: Action; app: string; preset?: PresetOrigin }
  | ({ kind: "preset_done"; index: number } & PresetOrigin)

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
        // Its state is kept, not its page: back where it ended (a setup may rely on that page).
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
          })
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

export async function runSetupEntry(ctx: Ctx, entry: SetupEntry): Promise<void> {
  if (entry.kind === "preset_done") {
    // Stopped in the preset's last step: its session isn't followed nor saved.
    if (ctx.options.signal?.aborted === true) {
      const ref: StepRef = { phase: "setup", index: Math.max(0, entry.index), action: "preset" }
      throw new StepError(ref, "stopped", "the run was stopped")
    }
    ctx.options.onEvent?.({ kind: "preset_done", name: entry.name, session: entry.session })
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
      await guard(ref, async () => ready(entry.name, ctx.page))
    }
    return
  }
  const { action } = entry
  await runOne(
    ctx,
    action,
    {
      phase: "setup",
      index: entry.index,
      stepId: action.id,
      action: action.action,
      ...(entry.preset !== undefined && { preset: entry.preset.name }),
    },
    entry.app,
  )
}
