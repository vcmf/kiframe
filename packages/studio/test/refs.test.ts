import { describe, expect, it } from "vitest"
import { refsOf } from "../src/refs.ts"

describe("the refs of a snapshot", () => {
  it("reads each node's role and name, quoted keys too (a name with ': ' or ' #')", () => {
    // As Playwright 1.63 writes them (mode "ai").
    const refs = refsOf(`- generic [active] [ref=e1]:
  - 'button "Status: Active" [ref=e2]'
  - 'link "Issue #42" [ref=e3] [cursor=pointer]':
    - /url: "#x"
  - 'button "It''s: here" [ref=e4]'
  - heading "Say \\"hi\\"" [level=1] [ref=e5]
  - paragraph [ref=e6]: see [ref=e2]
  - text: and [ref=e5]`)
    expect(Object.fromEntries(refs)).toEqual({
      e1: { role: "generic" },
      e2: { role: "button", name: "Status: Active" },
      e3: { role: "link", name: "Issue #42" },
      e4: { role: "button", name: "It's: here" },
      e5: { role: "heading", name: 'Say "hi"' },
      // A node's own text is kept (to check the element by), never read as a ref.
      e6: { role: "paragraph", text: "see [ref=e2]" },
    })
  })

  it("reads nothing from text that isn't a snapshot", () => {
    expect(refsOf("not: [valid").size).toBe(0)
  })
})
