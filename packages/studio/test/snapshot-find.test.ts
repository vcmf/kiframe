import { describe, expect, it } from "vitest"
import { findInSnapshot } from "../src/snapshot-find.ts"

const SNAP = `- banner:
  - link "Home" [ref=e1]
- main:
  - heading "Career" [level=2] [ref=e2]
  - paragraph:
    - text: He played in the
    - link "2026 World Cup" [ref=e3]:
      - /url: /wiki/2026_FIFA_World_Cup
    - text: and won.
  - heading "Honours" [level=2] [ref=e4]
  - list:
    - listitem: World Cup winner 2022
- contentinfo:
  - link "Privacy" [ref=e5]`

describe("finding in a snapshot", () => {
  it("gives each match with its ancestors and its subtree's start, in page order", () => {
    expect(findInSnapshot(SNAP, "2026 world cup")).toBe(`…
- main:
  …
  - paragraph:
    …
    - link "2026 World Cup" [ref=e3]:
      - /url: /wiki/2026_FIFA_World_Cup
…`)
  })

  it("merges matches that share ancestors, and finds nothing when nothing matches", () => {
    expect(findInSnapshot(SNAP, "world cup")).toBe(`…
- main:
  …
  - paragraph:
    …
    - link "2026 World Cup" [ref=e3]:
      - /url: /wiki/2026_FIFA_World_Cup
  …
  - list:
    - listitem: World Cup winner 2022
…`)
    expect(findInSnapshot(SNAP, "Messi")).toBe("")
  })

  it("matches a line's words, never its refs or states; a quoted name as shown", () => {
    expect(findInSnapshot(SNAP, "e3")).toBe("")
    expect(findInSnapshot(SNAP, "level")).toBe("")
    expect(findInSnapshot('- heading "The \\"Flea\\"" [ref=e1]', '"flea"')).toBe(
      '- heading "The \\"Flea\\"" [ref=e1]',
    )
    // A URL is the link's words too.
    expect(findInSnapshot(SNAP, "2026_FIFA")).toContain('link "2026 World Cup" [ref=e3]')
  })

  it("stays linear on a huge snapshot with a common word", () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => `  - paragraph: the row ${i}`)
    const started = performance.now()
    expect(findInSnapshot(["- main:", ...rows].join("\n"), "the").split("\n")).toHaveLength(100_001)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
