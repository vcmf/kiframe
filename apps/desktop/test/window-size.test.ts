import { describe, expect, it } from "vitest"
import { initialSize } from "../src/main/window-size.ts"

describe("the window's first size", () => {
  it("fits the screen's work area (never under the Dock), 1440×900 where there's room", () => {
    // A 14" MacBook's work area (menu bar and Dock taken off): the window fits in it.
    expect(initialSize({ width: 1512, height: 862 })).toMatchObject({ width: 1440, height: 862 })
    expect(initialSize({ width: 2560, height: 1415 })).toMatchObject({ width: 1440, height: 900 })
    // The app's minimum where there's room; on a smaller work area, the work area (it fits).
    expect(initialSize({ width: 1512, height: 862 })).toMatchObject({
      minWidth: 1024,
      minHeight: 680,
    })
    expect(initialSize({ width: 1280, height: 640 })).toEqual({
      width: 1280,
      height: 640,
      minWidth: 1024,
      minHeight: 640,
    })
  })
})
