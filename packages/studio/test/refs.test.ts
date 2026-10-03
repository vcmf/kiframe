import { describe, expect, it } from "vitest"
import { refsOf, sameNode, type SnapshotNode } from "../src/refs.ts"

const read = (snapshot: string) =>
  Object.fromEntries(refsOf(snapshot) ?? new Map<string, SnapshotNode>())

describe("the refs of a snapshot", () => {
  it("reads each node's role, name and own text, quoted and unquoted keys too", () => {
    // As Playwright 1.63 writes them (mode "ai").
    expect(
      read(`- generic [active] [ref=e1]:
  - 'button "Status: Active" [ref=e2]'
  - 'link "Issue #42" [ref=e3] [cursor=pointer]':
    - /url: "#x"
  - 'button "It''s: here" [ref=e4]'
  - heading "Say \\"hi\\"" [level=1] [ref=e5]
  - paragraph [ref=e6]: see [ref=e2]
  - text: and [ref=e5]
  - link /x/ [ref=e7] [cursor=pointer]:
    - /url: /x/
  - listitem [ref=e8]:
    - checkbox [ref=e9]
    - text: Buy milk
  - textbox "Email" [ref=e10]: a@b.c`),
    ).toEqual({
      // Its own text: its `text:` children (page text, never a ref).
      e1: { role: "generic", text: "and [ref=e5]", inFrame: false },
      e2: { role: "button", name: "Status: Active", inFrame: false },
      e3: { role: "link", name: "Issue #42", inFrame: false },
      e4: { role: "button", name: "It's: here", inFrame: false },
      e5: { role: "heading", name: 'Say "hi"', inFrame: false },
      // A node's own text is kept (to check the element by), never read as a ref.
      e6: { role: "paragraph", text: "see [ref=e2]", inFrame: false },
      // A name starting and ending with "/" is written unquoted.
      e7: { role: "link", name: "/x/", inFrame: false },
      // Its own text: its `text:` children, never its elements'.
      e8: { role: "listitem", text: "Buy milk", inFrame: false },
      e9: { role: "checkbox", inFrame: false },
      e10: { role: "textbox", name: "Email", text: "a@b.c", inFrame: false },
    })
  })

  it("marks an iframe's elements by their place (under the iframe node), whatever their ref says", () => {
    expect(
      read(`- generic [ref=f1e1]:
  - button "Out" [ref=f1e2]
  - iframe [ref=f1e3]:
    - button "In" [ref=f2e2]`),
    ).toEqual({
      f1e1: { role: "generic", inFrame: false },
      f1e2: { role: "button", name: "Out", inFrame: false },
      f1e3: { role: "iframe", inFrame: false },
      f2e2: { role: "button", name: "In", inFrame: true },
    })
  })

  it("keeps a node's text as written (never YAML's null or Infinity)", () => {
    expect(read("- listitem [ref=e1]: ~\n- generic [ref=e2]: .inf")).toEqual({
      e1: { role: "listitem", text: "~", inFrame: false },
      e2: { role: "generic", text: ".inf", inFrame: false },
    })
  })

  it("reads nothing from text that isn't a snapshot", () => {
    expect(refsOf("not: [valid")).toBeUndefined()
  })
})

describe("the same element, in a fresh snapshot of the same document", () => {
  it("is a named node with its role and name; its text (a value) may change", () => {
    expect(sameNode({ role: "button", name: "Save" }, { role: "button", name: "Save" })).toBe(true)
    expect(sameNode({ role: "button", name: "Save" }, { role: "button", name: "Delete" })).toBe(
      false,
    )
    expect(
      sameNode(
        { role: "textbox", name: "Email", text: "a" },
        { role: "textbox", name: "Email", text: "b" },
      ),
    ).toBe(true)
  })

  it("is a nameless node with its text, a field's value aside", () => {
    expect(
      sameNode({ role: "listitem", text: "Buy milk" }, { role: "listitem", text: "Buy eggs" }),
    ).toBe(false)
    expect(
      sameNode({ role: "listitem", text: "Item 1" }, { role: "listitem", text: "Item 12" }),
    ).toBe(false)
    expect(
      sameNode({ role: "listitem", text: "Buy  milk" }, { role: "listitem", text: "Buy milk" }),
    ).toBe(true)
    // Text on one side only: changed.
    expect(sameNode({ role: "listitem" }, { role: "listitem", text: "Buy milk" })).toBe(false)
    // A nameless field: what's typed changes, it's the same field.
    expect(sameNode({ role: "textbox", text: "" }, { role: "textbox", text: "typed" })).toBe(true)
  })
})
