import { describe, expect, it } from "vitest"
import { findInSnapshot } from "../src/snapshot-find.ts"

const find = (snap: string, query: string) => findInSnapshot(snap, query).text

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
    expect(find(SNAP, "2026 world cup")).toBe(`…
- main:
  …
  - paragraph:
    …
    - link "2026 World Cup" [ref=e3]:
      - /url: /wiki/2026_FIFA_World_Cup
…`)
  })

  it("merges matches that share ancestors, and finds nothing when nothing matches", () => {
    expect(find(SNAP, "world cup")).toBe(`…
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
    expect(find(SNAP, "Messi")).toBe("")
  })

  it("matches a line's words, never its refs or states; a quoted name as shown", () => {
    expect(find(SNAP, "e3")).toBe("")
    expect(find(SNAP, "level")).toBe("")
    expect(find('- heading "The \\"Flea\\"" [ref=e1]', '"flea"')).toBe(
      '- heading "The \\"Flea\\"" [ref=e1]',
    )
    // A URL is the link's words too.
    expect(find(SNAP, "2026_FIFA")).toContain('link "2026 World Cup" [ref=e3]')
  })

  // A ratio of times, never a budget: room for a CI machine busy with the Electron tests.
  it("stays linear on a huge snapshot with a common word", () => {
    // Time per size, not a wall-clock budget (CI and coverage are several times slower): four times
    // the snapshot takes about four times as long; a quadratic search takes about sixteen times.
    // The median of five runs, against noise.
    const timed = (n: number) => {
      const rows = Array.from({ length: n }, (_, i) => `  - paragraph: the row ${i}`)
      const snap = ["- main:", ...rows].join("\n")
      expect(find(snap, "the").split("\n")).toHaveLength(n + 1)
      const runs = [0, 1, 2, 3, 4].map(() => {
        const started = performance.now()
        find(snap, "the")
        return performance.now() - started
      })
      return runs.sort((a, b) => a - b)[2]!
    }
    timed(10_000) // warm up
    const ratio = timed(100_000) / timed(25_000)
    expect(ratio).toBeLessThan(8)
  }, 30_000)

  it("reads a sentence over a link, as written by a reader (dashes, quotes, case)", () => {
    // "He played in the 2026 World Cup and won." spans the paragraph's three children.
    const found = findInSnapshot(SNAP, "played in the 2026 World Cup and WON")
    expect(found.near).toBe(false)
    expect(found.text).toBe(`…
- main:
  …
  - paragraph:
    - text: He played in the
    - link "2026 World Cup" [ref=e3]:
      - /url: /wiki/2026_FIFA_World_Cup
    - text: and won.
…`)
    expect(
      find("- paragraph: Messi\u2019s 2010\u20132013 seasons [ref=e9]", "messi's 2010-2013"),
    ).toContain("[ref=e9]")
    // And the other way: the agent's curly quote and en dash for the page's plain ones.
    expect(
      find("- paragraph: Messi's 2010-2013 seasons [ref=e9]", "Messi\u2019s 2010\u20132013"),
    ).toContain("[ref=e9]")
  })

  it("reads a sentence over a link whose name holds quotes", () => {
    const snap = `- paragraph [ref=e1]:
  - text: Fans call him
  - link "the \\"Flea\\"" [ref=e2]
  - text: since his youth.`
    const found = findInSnapshot(snap, 'call him the "flea" since')
    expect(found.near).toBe(false)
    expect(found.text).toContain("- paragraph [ref=e1]:")
  })

  it('reads a single-quoted key (a name holding ": ") as its words', () => {
    const snap = `- paragraph [ref=e1]:
  - text: Run
  - 'link "Step 1: install" [ref=e2]':
    - /url: /docs
  - text: now.`
    expect(findInSnapshot(snap, "run step 1: install now").text).toContain("- paragraph [ref=e1]:")
  })

  it("reads punctuation right after a link as the page shows it", () => {
    const snap = `- paragraph [ref=e1]:
  - text: he registered eight goals and
  - link "four assists" [ref=e2]
  - text: ", becoming the tournament's top scorer."`
    const found = findInSnapshot(snap, "four assists, becoming the tournament's")
    expect(found.near).toBe(false)
    expect(found.text).toContain("- paragraph [ref=e1]:")
  })

  it("reads a possessive or a hyphen right after a link as the page shows it", () => {
    const snap = `- paragraph [ref=e1]:
  - link "Nadal" [ref=e2]
  - text: "'s career began with"
  - link "COVID" [ref=e3]
  - text: "-19 rules."`
    for (const q of ["Nadal's career", "COVID-19 rules"]) {
      const found = findInSnapshot(snap, q)
      expect(found.near, q).toBe(false)
      expect(found.text, q).toContain("- paragraph [ref=e1]:")
    }
  })

  it("falls back to the blocks that hold every word, said as near", () => {
    const found = findInSnapshot(SNAP, "won World Cup 2026")
    expect(found.near).toBe(true)
    expect(found.text).toContain("  - paragraph:")
    expect(findInSnapshot(SNAP, "won Messi").text).toBe("")
  })
})
