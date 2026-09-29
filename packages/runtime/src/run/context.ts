import type { Action, ProjectConfig, Step } from "@kiframe/schema"
import type { ElementHandle, Locator, Page } from "playwright"
import { type ApprovalRequest, type SecretUse, StepError, type StepRef } from "../errors.ts"
import type { Box, CursorPacing, Point, TypingPacing } from "../motion.ts"
import type { NetworkTracker } from "../network.ts"
import { ProbeRefusal } from "../secret-state.ts"

// The runner's shared state (Ctx), its options and events, and small helpers every part uses.

/** What the runner reports as it goes. The recorder (P0-5) turns these into take events. */
export type RunnerEvent =
  | { kind: "step_start" | "step_end"; step: StepRef }
  | { kind: "navigate"; step: StepRef; url: string }
  /** `secret` is the secret NAME when the value came from the vault; the value is never reported. */
  | { kind: "type"; step: StepRef; secret?: string | undefined; box?: Box | undefined }
  /** Typing into a field starts (the `type` event marks its end). `box`: the field (CSS pixels). */
  | {
      kind: "type_start"
      step: StepRef
      secret?: string | undefined
      /** When the run switched to this page (`now()`): a secret field's region starts after. */
      shown?: number | undefined
      /** With a secret: the id of its sensitive region (later `secret_field` events use it). */
      sensitiveId?: string | undefined
      box?: Box | undefined
    }
  /** A click is about to be dispatched at (x, y), on the target's `box` (CSS pixels). */
  | {
      kind: "click"
      step: StepRef
      x: number
      y: number
      box: Box
      button: "left" | "right"
      count: number
    }
  /**
   * A secret value shown as text on the page (`box`), or gone (no `box`). Recording only. `since`
   * (epoch ms): when the blur must start, the last scan that didn't see it (fails closed).
   */
  | {
      kind: "secret_text"
      step: StepRef
      id: string
      box?: Box | undefined
      viewport?: { width: number; height: number } | undefined
      since?: number | undefined
      /** The read (`now()`): started, and ended once the page drew (SECRETS-DESIGN T2). */
      at: number
      end: number
      /** When the run switched to the page read (T3: nothing it saw was on screen before). */
      shown: number
      /** Gone because the capture left its page (T4: covered until the next page's first frame). */
      atSwitch?: boolean | undefined
    }
  /** Where a field holding a secret is now (`box`), or that it's gone (no `box`). Recording only. */
  | {
      kind: "secret_field"
      step: StepRef
      id: string
      box?: Box | undefined
      /** The CSS viewport the box was measured in (pages can differ: a popup has its own). */
      viewport?: { width: number; height: number } | undefined
      /** The read (`now()`): started, and ended once the page drew (SECRETS-DESIGN T2). */
      at: number
      end: number
      /** When the run switched to the page read (T3: nothing it saw was on screen before). */
      shown: number
      /** Gone because the capture left its page (T4: covered until the next page's first frame). */
      atSwitch?: boolean | undefined
      /** Back on screen since (ms, `now()`): a page switch back. By default, since it left. */
      since?: number | undefined
    }
  /** A key combination was pressed (`press` action). */
  | { kind: "key"; step: StepRef; keys: string }
  /** The cursor moved or was pressed/released (CSS pixels of the viewport). For the recorder (P0-5). */
  | { kind: "cursor"; step: StepRef; x: number; y: number; pressed: boolean }
  /** A fallback locator was used: the primary one no longer matches (a signal for self-healing). */
  | { kind: "target_fallback"; step: StepRef; fallbackIndex: number }
  /** Teardown failed after a step had already failed: the step's error is the one thrown. */
  | { kind: "teardown_failed"; error: StepError }
  /** Something the take should mention (it didn't stop the run). */
  | { kind: "warning"; message: string }
  /** An interrupt rule matched before a step (or when a step failed) and is being handled. */
  | { kind: "interrupt_start"; step: StepRef; rule: string }
  /** It's handled: the span since interrupt_start is cut from the video. */
  | { kind: "interrupt_end"; step: StepRef; rule: string }
  /** A preset's steps all ran: for a session preset, the moment to save the context's state. */
  | { kind: "preset_done"; name: string; session: boolean }

export interface RunOptions {
  /**
   * Resolves a secret NAME to its value, at the moment of the write, for this use (step, page,
   * target, element): the vault's resolver (`Vault.resolver`). Throw if unavailable or refused (a
   * `SecretRefusal`'s message is reported; any other error's never is).
   */
  resolveSecret?: (name: string, use: SecretUse) => string | Promise<string>
  /**
   * An interactive run (grounding, a re-record in the app) asks the user when a use has no grant
   * yet (SECRETS-DESIGN §3 A3): true once the host recorded their approval (`Vault.approve`).
   * Headless runs don't pass it: an ungranted use fails.
   */
  requestApproval?: (request: ApprovalRequest) => boolean | Promise<boolean>
  /** The host's id of the project folder: the scope of its approvals. Never read from project.json. */
  scope?: string
  /**
   * The host's id for this scene (kept outside the project; a deleted scene's replacement gets a
   * new one, even if the agent reuses its ids): the approval keys of the scene's own steps.
   */
  sceneId?: string
  /** The org interrupt rules this run's config kept from the org (their approvals are the org's). */
  orgInterrupts?: { orgId: string; ruleIds: readonly string[] }
  /** Resolves an `upload` step's project asset (`<sha256>.<ext>`) to a file path. */
  resolveAsset?: (file: string) => string | Promise<string>
  /**
   * The runner now drives another page: a tab or popup the last step opened, or back to its opener
   * when that one closed. Awaited before the next step (the recorder moves its screencast here).
   */
  onPageSwitch?: (page: Page) => void | Promise<void>
  /** Called for every runner event. Must not throw. */
  onEvent?: (event: RunnerEvent) => void
  /** Risky steps (delete, send, pay…) run only if this returns true (approval / sandbox, §7.2). */
  approveRisky?: (step: StepRef) => boolean | Promise<boolean>
  /** Per-step timeout for finding targets and waiting on conditions. Default 5000 ms. */
  timeoutMs?: number
  /** Timeout of a `goto` navigation (page load). Default 30000 ms. */
  navigationTimeoutMs?: number
  /** Set by the recorder: measure targets and fields for the take (extra page round trips). */
  recording?: boolean
  /**
   * Session presets whose state the page already has (its context was created from the storage
   * state saved after they ran, once per batch): they're skipped. See the `preset_done` event.
   */
  skipSessionPresets?: readonly string[]
  /**
   * Values of the project's secrets, for scrubbing and the on-screen scan only (never typed): a
   * scene whose login was skipped still blurs "Logged in as bob@acme.com". Memory only.
   */
  knownSecretValues?: readonly string[]
  /**
   * A session preset's steps all ran: the moment to save the context's state (awaited before the
   * setup goes on, so the state has the login and nothing the scene did after it).
   */
  onSessionReady?: (preset: string, page: Page) => void | Promise<void>
  /**
   * Where each skipped session preset ended (a path of the target app): the setup goes there in
   * its place, since a later setup step may rely on that page.
   */
  sessionLandings?: Readonly<Record<string, string>>
}

export type AnyAction = Action | Step

/** A page's CSS viewport (boxes are normalized in the one they were measured in). */
export interface Viewport {
  width: number
  height: number
}

/** Playwright treats a timeout of 0 as "wait forever": never pass it through. */
export const MIN_TIMEOUT_MS = 1

export interface Ctx {
  page: Page
  base: URL
  settleMs: number
  timeoutMs: number
  navigationTimeoutMs: number
  network: NetworkTracker
  /** Pages this run came from (the opener of each tab or popup followed), most recent last. */
  openers: Page[]
  /** Tabs and popups the driven page opened, not followed yet. */
  opened: Page[]
  /** Moves the run's navigation reports to or from a page. */
  attach: (page: Page) => void
  detach: (page: Page) => void
  /** The network tracker of a page (kept for the whole run). */
  trackerOf: (page: Page) => NetworkTracker
  /** Where the cursor was on each page the run left. */
  cursors: Map<Page, Point>
  /** The project's interrupt rules (the org's rule bank included, `resolveProjectConfig`). */
  interrupts: ProjectConfig["interrupts"]
  /** Runs an action (`perform`), for the modules `actions.ts` itself depends on (no import cycle). */
  perform: (action: AnyAction, step: StepRef) => Promise<void>
  /** CSS hiding the project's `hide` selectors ("" when there are none). */
  hideCss: string
  /** Rules handled on each page: at most once per page and run (a banner fading out in place still matches). */
  interruptsDone: WeakMap<Page, Set<string>>
  /** True while a rule's `do` runs: its own actions never start another interrupt check. */
  inInterrupt: boolean
  setCurrent: (step: StepRef | undefined) => void
  /** Secret values resolved during this run (memory only): anything reported is scrubbed of them. */
  secretValues: Set<string>
  /** Secret values shown as text (recording): what the last scan saw, by region id. */
  secretText: {
    /** Box key → region id. */
    shown: Map<string, string>
    next: number
    lastScan: number
    /** When the run started, and how many values the last scan knew. */
    runStart: number
    values: number
    inflight: Promise<void> | undefined
  }
  /** Elements a secret was written to in this run (SECRETS-DESIGN §3 A5: no copy or drag from them). */
  secretWritten: { page: Page; handle: ElementHandle }[]
  /** When the driven page became the one on screen (`now()`): a field back on it since then. */
  pageShownAt: number
  /** Pages with a read that took too long still pending: no new read of them until it settles. */
  stuckReads: WeakMap<Page, number>
  /** A page switch is under way (the capture hasn't followed yet): the tick measures nothing. */
  switching: boolean
  /** The field measurement running, if any (one at a time). */
  fieldsInflight: Promise<void> | undefined
  /** Fields a secret was typed into (recording): re-measured after every step. */
  secretFields: {
    id: string
    /** The target as the type step found it (a fallback when the handle's element is replaced). */
    locator: Locator
    /**
     * The element the secret was written to: followed first (not re-found by name: the field
     * itself turns exact names on, A8). Blur tracking is never reported to the agent.
     */
    handle?: ElementHandle
    page: Page
    /** Its type_start was reported: followed from then on (never while the cursor travels to it). */
    typed?: boolean
    /** Its region has an open box (a box reported, no "gone" or leave since). */
    onScreen?: boolean
    /** Left with its page: its next box is dated from the switch back. */
    leftPage?: boolean
    /** When the last read that found it gone started (a return is dated from it). */
    goneReadAt?: number
    /** The viewport its last real box was measured in. */
    lastViewport?: Viewport | undefined
    /** The last real box (kept while the run is on another page). */
    lastBox?: Box
  }[]
  /** Rethrows (once) an error raised inside a Playwright event listener during this step. */
  throwListenerError: () => void
  clearListenerError: () => void
  /** Where the cursor is (CSS pixels); undefined until the first movement. */
  cursor: Point | undefined
  pacing: { cursor: CursorPacing; typing: TypingPacing }
  options: RunOptions
}

export function timeoutOf(ctx: Ctx, stepTimeout: number | undefined): number {
  return Math.max(MIN_TIMEOUT_MS, stepTimeout ?? ctx.timeoutMs)
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Seed of a step's random motion: the same step always moves the same way. */
export function seedOf(step: StepRef): string {
  return `${step.phase}:${step.stepId ?? step.index}`
}

/** First line of an error's message (Playwright errors carry long call logs after it). */
export function firstLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.split("\n")[0] || "action failed"
}

/** Runs a Playwright call and turns its failure into a StepError on this step. */
export async function guard<T>(step: StepRef, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    if (cause instanceof StepError) throw cause
    if (cause instanceof ProbeRefusal) throw new StepError(step, "secret-refused", cause.message)
    throw new StepError(step, "action-failed", firstLine(cause), { cause })
  }
}
