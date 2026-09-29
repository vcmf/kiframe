import type { Page } from "playwright"
import { describe, expect, it } from "vitest"
import type { Ctx, RunnerEvent } from "../src/run/context.ts"
import { followSecretFields, leaveSecretFields } from "../src/run/secrets.ts"

// The field state (SECRETS-DESIGN T2–T4) through unsure reads: a page with a stuck read makes every
// read of it unsure without touching it.
function setup() {
  const p1 = { isClosed: () => false } as unknown as Page
  const p2 = { isClosed: () => false } as unknown as Page
  const events: RunnerEvent[] = []
  const field: Ctx["secretFields"][number] = {
    id: "f",
    locator: {} as Ctx["secretFields"][number]["locator"],
    page: p1,
    state: "on",
    lastBox: { x: 10, y: 20, width: 100, height: 30 },
  }
  const ctx = {
    page: p1,
    pageShownAt: 1000,
    secretFields: [field],
    fieldsInflight: undefined,
    stuckReads: new WeakMap<Page, number>([
      [p1, 1],
      [p2, 1],
    ]),
    options: { onEvent: (e: RunnerEvent) => events.push(e) },
  } as unknown as Ctx
  const step = { phase: "steps", index: 0, stepId: "s" } as Parameters<typeof leaveSecretFields>[1]
  const fieldEvents = () =>
    events.filter(
      (e): e is Extract<RunnerEvent, { kind: "secret_field" }> => e.kind === "secret_field",
    )
  return { ctx, field, p1, p2, step, fieldEvents }
}

describe("secret field state through page switches and unsure reads", () => {
  it("reopens its last box on an unsure return, dated from the switch, and leaves it again", async () => {
    const { ctx, field, p1, p2, step, fieldEvents } = setup()
    field.lastViewport = { width: 800, height: 600 }
    ctx.page = p2
    leaveSecretFields(ctx, step)
    expect(fieldEvents().at(-1)).toMatchObject({ state: "left" })
    ctx.page = p1
    ctx.pageShownAt = 5000
    await followSecretFields(ctx, step)
    expect(fieldEvents().at(-1)).toMatchObject({
      state: "at",
      box: field.lastBox,
      viewport: { width: 800, height: 600 },
      at: 5000,
      since: 5000,
    })
    // Left again before any real read: the reopened region is left too (never stuck open).
    ctx.page = p2
    leaveSecretFields(ctx, step)
    expect(fieldEvents().at(-1)).toMatchObject({ state: "left" })
    expect(fieldEvents()).toHaveLength(3)
  })

  it("leaves the field of a popup that closed itself, then drops it", () => {
    const { ctx, field, p1, step, fieldEvents } = setup()
    const popup = { isClosed: () => true } as unknown as Page
    field.page = popup
    ctx.page = p1
    leaveSecretFields(ctx, step)
    expect(fieldEvents()).toEqual([expect.objectContaining({ id: "f", state: "left" })])
    expect(ctx.secretFields).toEqual([])
  })

  it("doesn't reopen a field that was gone before the run left its page", async () => {
    const { ctx, field, p1, p2, step, fieldEvents } = setup()
    field.state = "gone"
    ctx.page = p2
    leaveSecretFields(ctx, step)
    ctx.page = p1
    await followSecretFields(ctx, step)
    expect(fieldEvents()).toEqual([])
  })

  it("reopens the whole frame when the field never had a usable box", async () => {
    const { ctx, field, p1, p2, step, fieldEvents } = setup()
    delete field.lastBox
    ctx.page = p2
    leaveSecretFields(ctx, step)
    ctx.page = p1
    await followSecretFields(ctx, step)
    expect(fieldEvents().at(-1)).toMatchObject({
      state: "at",
      box: { x: 0, y: 0, width: 1, height: 1 },
      viewport: { width: 1, height: 1 },
    })
  })
})

describe("secret field state through real reads", () => {
  // A page that reads and draws at once, and a field found by its locator (no handle).
  function live() {
    const page = {
      isClosed: () => false,
      viewportSize: () => ({ width: 800, height: 600 }),
      evaluate: () => Promise.resolve(true),
    } as unknown as Page
    let box: { x: number; y: number; width: number; height: number } | null = {
      x: 10,
      y: 20,
      width: 100,
      height: 30,
    }
    let matches = 1
    const locator = {
      count: () => Promise.resolve(box === null ? 0 : matches),
      boundingBox: () => Promise.resolve(box),
    }
    const events: RunnerEvent[] = []
    const field = {
      id: "f",
      locator,
      page,
      state: "on",
    } as unknown as Ctx["secretFields"][number]
    const ctx = {
      page,
      pageShownAt: 0,
      secretFields: [field],
      fieldsInflight: undefined,
      stuckReads: new WeakMap<Page, number>(),
      options: { onEvent: (e: RunnerEvent) => events.push(e) },
    } as unknown as Ctx
    const step = { phase: "steps", index: 0, stepId: "s" } as Parameters<
      typeof leaveSecretFields
    >[1]
    const reports = () =>
      events.filter(
        (e): e is Extract<RunnerEvent, { kind: "secret_field" }> => e.kind === "secret_field",
      )
    const set = (b: typeof box) => {
      box = b
    }
    const twice = () => {
      matches = 2
    }
    return { ctx, step, reports, set, twice }
  }

  it("reports gone once, reads it again, and dates a return from the last read that found it gone", async () => {
    const { ctx, step, reports, set } = live()
    await followSecretFields(ctx, step)
    expect(reports().at(-1)).toMatchObject({ state: "at", box: { width: 100 } })
    set(null)
    await followSecretFields(ctx, step)
    await followSecretFields(ctx, step)
    const gone = reports().filter((e) => e.state === "gone")
    expect(gone).toHaveLength(1)
    // The read that found it gone for the second time started after the reported one.
    set({ x: 10, y: 300, width: 100, height: 30 })
    await followSecretFields(ctx, step)
    const back = reports().at(-1)
    expect(back).toMatchObject({ state: "at", box: { y: 300 } })
    expect(back?.state === "at" && back.since).toBeGreaterThanOrEqual(gone[0]?.at ?? Infinity)
  })

  it("reads the page the capture just left, with its own shown time (the last read)", async () => {
    const { ctx, step, reports } = live()
    const left = ctx.page
    // The run already drives the next page (the switch), shown since 9000.
    ctx.page = { isClosed: () => false } as unknown as Page
    ctx.pageShownAt = 9000
    await followSecretFields(ctx, step, { page: left, shown: 100 })
    expect(reports().at(-1)).toMatchObject({ state: "at", shown: 100, box: { width: 100 } })
  })

  it("treats a target matching two elements as gone (never a stuck 'unknown')", async () => {
    const { ctx, step, reports, twice } = live()
    await followSecretFields(ctx, step)
    twice()
    await followSecretFields(ctx, step)
    expect(reports().at(-1)?.state).toBe("gone")
  })

  it("treats a box of no size as gone", async () => {
    const { ctx, step, reports, set } = live()
    set({ x: 10, y: 20, width: 0, height: 30 })
    await followSecretFields(ctx, step)
    expect(reports().at(-1)?.state).toBe("gone")
  })
})
