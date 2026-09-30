import {
  Action,
  type Ensure,
  type ProjectConfig,
  type Scenario,
  type SetupItem,
} from "@kiframe/schema"
import { StepError, type StepRef } from "../errors.ts"
import { describeLocator } from "../targets.ts"
import { waitForCondition } from "./conditions.ts"
import { type Ctx, firstLine, guard } from "./context.ts"
import { syncPage } from "./pages.ts"
import { settle } from "./settle.ts"
import { runOne } from "./step.ts"

// Setup: presets inlined (session presets skipped or replaced by their landing), and `ensure`.

/** A setup item once presets are inlined: an action, an `ensure`, or the end of a preset. */
type PresetOrigin = { name: string; session: boolean }
type SetupEntry =
  | { kind: "action"; index: number; action: Action; preset?: PresetOrigin }
  | { kind: "ensure"; index: number; ensure: Ensure["ensure"] }
  | ({ kind: "preset_done"; index: number } & PresetOrigin)

/**
 * Inlines presets into setup, and drops session presets the page already has (`skipSessionPresets`).
 * Error indexes are post-expansion, like the `setup[i]` of runtime errors.
 */
export function expandSetup(
  items: readonly SetupItem[],
  project: ProjectConfig,
  skip: readonly string[],
  landings: Readonly<Record<string, string>>,
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
          landing === undefined ? undefined : Action.safeParse({ action: "goto", url: landing })
        if (goto?.success === true)
          out.push({ kind: "action", index: n++, action: goto.data, preset: from })
        continue
      }
      for (const s of preset.steps) {
        out.push(
          "ensure" in s
            ? { kind: "ensure", index: n++, ensure: s.ensure }
            : { kind: "action", index: n++, action: s, preset: from },
        )
      }
      out.push({ kind: "preset_done", index: n - 1, ...from })
    } else if ("ensure" in item) {
      out.push({ kind: "ensure", index: n++, ensure: item.ensure })
    } else {
      out.push({ kind: "action", index: n++, action: item })
    }
  }
  return out
}

export async function runSetupEntry(
  ctx: Ctx,
  scenario: Scenario,
  setup: readonly SetupEntry[],
  position: number,
  entry: SetupEntry,
): Promise<void> {
  if (entry.kind === "preset_done") {
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
  if (entry.kind === "action") {
    const { action } = entry
    await runOne(ctx, action, {
      phase: "setup",
      index: entry.index,
      stepId: action.id,
      action: action.action,
      ...(entry.preset !== undefined && { preset: entry.preset.name }),
    })
    return
  }
  await ensure(ctx, scenario, setup.slice(0, position), entry.index, entry.ensure)
}

/** After the page settles, how long an `absent` check waits for something that renders late. */
const ABSENT_GRACE_MS = 1000

/**
 * `ensure` (docs/OBJECT-MODEL.md §2): the one declarative idempotency primitive.
 * - `absent`: if the element is there, run this scene's teardown, replay the setup that led here
 *   (actions only: no session preset, no other `ensure`), and check again.
 * - `present`: nothing can create it declaratively: fail with a message saying so.
 * "There" = a visible match: waited for up to the step timeout (`present`), or for a short grace
 * after the page settles (`absent`: lists that load late must not look empty).
 * The cleanup runs inside this step: its steps are reported as `ensure: <action>` of this setup
 * index, and any failure is this step's (`ensure-failed`), never a teardown failure.
 */
async function ensure(
  ctx: Ctx,
  scenario: Scenario,
  before: readonly SetupEntry[],
  index: number,
  condition: Ensure["ensure"],
): Promise<void> {
  const ref: StepRef = { phase: "setup", index, action: "ensure" }
  // Stopped before it: no check (it could run the whole teardown after the stop).
  if (ctx.options.signal?.aborted === true)
    throw new StepError(ref, "stopped", "the run was stopped")
  ctx.setCurrent(ref)
  // Its own ref: a page failing to load here is that setup's failure, not an `ensure` one (which
  // would skip the teardown).
  await syncPage(ctx, { phase: "setup", index, action: "follow page" })
  ctx.options.onEvent?.({ kind: "step_start", step: ref })
  const locator = "absent" in condition ? condition.absent : condition.present
  const what = describeLocator(locator)
  // On a blank page everything is absent (a skipped session preset left nothing loaded).
  if (ctx.page.url() === "about:blank") {
    throw new StepError(ref, "ensure-failed", "`ensure` needs a page: add a `goto` before it")
  }
  const appears = async (timeout: number, negative = false) => {
    try {
      await waitForCondition(ctx, { visible: locator }, timeout, ref, "condition-timeout", negative)
      return true
    } catch (error) {
      if (error instanceof StepError && error.reason === "condition-timeout") return false
      throw error
    }
  }
  const leftovers = async () => {
    await guard(ref, () => settle(ctx, false))
    return appears(ABSENT_GRACE_MS, true)
  }
  if ("present" in condition) {
    if (!(await appears(ctx.timeoutMs))) {
      throw new StepError(
        ref,
        "ensure-failed",
        `${what} must be present before filming: create it earlier in the setup or in a preset`,
      )
    }
  } else if (await leftovers()) {
    // Leftovers from an earlier run: the scene's own teardown removes what the scene creates.
    const teardown = scenario.teardown ?? []
    if (teardown.length === 0) {
      throw new StepError(
        ref,
        "ensure-failed",
        `${what} must be absent before filming, and the scene has no teardown to remove it`,
      )
    }
    // Back to where the check happens: the setup before it, session presets' navigations included
    // (their state is kept, but the page they led to may be the only `goto`).
    const replay = before.flatMap((e) =>
      e.kind === "action" && (e.preset?.session !== true || e.action.action === "goto")
        ? [{ action: e.action, preset: e.preset?.name }]
        : [],
    )
    // Only the teardown is a cleanup (a sandbox may pre-approve it); going back replays the setup.
    // Each action keeps the list it's written in, for its secret approvals (§3 A1).
    const stages: [string, string, readonly { action: Action; preset?: string | undefined }[]][] = [
      [`removing ${what} (teardown)`, "ensure", teardown.map((action) => ({ action }))],
      ["returning to the setup page", "ensure (back)", replay],
    ]
    for (const [stage, label, items] of stages) {
      const cleanup = label === "ensure"
      for (const [i, { action, preset }] of items.entries()) {
        try {
          await runOne(ctx, action, {
            phase: "setup",
            index,
            stepId: action.id,
            action: `${label}: ${action.action}`,
            ...(cleanup && { cleanup: true as const, keyPhase: "teardown" as const }),
            ...(preset !== undefined && { preset }),
          })
        } catch (error) {
          ctx.clearListenerError()
          // The cause's own reason is kept (a risky step waiting for approval must stay that).
          const reason = error instanceof StepError ? error.reason : "ensure-failed"
          const detail = error instanceof StepError ? error.detail : firstLine(error)
          throw new StepError(
            ref,
            reason,
            `${stage}, step ${i + 1} (${action.action}): ${detail}`,
            {
              cause: error,
            },
          )
        }
      }
    }
    ctx.setCurrent(ref)
    if (await leftovers()) {
      throw new StepError(ref, "ensure-failed", `${what} is still present after the teardown ran`)
    }
  }
  ctx.throwListenerError()
  ctx.options.onEvent?.({ kind: "step_end", step: ref })
}
