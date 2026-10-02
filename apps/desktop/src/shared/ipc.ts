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
  /** This opening of the project (a reopen is a new one: the window starts its chat afresh). */
  session: string
  name: string
  /** The folder (shown in the title bar's menu; never sent back by the window to open it). */
  dir: string
  /** The app it films (null when the project names an environment instead). */
  url: string | null
  scenes: SceneView[]
  /** Parts that didn't read (shown, never hidden). */
  problems: string[]
}

/** What the agent asks the user (the studio's `UserRequest`), as the chat shows it. */
export type ChatRequest =
  | { kind: "question"; question: string }
  | { kind: "approve-risky"; scene: string; step: string; action: string }

/**
 * One item of the chat, as main folds the agent's events (the window only shows them): a new
 * item, or a newer version of one (same id), replaces what the window had.
 */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | {
      kind: "tool"
      id: string
      name: string
      /** What it acts on, in a line (never a secret: the studio scrubs what it returns). */
      detail: string
      status: "running" | "ok" | "failed" | "stopped"
      /** Its result's first line, once it has one. */
      result?: string
    }
  | {
      kind: "request"
      id: string
      request: ChatRequest
      /** `closed`: the run stopped before the user answered. */
      state: "open" | "answered" | "closed"
      answer?: string | boolean
    }
  | {
      kind: "end"
      id: string
      outcome: "done" | "stopped" | "turn_limit" | "error"
      message?: string
    }

export interface ChatState {
  items: ChatItem[]
  /** A run is going (the composer is the status bar with Stop). */
  running: boolean
  /** The model the agent runs on (an OpenRouter id). */
  model: string
  /** The live app's last frame (null before the first run). */
  frame: LiveFrame | null
}

/** A frame of the live app (the agent's browser), view only. */
export interface LiveFrame {
  /** A JPEG, base64. */
  jpeg: string
  /** The page's path (never its query: it may hold a value). */
  path: string
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
  /** The open project's chat (after a reload). */
  "chat:state": z.tuple([]),
  /** A message to the agent: starts a run (refused while one is going). */
  "chat:send": z.tuple([z.string().trim().min(1).max(20_000)]),
  /** Stops the run (its tools and open requests with it). */
  "chat:stop": z.tuple([]),
  /** The user's answer to an open request (by its item id). */
  "chat:answer": z.tuple([z.string().max(64), z.union([z.string().max(5000), z.boolean()])]),
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
  "chat:state": ChatState
  /** null when the run started; else why not (said in words). */
  "chat:send": string | null
  "chat:stop": void
  "chat:answer": void
}

/** What main pushes to the window. */
export interface Events {
  /**
   * The status changed on main's own (not as an action's result, which comes back from the
   * action): the whole status, not a diff. Sent from S3b (the agent changing the project).
   */
  status: AppStatus
  /** A chat item, new or newer (same id: replaces it). */
  "chat:item": ChatItem
  /** A run started or ended. */
  "chat:running": boolean
  /** The live app, while the agent works on it. */
  "live:frame": LiveFrame
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
