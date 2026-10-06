import { describe, expect, it } from "vitest"
import {
  joinPieces,
  normalizeText,
  occurrences,
  passages,
  showsKnownValue,
  unitAt,
} from "../src/text-match.ts"

describe("text as a reader sees it", () => {
  it("ignores case, dashes, quotes, kinds of spaces and invisible marks", () => {
    expect(normalizeText("2010\u20132013")).toBe("2010-2013")
    expect(normalizeText("The \u201CFlea\u201D\u2019s   goals\u00A0")).toBe('the "flea"\'s goals')
    expect(normalizeText("  Eight\n goals ")).toBe("eight goals")
    // Direction marks (Wikipedia), a soft hyphen, a variation selector, ʼ and ´ as apostrophes.
    expect(normalizeText("Ra\u200Ffael Na\u00ADdal \u2764\uFE0F")).toBe("rafael nadal \u2764")
    expect(normalizeText("don\u02BCt don\u00B4t")).toBe("don't don't")
    expect(normalizeText("Stra\u00DFe")).toBe("strasse")
  })

  it("folds plain ASCII the same way with or without its fast path", () => {
    const ascii = "  The 'Flea' scored\t2010-2013,\n  then LEFT  "
    expect(normalizeText(ascii)).toBe(joinPieces([ascii]).text)
  })

  it("reads an accent typed as two characters as one", () => {
    expect(normalizeText("cafe\u0301")).toBe(normalizeText("caf\u00E9"))
    const { from } = joinPieces(["cafe\u0301 bar"])
    // The é is one character of its piece: offset 3, two units long.
    expect(from[3]).toEqual({ piece: 0, offset: 3, length: 2 })
  })

  it("joins a page's text nodes as they render, each unit traced to its node", () => {
    // "eight goals and <a>four assists</a>, becoming": a link in the middle of the sentence.
    const { text, from } = joinPieces([
      "He registered eight goals and ",
      "four\u00A0assists",
      ", becoming",
    ])
    expect(text).toBe("he registered eight goals and four assists, becoming")
    const at = text.indexOf("goals and four")
    expect(from[at]).toMatchObject({ piece: 0, offset: 20 })
    expect(from[at + "goals and four".length - 1]).toMatchObject({ piece: 1, offset: 3 })
    // Whitespace runs across nodes: one space.
    expect(joinPieces(["a  ", "  b"]).text).toBe("a b")
  })

  it("keeps each unit traced past an emoji, and breaks lines where the page does", () => {
    const { text, from } = joinPieces(["\u{1F389} Ship it today"])
    const at = text.indexOf("ship it")
    expect(from[at]).toMatchObject({ piece: 0, offset: 3 })
    expect(from[at + "ship it".length - 1]).toMatchObject({ piece: 0, offset: 9 })
    // "line one<br>line two": two text nodes, no whitespace between, a line break.
    expect(joinPieces(["line one", "line two"], [false, true]).text).toBe("line one line two")
    expect(joinPieces(["line one", "line two"]).text).toBe("line oneline two")
  })

  it("places a caret in matched text, whatever DOM position says it", () => {
    // "\n    Eight goals": a server-rendered node starting with whitespace.
    const joined = joinPieces(["\n    Eight goals", " and four"])
    // Before "E" (offset 5), or anywhere in the leading whitespace: unit 0.
    expect(unitAt(joined, 0, 5)).toBe(0)
    expect(unitAt(joined, 0, 2)).toBe(0)
    // The end of node 0 and the start of node 1: the same place (the space between).
    expect(unitAt(joined, 0, 16)).toBe(unitAt(joined, 1, 0))
    expect(unitAt(joined, 1, 9)).toBe(joined.text.length)
    // After a line break: a caret before the next line's first character is on that character.
    const lines = joinPieces(["line one", "line two"], [false, true])
    expect(unitAt(lines, 1, 0)).toBe(lines.text.indexOf("line two"))
  })

  it("finds a passage with spaces aside when it's nowhere as written", () => {
    // The page reads "Nadal's career" (a link then "'s"); a snapshot line reads "Nadal 's".
    const page = joinPieces(["Nadal", "'s career began"])
    expect(passages(page, normalizeText("nadal 's career"))).toEqual([{ begin: 0, end: 14 }])
    // As written first: never the spaceless reading when the phrase is there.
    const both = joinPieces(["the rapist and therapist"])
    expect(passages(both, "therapist")).toEqual([{ begin: 15, end: 24 }])
  })

  it("finds passages of whole characters, never touching a known value", () => {
    expect(occurrences("the goal, the goal", "the goal")).toEqual([0, 10])
    // "inal" inside "ﬁnal" (the ligature folds to "fi"): not a passage.
    const lig = joinPieces(["the \uFB01nal"])
    expect(lig.text).toBe("the final")
    expect(passages(lig, "inal")).toEqual([])
    expect(passages(lig, "final")).toEqual([{ begin: 4, end: 9 }])
    // A page showing a known value: no passage touches it (a part of it is never told from a miss).
    const shown = joinPieces(["Signed in as hunter2-secret today"])
    expect(passages(shown, "hunter2", ["hunter2-secret"])).toEqual([])
    expect(passages(shown, "as hunter2-secret", ["hunter2-secret"])).toEqual([])
    expect(passages(shown, "signed in", ["hunter2-secret"])).toEqual([{ begin: 0, end: 9 }])
    // As the scanner matches: a short value as a whole word ("_" isn't a letter), spaces inside
    // a value tolerated.
    expect(passages(joinPieces(["bob and bobby"]), "bobby", ["bob"])).toEqual([
      { begin: 8, end: 13 },
    ])
    expect(passages(joinPieces(["bob and bobby"]), "bob and", ["bob"])).toEqual([])
    expect(passages(joinPieces(["id x_abc12 here"]), "abc12", ["abc12"])).toEqual([])
    expect(passages(joinPieces(["code mypass now"]), "mypass", ["my pass"])).toEqual([])
    expect(showsKnownValue(joinPieces(["Signed in as hunter2-secret"]), ["hunter2-secret"])).toBe(
      true,
    )
  })
})
