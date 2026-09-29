import type { Page } from "playwright"
import { describe, expect, it } from "vitest"
import type { Ctx, RunnerEvent } from "../src/run/context.ts"
import { followSecretFields, leaveSecretFields } from "../src/run/secrets.ts"

// The field state (SECRETS-DESIGN T2–T4) through unsure reads: a page with a stuck read makes every
// read of it unsure without touching it.
function setup() {
  const p1 = {} as Page
  const p2 = {} as Page
  const events: RunnerEvent[] = []
  const field: Ctx["secretFields"][number] = {
    id: "f",
    locator: {} as Ctx["secretFields"][number]["locator"],
    page: p1,
    typed: true,
    onScreen: true,
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
    ctx.page = p2
    leaveSecretFields(ctx, step)
    expect(fieldEvents().at(-1)).toMatchObject({ atSwitch: true })
    ctx.page = p1
    ctx.pageShownAt = 5000
    await followSecretFields(ctx, step)
    expect(fieldEvents().at(-1)).toMatchObject({ box: field.lastBox, at: 5000, since: 5000 })
    // Left again before any real read: the reopened region is left too (never stuck open).
    ctx.page = p2
    leaveSecretFields(ctx, step)
    expect(fieldEvents().at(-1)).toMatchObject({ atSwitch: true })
    expect(fieldEvents()).toHaveLength(3)
  })

  it("doesn't reopen a field that was gone before the run left its page", async () => {
    const { ctx, field, p1, p2, step, fieldEvents } = setup()
    field.onScreen = false
    ctx.page = p2
    leaveSecretFields(ctx, step)
    ctx.page = p1
    await followSecretFields(ctx, step)
    expect(fieldEvents()).toEqual([])
  })

  it("reopens the whole frame when the field never had a usable box", async () => {
    const { ctx, field, p1, p2, step, fieldEvents } = setup()
    field.lastBox = { x: 0, y: 0, width: 0, height: 30 }
    ctx.page = p2
    leaveSecretFields(ctx, step)
    ctx.page = p1
    await followSecretFields(ctx, step)
    expect(fieldEvents().at(-1)?.box).toMatchObject({ x: 0, y: 0, width: 1e6, height: 1e6 })
  })
})
