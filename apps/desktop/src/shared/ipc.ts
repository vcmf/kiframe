// The one IPC contract between the main process and the window: each request channel's arguments
// (a Zod schema: main validates every payload, the window is never trusted), its result, and the
// events main pushes. The preload, main's handlers and the window's API are all typed from here.
import { z } from "zod"
import { INVOKE_CHANNELS, EVENT_CHANNELS } from "./channels.ts"

/** A scene as the window shows it (the scene strip). */
export interface SceneView {
  id: string
  title: string
  /**
   * `recorded`: a composition from a take; `grounded`: a scenario, not filmed yet; `empty`: a
   * recording with no scenario yet; `card`: a title card; `unreadable`: a part of it didn't read
   * (`problem` says which); `missing`: the sequence names it, its folder is gone.
   */
  status: "recorded" | "grounded" | "empty" | "card" | "unreadable" | "missing"
  /** What didn't read, when something didn't. */
  problem?: string
}

/** The open project as the window shows it. */
export interface ProjectView {
  name: string
  /** The folder (shown in the title bar's menu; never sent back by the window to open it). */
  dir: string
  /** The app it films (null when the project names an environment instead). */
  url: string | null
  scenes: SceneView[]
  /** Parts that didn't read (shown, never hidden). */
  problems: string[]
}

/** What the window needs to know to show the right screen. */
export interface AppStatus {
  /** An OpenRouter key is in the keychain (its value never leaves main). */
  hasKey: boolean
  project: ProjectView | null
  /** Why the last action failed, in words the user can act on (cleared by the next one). */
  error: string | null
}

/** Each request channel's arguments, validated in main. */
export const invokeArgs = {
  "app:status": z.tuple([]),
  /** The OpenRouter key: stored in the keychain, never echoed back. */
  "key:set": z.tuple([z.string().trim().min(1).max(512)]),
  "key:clear": z.tuple([]),
  /**
   * A new project: main checks the address (the project schema's rule, said as the status's
   * error) and asks where to put it (the window never names a path).
   */
  "project:create": z.tuple([
    z.strictObject({
      name: z.string().trim().min(1).max(120),
      url: z.string().trim().min(1).max(2048),
    }),
  ]),
  /** Main shows the folder picker. */
  "project:open": z.tuple([]),
  "project:close": z.tuple([]),
  /** An https link opened in the user's browser. */
  "external:open": z.tuple([z.string().max(2048)]),
} satisfies Record<(typeof INVOKE_CHANNELS)[number], z.ZodTuple>

export type InvokeChannel = keyof typeof invokeArgs
export type InvokeArgs<C extends InvokeChannel> = z.infer<(typeof invokeArgs)[C]>

/** Each request channel's result. */
export interface InvokeResults {
  "app:status": AppStatus
  "key:set": AppStatus
  "key:clear": AppStatus
  "project:create": AppStatus
  "project:open": AppStatus
  "project:close": AppStatus
  "external:open": void
}

/** What main pushes to the window. */
export interface Events {
  /**
   * The status changed on main's own (not as an action's result, which comes back from the
   * action): the whole status, not a diff. Sent from S3b (the agent changing the project).
   */
  status: AppStatus
}
export type EventChannel = keyof Events

/** The API the preload exposes to the window as `window.kiframe`. */
export interface KiframeApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResults[C]>
  /** Subscribes to an event; returns the unsubscribe. */
  on<E extends EventChannel>(channel: E, listener: (payload: Events[E]) => void): () => void
  /** The platform (the title bar leaves room for macOS's window buttons). */
  platform: string
}

// Compile-time: the channel lists the preload allows are exactly the contract's.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _invokes: Same<(typeof INVOKE_CHANNELS)[number], keyof InvokeResults> = true
const _events: Same<(typeof EVENT_CHANNELS)[number], EventChannel> = true
void _invokes
void _events
