import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpenedProject } from "@kiframe/project"
import { describe, expect, it } from "vitest"
import { Workspace } from "../src/main/workspace.ts"

const folder = () => join(mkdtempSync(join(tmpdir(), "kiframe-ws-")), "demo.kiframe")

/** An agent that records its life, and closes when told (or at once). */
function agents(slowClose = false) {
  const made: { project: OpenedProject; closed: boolean; release: (() => void) | undefined }[] = []
  const make = (project: OpenedProject) => {
    const agent = {
      project,
      closed: false,
      release: undefined as (() => void) | undefined,
      close: () =>
        new Promise<void>((resolve) => {
          const done = () => {
            agent.closed = true
            resolve()
          }
          if (slowClose) agent.release = done
          else done()
        }),
    }
    made.push(agent)
    return agent
  }
  return { made, make }
}

describe("the open project and its agent", () => {
  it("opens one project at a time, each with its own agent and a fresh id; the old one closes", async () => {
    const { made, make } = agents()
    const ws = new Workspace(make)
    await ws.create(folder(), { name: "A", url: "https://a.test" })
    await ws.create(folder(), { name: "B", url: "https://b.test" })
    expect(ws.view()?.name).toBe("B")
    expect(made.map((a) => a.closed)).toEqual([true, false])
    expect(made[0]?.project.project.id).not.toBe(made[1]?.project.project.id)
    expect(ws.agent).toBe(made[1])
    await ws.close()
    expect(ws.view()).toBeNull()
    expect(ws.agent).toBeUndefined()
    expect(made[1]?.closed).toBe(true)
  })

  it("keeps the open project and its agent when another doesn't open, or its agent can't be made", async () => {
    let fail = false
    const { made, make } = agents()
    const ws = new Workspace((p: OpenedProject) => {
      if (fail) throw new Error("couldn't read the project registry")
      return make(p)
    })
    const dir = folder()
    await ws.create(dir, { name: "A", url: "https://a.test" })
    await expect(ws.open(mkdtempSync(join(tmpdir(), "kiframe-not-")))).rejects.toThrow(
      /isn't a Kiframe project/,
    )
    await expect(ws.create(dir, { name: "A", url: "https://a.test" })).rejects.toThrow(
      /already holds a project/,
    )
    fail = true
    await expect(ws.open(dir)).rejects.toThrow(/registry/)
    expect(ws.view()?.name).toBe("A")
    expect(ws.agent).toBe(made[0])
    expect(made[0]?.closed).toBe(false)
  })

  it("switches one at a time: two quick switches never leave an agent open", async () => {
    const { made, make } = agents(true)
    const ws = new Workspace(make)
    await ws.create(folder(), { name: "A", url: "https://a.test" }).catch(() => undefined)
    const toB = ws.create(folder(), { name: "B", url: "https://b.test" })
    const toC = ws.create(folder(), { name: "C", url: "https://c.test" })
    // A closes slowly: C's switch waits for B's.
    await new Promise((r) => setTimeout(r, 20))
    expect(made.map((a) => a.project.project.name)).toEqual(["A", "B"])
    made[0]?.release?.()
    await toB
    await new Promise((r) => setTimeout(r, 20))
    made[1]?.release?.()
    await toC
    expect(made.map((a) => a.closed)).toEqual([true, true, false])
    expect(ws.agent).toBe(made[2])
  })
})
