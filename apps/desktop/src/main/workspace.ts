// The open project and its agent, switched as one: the new project opened and its agent made first
// (a failure leaves the current one as it was), then the old agent closed. One switch at a time
// (two quick ones never leak an agent). Electron-free: main gives it how to make an agent.
import { randomBytes } from "node:crypto"
import { createProject, openProject, type OpenedProject } from "@kiframe/project"
import type { ProjectView } from "../shared/ipc.ts"
import { projectView } from "./project.ts"

/** What the workspace needs of an agent. */
export interface Agent {
  close(): Promise<void>
}

export class Workspace<A extends Agent> {
  readonly #makeAgent: (opened: OpenedProject) => A
  #opened: OpenedProject | null = null
  #agent: A | undefined
  #switching: Promise<unknown> = Promise.resolve()

  constructor(makeAgent: (opened: OpenedProject) => A) {
    this.#makeAgent = makeAgent
  }

  get agent(): A | undefined {
    return this.#agent
  }

  view(): ProjectView | null {
    return this.#opened === null ? null : projectView(this.#opened)
  }

  /** Opens the project in `dir` (its error says why it doesn't, and nothing changes then). */
  open(dir: string): Promise<void> {
    return this.#switch(() => openProject(dir))
  }

  /** Creates a project in `dir` (a fresh id) and opens it. */
  create(dir: string, init: { name: string; url: string }): Promise<void> {
    const id = `p-${randomBytes(8).toString("hex")}`
    return this.#switch(() => createProject(dir, { id, ...init }))
  }

  close(): Promise<void> {
    return this.#switch(() => null)
  }

  #switch(next: () => OpenedProject | null): Promise<void> {
    const run = this.#switching.then(async () => {
      // Both made before anything changes: a project or agent that can't be made keeps the old.
      const opened = next()
      const agent = opened === null ? undefined : this.#makeAgent(opened)
      const old = this.#agent
      this.#opened = opened
      this.#agent = agent
      await old?.close()
    })
    // The chain goes on after a failure (the next switch isn't blocked by this one's error).
    this.#switching = run.catch(() => undefined)
    return run
  }
}
