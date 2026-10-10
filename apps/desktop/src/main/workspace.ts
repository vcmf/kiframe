// The open project and its agent, switched as one: the new project opened and its agent made first
// (a failure leaves the current one as it was), then the old agent closed. One switch at a time
// (two quick ones never leak an agent). Electron-free: main gives it how to make an agent.
import { randomBytes } from "node:crypto"
import { realpathSync } from "node:fs"
import { createProject, openProject, type OpenedProject } from "@kiframe/project"
import type { ProjectView } from "../shared/ipc.ts"
import { appView, projectView } from "./project.ts"

/** What the workspace needs of an agent. */
export interface Agent {
  close(): Promise<void>
}

export class Workspace<A extends Agent> {
  readonly #makeAgent: (opened: OpenedProject) => A
  #opened: OpenedProject | null = null
  #session = ""
  #agent: A | undefined
  #switching: Promise<unknown> = Promise.resolve()
  readonly #onSwitch: (() => void)[] = []

  readonly #ready: () => void

  /**
   * `ready` throws when an agent can't be made now (the registry doesn't read): checked before a
   * project is created (nothing written then) or opened.
   */
  constructor(makeAgent: (opened: OpenedProject) => A, ready: () => void = () => undefined) {
    this.#makeAgent = makeAgent
    this.#ready = ready
  }

  get agent(): A | undefined {
    return this.#agent
  }

  /** The open project as its agent keeps it (the scenes it saved and filmed). */
  get opened(): OpenedProject | null {
    return this.#opened
  }

  /** This opening's session; none when no project is open. */
  get session(): string | undefined {
    return this.#opened === null ? undefined : this.#session
  }

  /** Told as a project is opened, created or closed (what belonged to the last one ends). */
  onSwitch(listener: () => void): void {
    this.#onSwitch.push(listener)
  }

  /** The open project's apps and this opening's session, without building its whole view. */
  apps(): Pick<ProjectView, "session" | "apps"> | undefined {
    if (this.#opened === null) return undefined
    return {
      session: this.#session,
      apps: Object.entries(this.#opened.project.apps).map(([name, app]) => appView(name, app)),
    }
  }

  view(): ProjectView | null {
    return this.#opened === null ? null : projectView(this.#opened, this.#session)
  }

  /**
   * Opens the project in `dir` (its error says why it doesn't, and nothing changes then). The
   * folder already open stays as it is (read again while its agent may be writing to it, the new
   * copy could be older than the one in use).
   */
  open(dir: string): Promise<void> {
    return this.#switch(() => openProject(dir), dir)
  }

  /** Creates a project in `dir` (a fresh id) and opens it. */
  create(dir: string, init: { name: string; url: string }): Promise<void> {
    const id = `p-${randomBytes(8).toString("hex")}`
    return this.#switch(() => createProject(dir, { id, ...init }))
  }

  /**
   * Closes the project. `closed` runs once its agent is gone, within the switch (no open queued
   * behind can come between): never when the close is refused before anything changed.
   */
  close(closed?: () => void): Promise<void> {
    return this.#switch(() => null, undefined, closed)
  }

  #switch(next: () => OpenedProject | null, dir?: string, closed?: () => void): Promise<void> {
    const run = this.#switching.then(async () => {
      // Both made before anything changes: a project or agent that can't be made keeps the old.
      this.#ready()
      if (dir !== undefined && this.#opened !== null && sameFolder(dir, this.#opened.dir)) return
      const opened = next()
      const agent = opened === null ? undefined : this.#makeAgent(opened)
      const old = this.#agent
      this.#opened = opened
      this.#agent = agent
      this.#session = randomBytes(6).toString("hex")
      // A listener that fails never keeps the old agent from closing.
      for (const listener of this.#onSwitch) {
        try {
          listener()
        } catch {
          // said by the listener itself, if anywhere
        }
      }
      try {
        await old?.close()
      } finally {
        closed?.()
      }
    })
    // The chain goes on after a failure (the next switch isn't blocked by this one's error).
    this.#switching = run.catch(() => undefined)
    return run
  }
}

/** Whether two paths are the same folder (through symlinks; a path that's gone is just itself). */
function sameFolder(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  return real(a) === real(b)
}
