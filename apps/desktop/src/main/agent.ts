// The agent for the open project: one run at a time, its events folded into the chat, its
// requests (a question, a risky step's approval) bridged to the window by id. Electron-free: main
// gives it the browser, the model and where to send things (tested with a scripted model).
import type { LlmClient, LlmMessage } from "@kiframe/agent"
import { runAgent } from "@kiframe/agent"
import type { OpenedProject, TakeStore } from "@kiframe/project"
import { resolveProjectConfig } from "@kiframe/schema"
import { Studio, studioTools, systemPrompt } from "@kiframe/studio"
import type { Browser } from "playwright"
import type { ApprovalRequest, SecretUse } from "@kiframe/runtime"
import type { ChatItem, ChatRequest, ChatState, LiveFrame } from "../shared/ipc.ts"
import { errorMessage } from "../shared/util.ts"
import { ChatLog, oneLine } from "./chat-log.ts"
import { LiveView } from "./live.ts"
import type { Secrets } from "./secrets.ts"

/** Assistant text repainted at most this often (tool steps and requests at once). */
const TEXT_MS = 100
/** Tools whose result changes the project (the scene strip is refreshed after them). */
const PROJECT_TOOLS = new Set(["save_scene", "record_scene"])

export interface AgentHostOptions {
  project: OpenedProject
  /** The host's approval scope for the folder, and its key for a scene (the registry). */
  scope: string
  sceneKey: (sceneId: string) => string
  takes: TakeStore
  /** The browser the studio works in (launched once, shared). */
  browser: () => Promise<Browser>
  /** The model for a run (built from the key in the keychain then). */
  llm: () => Promise<LlmClient>
  model: string
  /** The app's secrets (none: a scene typing one fails, "no secret resolver given"). */
  secrets?: Secrets
  item: (item: ChatItem) => void
  running: (running: boolean) => void
  frame: (frame: LiveFrame) => void
  /** A tool changed the project (a scene saved, a take recorded). */
  projectChanged: () => void
}

interface Pending {
  request: ChatRequest
  resolve: (answer: string | boolean) => void
}

/** A step key as the user reads it ("pw, in the setup"; "pw, in the login preset"). */
export function stepLabel(stepKey: string): string {
  const scene = /^scene:[^/]+\/(setup|steps|teardown)\/(.+)$/.exec(stepKey)
  if (scene !== null) {
    const part = scene[1] === "steps" ? "the scene's steps" : `the ${scene[1]}`
    return `${scene[2]}, in ${part}`
  }
  const preset = /^preset:([^/]+)\/(.+)$/.exec(stepKey)
  if (preset !== null) return `${preset[2]}, in the ${preset[1]} preset`
  const interrupt = /interrupt:(.+)$/.exec(stepKey)
  return interrupt !== null ? `the ${interrupt[1]} interrupt rule` : stepKey
}

/** The approval prompt, from the live page only (§3 A3: never the agent's words). */
export function secretRequest(request: ApprovalRequest): ChatRequest {
  const { use } = request
  return {
    kind: "approve-secret",
    secret: request.secret,
    element: use.element,
    origin: use.origin,
    path: use.path,
    step: stepLabel(use.stepKey),
    ...(request.shot !== undefined && { shot: request.shot }),
    ...(request.box !== undefined && { box: request.box }),
  }
}

export class AgentHost {
  readonly #options: AgentHostOptions
  readonly #log = new ChatLog()
  #history: LlmMessage[] = []
  #studio: Studio | undefined
  /** The browser the studio was made in. */
  #browser: Browser | undefined
  /** The live app's last frame (a reloaded window shows where the run ended). */
  #frame: LiveFrame | null = null
  #live: LiveView | undefined
  #run: { controller: AbortController; done: Promise<void> } | undefined
  readonly #pending = new Map<string, Pending>()
  /** The streaming text item: sent, and its newer version (if any) waiting for the timer. */
  #text: { item: ChatItem; newer: boolean; timer: ReturnType<typeof setTimeout> } | undefined
  #closed = false
  /** The last run's live view stopping (its last frame): a next run starts it after. */
  #liveStopped: Promise<void> = Promise.resolve()

  constructor(options: AgentHostOptions) {
    this.#options = options
  }

  state(): ChatState {
    return {
      items: [...this.#log.items],
      running: this.#run !== undefined,
      model: this.#options.model,
      frame: this.#frame,
    }
  }

  /** Starts a run: null, or why it didn't start. */
  send(text: string): string | null {
    if (this.#closed) return "the project is closed"
    if (this.#run !== undefined) return "the agent is still working: stop it first"
    const controller = new AbortController()
    this.#run = { controller, done: this.#go(text, controller.signal) }
    return null
  }

  /** Stops the run: its model call and tool, and every open request with it. */
  stop(): void {
    this.#run?.controller.abort()
  }

  /** The user's answer to an open request (a mismatched kind is ignored). */
  answer(id: string, answer: string | boolean): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    const fits =
      pending.request.kind === "question" ? typeof answer === "string" : typeof answer === "boolean"
    if (fits) pending.resolve(answer)
  }

  /** The project closes: the run stops, then the studio's browser context closes. */
  async close(): Promise<void> {
    this.#closed = true
    this.stop()
    await this.#run?.done
    // The live view's last frame too (never racing the context closing).
    await this.#liveStopped
    await this.#studio?.close()
  }

  async #go(text: string, signal: AbortSignal): Promise<void> {
    this.#notify("running", true)
    this.#emit(this.#log.user(text))
    try {
      const studio = await this.#ensureStudio()
      const llm = await this.#options.llm()
      this.#live ??= new LiveView(
        () => studio.currentPage,
        (frame) => {
          this.#frame = frame
          this.#notify("frame", frame)
        },
      )
      await this.#liveStopped
      this.#live.start()
      for await (const event of runAgent({
        userMessage: text,
        tools: studioTools,
        llm,
        context: studio,
        system: systemPrompt(studio),
        history: this.#history,
        signal,
      })) {
        // The run's turns, kept as they come.
        if ("messages" in event) this.#history = [...this.#history, ...event.messages]
        for (const item of this.#log.event(event)) this.#emit(item, event.type === "assistant_text")
        if (event.type === "tool_result" && PROJECT_TOOLS.has(event.toolName)) {
          this.#notify("projectChanged")
        }
      }
    } catch (error) {
      // Before the run could start (the browser, the project's config, the key): said as its end,
      // and the message kept for the model (the chat shows it: the next run knows it was said).
      this.#history = [...this.#history, { role: "user", content: text }]
      const message = errorMessage(error)
      for (const item of this.#log.event({
        type: "error",
        message: oneLine(message),
        messages: [],
      })) {
        this.#emit(item)
      }
    } finally {
      this.#flushText()
      // The run is over for the user at once (Stop works, a message can go); the live view's last
      // frame comes after, and a next run's live view waits for it.
      this.#run = undefined
      this.#notify("running", false)
      this.#liveStopped = this.#live?.stop() ?? Promise.resolve()
      await this.#liveStopped
    }
  }

  async #ensureStudio(): Promise<Studio> {
    // A studio whose browser died (crashed, killed) is made again in a new one.
    if (this.#studio !== undefined && this.#browser?.isConnected() !== false) return this.#studio
    await this.#studio?.close().catch(() => undefined)
    this.#studio = undefined
    this.#live = undefined
    const { project, scope, sceneKey, takes } = this.#options
    const { config } = resolveProjectConfig(project.project, undefined)
    const { secrets } = this.#options
    // Every value known before anything runs (R6).
    await secrets?.ready()
    const origin = new URL(config.target.url).origin
    const browser = await this.#options.browser()
    this.#browser = browser
    this.#studio = new Studio({
      project,
      scope,
      sceneKey,
      config,
      takes,
      browser,
      requestUser: (request, signal) => this.#ask(request, signal),
      // Secrets (when the app has its vault): names for the agent, values for granted uses only,
      // every value known to the scrubber and the blur; an ungranted use asks the user.
      ...(secrets !== undefined && {
        secrets: () => secrets.names(origin),
        resolveSecret: (name: string, use: SecretUse) => secrets.resolve(name, use),
        knownValues: () => secrets.knownValues(),
        requestApproval: async (request: ApprovalRequest, signal: AbortSignal) => {
          const approved = (await this.#ask(secretRequest(request), signal)) === true
          // Granted only by the user's answer, in main (never by the agent).
          if (approved) await secrets.approve(request.secret, request.use)
          return approved
        },
      }),
    })
    return this.#studio
  }

  /** A request shown in the chat until answered, or closed by the stop (it then rejects). */
  #ask(request: ChatRequest, signal: AbortSignal): Promise<string | boolean> {
    signal.throwIfAborted()
    const item = this.#log.request(request)
    this.#emit(item)
    return new Promise((resolve, reject) => {
      const done = () => {
        this.#pending.delete(item.id)
        signal.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        done()
        const closed = this.#log.settle(item.id, "closed")
        if (closed !== undefined) this.#emit(closed)
        reject(signal.reason instanceof Error ? signal.reason : new Error("stopped"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.#pending.set(item.id, {
        request,
        resolve: (answer) => {
          done()
          const answered = this.#log.settle(item.id, { answer })
          if (answered !== undefined) this.#emit(answered)
          resolve(answer)
        },
      })
    })
  }

  /** Tells main something (the window): a failure there never breaks the run. */
  #notify<K extends "item" | "running" | "frame" | "projectChanged">(
    what: K,
    ...args: Parameters<AgentHostOptions[K]>
  ): void {
    try {
      ;(this.#options[what] as (...a: Parameters<AgentHostOptions[K]>) => void)(...args)
    } catch {
      // the window gone or failing: the run, and its history, go on
    }
  }

  /** Sends an item; streaming text at most every `TEXT_MS` (the last one always goes). */
  #emit(item: ChatItem, text = false): void {
    if (!text) {
      this.#flushText()
      this.#notify("item", item)
      return
    }
    if (this.#text !== undefined && this.#text.item.id === item.id) {
      this.#text.item = item
      this.#text.newer = true
      return
    }
    this.#flushText()
    this.#notify("item", item)
    this.#text = { item, newer: false, timer: setTimeout(() => this.#flushText(), TEXT_MS) }
  }

  #flushText(): void {
    if (this.#text === undefined) return
    clearTimeout(this.#text.timer)
    const { item, newer } = this.#text
    this.#text = undefined
    if (newer) this.#notify("item", item)
  }
}
