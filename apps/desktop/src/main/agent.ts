// The agent for the open project: one run at a time, its events folded into the chat, its
// requests (a question, a risky step's approval) bridged to the window by id. Electron-free: main
// gives it the browser, the model and where to send things (tested with a scripted model).
import type { LlmClient, LlmMessage } from "@kiframe/agent"
import { runAgent } from "@kiframe/agent"
import type { OpenedProject, TakeStore } from "@kiframe/project"
import { resolveProjectConfig } from "@kiframe/schema"
import { Studio, studioTools, systemPrompt, type UserRequest } from "@kiframe/studio"
import type { Browser } from "playwright"
import type { ChatItem, ChatState, LiveFrame } from "../shared/ipc.ts"
import { ChatLog, oneLine } from "./chat-log.ts"
import { LiveView } from "./live.ts"

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
  item: (item: ChatItem) => void
  running: (running: boolean) => void
  frame: (frame: LiveFrame) => void
  /** A tool changed the project (a scene saved, a take recorded). */
  projectChanged: () => void
}

interface Pending {
  request: UserRequest
  resolve: (answer: string | boolean) => void
}

export class AgentHost {
  readonly #options: AgentHostOptions
  readonly #log = new ChatLog()
  #history: LlmMessage[] = []
  #studio: Studio | undefined
  #live: LiveView | undefined
  #run: { controller: AbortController; done: Promise<void> } | undefined
  readonly #pending = new Map<string, Pending>()
  #text: { item: ChatItem; timer: ReturnType<typeof setTimeout> } | undefined
  #closed = false

  constructor(options: AgentHostOptions) {
    this.#options = options
  }

  state(): ChatState {
    return {
      items: [...this.#log.items],
      running: this.#run !== undefined,
      model: this.#options.model,
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
      pending.request.kind === "approve-risky"
        ? typeof answer === "boolean"
        : typeof answer === "string"
    if (fits) pending.resolve(answer)
  }

  /** The project closes: the run stops, then the studio's browser context closes. */
  async close(): Promise<void> {
    this.#closed = true
    this.stop()
    await this.#run?.done
    await this.#studio?.close()
  }

  async #go(text: string, signal: AbortSignal): Promise<void> {
    this.#options.running(true)
    this.#emit(this.#log.user(text))
    try {
      const studio = await this.#ensureStudio()
      const llm = await this.#options.llm()
      this.#live ??= new LiveView(() => studio.currentPage, this.#options.frame)
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
        for (const item of this.#log.event(event)) this.#emit(item, event.type === "assistant_text")
        if (event.type === "tool_result" && PROJECT_TOOLS.has(event.toolName)) {
          this.#options.projectChanged()
        }
        if ("messages" in event) this.#history = [...this.#history, ...event.messages]
      }
    } catch (error) {
      // Before the run could start (the browser, the project's config, the key): said as its end.
      const message = error instanceof Error ? error.message : String(error)
      for (const item of this.#log.event({
        type: "error",
        message: oneLine(message),
        messages: [],
      })) {
        this.#emit(item)
      }
    } finally {
      this.#flushText()
      await this.#live?.stop()
      this.#run = undefined
      this.#options.running(false)
    }
  }

  async #ensureStudio(): Promise<Studio> {
    if (this.#studio !== undefined) return this.#studio
    const { project, scope, sceneKey, takes } = this.#options
    const { config } = resolveProjectConfig(project.project, undefined)
    const browser = await this.#options.browser()
    this.#studio = new Studio({
      project,
      scope,
      sceneKey,
      config,
      takes,
      browser,
      requestUser: (request, signal) => this.#ask(request, signal),
    })
    return this.#studio
  }

  /** A request shown in the chat until answered, or closed by the stop (it then rejects). */
  #ask(request: UserRequest, signal: AbortSignal): Promise<string | boolean> {
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

  /** Sends an item; streaming text at most every `TEXT_MS` (the last one always goes). */
  #emit(item: ChatItem, text = false): void {
    if (!text) {
      this.#flushText()
      this.#options.item(item)
      return
    }
    if (this.#text !== undefined && this.#text.item.id === item.id) {
      this.#text.item = item
      return
    }
    this.#flushText()
    this.#options.item(item)
    this.#text = { item, timer: setTimeout(() => this.#flushText(), TEXT_MS) }
  }

  #flushText(): void {
    if (this.#text === undefined) return
    clearTimeout(this.#text.timer)
    const { item } = this.#text
    this.#text = undefined
    this.#options.item(item)
  }
}
