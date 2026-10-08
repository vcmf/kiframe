// The one IPC contract between the main process and the window: each request channel's arguments
// (a Zod schema: main validates every payload, the window is never trusted), its result, and the
// events main pushes. The preload, main's handlers and the window's API are all typed from here.
import type {
  Composition,
  CursorSample,
  Scenario,
  Style,
  TakeEvent,
  TakeMeta,
} from "@kiframe/schema"
import { z } from "zod"
import { INVOKE_CHANNELS, EVENT_CHANNELS } from "./channels.ts"

/**
 * Files attached to one message at most, and a file's size at most (the largest type's: images,
 * `FILE_LIMITS.imageBytes`; main checks each type's own). What the window may attach (main checks
 * the content again).
 */
export const MAX_ATTACHMENTS = 5
export const ATTACHMENT_BYTES = 10 * 1024 * 1024
/** Each type the window may attach and its size at most (the project's `ATTACHMENT_TYPES`). */
export const ATTACHABLE: Readonly<Record<string, number>> = {
  png: ATTACHMENT_BYTES,
  jpg: ATTACHMENT_BYTES,
  jpeg: ATTACHMENT_BYTES,
  gif: ATTACHMENT_BYTES,
  webp: ATTACHMENT_BYTES,
  md: 1024 * 1024,
  txt: 1024 * 1024,
  svg: 512 * 1024,
  html: 512 * 1024,
  htm: 512 * 1024,
}
/** Those shown to the agent as images (an SVG is read as text). */
export const IMAGE_ATTACHABLE: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp"]

/** A file the user attaches: its name as the system gave it, and its bytes. */
export interface AttachedFile {
  name: string
  bytes: Uint8Array<ArrayBuffer>
}

/** An app's name as the project writes it (`AppName`'s form; main looks it up in the project). */
const AppName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)

/**
 * An app of the project as the window shows it: a web app by its exact origin (main's: never derived
 * here), a desktop app by its bundle id.
 */
export type AppView =
  | { name: string; kind: "web"; origin: string }
  | { name: string; kind: "electron"; bundleId: string }

/** What an app is, as one string (its exact origin, or its bundle id): an app removed is that one. */
export function appViewIdentity(app: AppView): string {
  return app.kind === "web" ? app.origin : app.bundleId
}

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
  /**
   * Apps it uses that the project doesn't list (one was removed): it can't run until reworked; its
   * take still plays.
   */
  removedApps?: string[]
  /** A recorded scene's take (its key): the preview plays it again when it changes. */
  take?: string
  /** What a recorded scene plays (its scenario and composition, hashed): edited, played again. */
  version?: string
}

/** The open project as the window shows it. */
export interface ProjectView {
  /** This opening of the project (a reopen is a new one: the window starts its chat afresh). */
  session: string
  name: string
  /** The folder (shown in the title bar's menu; never sent back by the window to open it). */
  dir: string
  /** Every app of the project, in order, with its exact origin (main's: never derived here). */
  apps: AppView[]
  scenes: SceneView[]
  /** Parts that didn't read (shown, never hidden). */
  problems: string[]
}

/** What the agent asks the user (the studio's `UserRequest`), as the chat shows it. */
export type ChatRequest =
  /**
   * The user takes the live browser for a moment: the agent's task beside the page's own origin
   * (main's: never the agent's words alone), `onApp` when it's one of the project's apps.
   */
  | {
      kind: "handover"
      task: string
      doneWhen?: string
      origin: string
      onApp: boolean
      /** The live app, a scene being checked (a replay), or recorded (never filmed meanwhile). */
      where: "live" | "check" | "record"
      scene?: string
    }
  | { kind: "question"; question: string }
  | { kind: "approve-risky"; scene: string; step: string; action: string }
  /** Delete a page's file, or replace a whole file the agent didn't write (the file tools). */
  | { kind: "approve-file"; action: "delete" | "replace"; path: string }
  /**
   * Add a site to the project's apps (the studio's `AppCard`): built in main from the address that
   * would be written; `why` is the agent's words (cleaned to one plain line).
   */
  | {
      kind: "approve-app"
      name: string
      url: string
      host: string
      plain: boolean
      lookalike: boolean
      local: boolean
      secrets?: number
      usedBy: string[]
      why: string
    }
  /**
   * A secret typed where no approval covers it yet (§3 A3), built from the live page only (never
   * the agent's words): the element, the page, the step, and the page as it is with the element
   * outlined. The shot goes once the request is answered or closed.
   */
  | {
      kind: "approve-secret"
      secret: string
      element: { tag: string; type: string; label: string | null }
      origin: string
      path: string
      /** The step that types it ("pw, in the setup"). */
      step: string
      /** The page as it is (a JPEG, base64); `width`×`height` CSS pixels. */
      shot?: { jpeg: string; width: number; height: number }
      box?: { x: number; y: number; width: number; height: number }
    }

/**
 * A scene's preview for the player: its composition, scenario and take (records and frames), or
 * why it can't play (said in words: not filmed, a take of an older scenario, gone).
 */
export type Preview =
  | {
      ok: true
      sceneId: string
      title: string
      composition: Composition
      scenario: Scenario
      take: { meta: TakeMeta; events: TakeEvent[]; cursor: CursorSample[] }
      /** The take's frames.webm. */
      video: Uint8Array
      /** The scene's style as it exports: project, scene and its output's, resolved. */
      style: Style
      /** The output's size (the first video output playing the scene; else the default). */
      format: { width: number; height: number; fps: number }
    }
  | { ok: false; why: string }

/** An app's secrets as the window shows them (each app of the open project, in order). */
export interface SecretGroup {
  app: string
  /** Where these secrets are typed (the app's exact origin). */
  origin: string
  secrets: SecretView[]
}

/** A secret as the window shows it: never its value. */
export interface SecretView {
  name: string
  kind: "password" | "username" | "api_key" | "text"
  /** Where it may be typed. */
  origins: string[]
  /** Its value is in the keychain on this machine. */
  provided: boolean
}

/**
 * One item of the chat, as main folds the agent's events (the window only shows them): a new
 * item, or a newer version of one (same id), replaces what the window had.
 */
export type ChatItem =
  /** `attachments`: the files the user attached, as written in the project (inputs/…). */
  | { kind: "user"; id: string; text: string; attachments?: string[] }
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
  /** A stretch of the model's thinking (never its words): under way, then how long it took. */
  | { kind: "thinking"; id: string; ms?: number }
  | {
      kind: "request"
      id: string
      request: ChatRequest
      /** `closed`: the run stopped before the user answered. */
      state: "open" | "answered" | "closed"
      answer?: ChatAnswer
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

/** A frame of the live app (the agent's browser), view only but during a handover. */
export interface LiveFrame {
  /** A JPEG, base64. */
  jpeg: string
  /** The page's path (never its query: it may hold a value). */
  path: string
  /** Which page it shows (a new one per page followed): input on an older frame is dropped. */
  gen: number
}

/** A handover's answer: done or not, and a note for the agent. */
export const HandoverAnswer = z.strictObject({
  outcome: z.enum(["done", "declined"]),
  note: z.string().max(2000),
  /** What the user typed hidden from the agent from now on (their call: a search term isn't). */
  hide: z.boolean(),
})

/** An answer to a request: text, a yes or no, a handover's end. */
export type ChatAnswer = string | boolean | z.infer<typeof HandoverAnswer>

/** Modifiers a key is pressed with (never held alone: AltGr/Option text stays text). */
export const LIVE_MODIFIERS = ["Shift", "Control", "Alt", "Meta"] as const

/** Keys the live view sends during a handover, each pressed once (text goes as text). */
export const LIVE_KEYS = [
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
] as const

const Point = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) }

/** One input from the live view during a handover (a point: 0–1 of the frame). */
export const LiveInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("mouse"),
    type: z.enum(["move", "down", "up"]),
    ...Point,
    button: z.enum(["left", "right", "middle"]),
    clickCount: z.number().int().min(0).max(3),
  }),
  z.strictObject({
    kind: z.literal("wheel"),
    ...Point,
    dx: z.number().min(-5000).max(5000),
    dy: z.number().min(-5000).max(5000),
  }),
  z.strictObject({
    kind: z.literal("key"),
    key: z.enum(LIVE_KEYS),
    modifiers: z.array(z.enum(LIVE_MODIFIERS)).max(4),
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(2000) }),
])
export type LiveInput = z.infer<typeof LiveInput>

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
  /**
   * A message to the agent: starts a run (refused while one is going). With up to 5 files the user
   * attached (their bytes, never a path main would read: checked and written by main); then the
   * text may be empty.
   */
  "chat:send": z
    .tuple([
      z.string().trim().max(20_000),
      z
        .array(
          z.object({
            name: z.string().min(1).max(255),
            bytes: z
              .instanceof(Uint8Array)
              .refine((b) => b.byteLength <= ATTACHMENT_BYTES, "a file is at most 10 MB"),
          }),
        )
        .max(MAX_ATTACHMENTS)
        .optional(),
    ])
    .refine(([text, files]) => text !== "" || (files?.length ?? 0) > 0, "an empty message"),
  /** Stops the run (its tools and open requests with it). */
  "chat:stop": z.tuple([]),
  /** The user's answer to an open request (by its item id). */
  "chat:answer": z.tuple([
    z.string().max(64),
    z.union([z.string().max(5000), z.boolean(), HandoverAnswer]),
  ]),
  /**
   * The user's hands on the live app during a handover (by its request's item id, on the frame
   * `gen` they saw): dropped unless that handover is open and the frame current.
   */
  "live:input": z.tuple([z.string().max(64), z.number().int().min(0), LiveInput]),
  /** The open project's secrets, app by app. */
  "secrets:list": z.tuple([]),
  /**
   * A secret for one of the open project's apps (by name: main finds its origin), in the opening
   * the window shows (`session`: refused once another project opened). Its value goes to the
   * keychain (never back to the window); its name is checked in main (a secret name, never a value).
   */
  "secrets:add": z.tuple([
    z.strictObject({
      session: z.string().max(64),
      app: AppName,
      name: z.string().trim().min(1).max(120),
      kind: z.enum(["password", "username", "api_key", "text"]),
      value: z.string().min(1).max(4096),
    }),
  ]),
  /**
   * Takes a secret off one of the open project's apps (its approvals there); the secret itself goes
   * when no other app uses it. Its name is checked in main.
   */
  "secrets:remove": z.tuple([
    z.strictObject({ session: z.string().max(64), app: AppName, name: z.string().max(120) }),
  ]),
  /**
   * Takes an app off the open project (main asks first, naming the scenes that use it): named with
   * the origin the window shows (refused when the project's app by that name is another now).
   */
  "apps:remove": z.tuple([
    z.strictObject({ session: z.string().max(64), name: AppName, identity: z.string().max(2048) }),
  ]),
  /** A scene of the open project, to play (its id, checked against the project in main). */
  "preview:open": z.tuple([z.string().min(1).max(200)]),
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
  "live:input": void
  "secrets:list": SecretGroup[]
  /** null when done; else why not, in words. */
  "secrets:add": string | null
  "secrets:remove": string | null
  /** null when removed or cancelled; else why not, in words. */
  "apps:remove": string | null
  "preview:open": Preview
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
