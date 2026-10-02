import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, type OpenedProject } from "@kiframe/project"
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
    // Another project, whose agent can't be made now.
    const other = folder()
    createProject(other, { id: "p-other", name: "B", url: "https://b.test" })
    fail = true
    await expect(ws.open(other)).rejects.toThrow(/registry/)
    expect(ws.view()?.name).toBe("A")
    expect(ws.agent).toBe(made[0])
    expect(made[0]?.closed).toBe(false)
  })

  it("writes no project when an agent can't be made now (the registry doesn't read)", async () => {
    const { make } = agents()
    let ready = false
    const ws = new Workspace(make, () => {
      if (!ready) throw new Error("couldn't read the project registry")
    })
    const dir = folder()
    await expect(ws.create(dir, { name: "A", url: "https://a.test" })).rejects.toThrow(/registry/)
    expect(existsSync(dir)).toBe(false)
    ready = true
    await ws.create(dir, { name: "A", url: "https://a.test" })
    expect(ws.view()?.name).toBe("A")
  })

  it("gives each opening its own session; the folder already open stays as it is", async () => {
    const { made, make } = agents()
    const ws = new Workspace(make)
    const a = folder()
    await ws.create(a, { name: "A", url: "https://a.test" })
    const first = ws.view()?.session
    await ws.open(a)
    expect(ws.view()?.session).toBe(first)
    expect(made).toHaveLength(1)
    expect(made[0]?.closed).toBe(false)
    await ws.create(folder(), { name: "B", url: "https://b.test" })
    expect(ws.view()?.session).not.toBe(first)
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
