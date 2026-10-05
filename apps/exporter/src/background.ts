import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { Background } from "@kiframe/schema"

/** The file of a shipped background image (none: no file); an id not shipped is an error. */
export function backgroundFile(background: Background): string | undefined {
  if (background === "none") return undefined
  const list = createRequire(import.meta.url).resolve(
    "@kiframe/compositor/backgrounds/backgrounds.json",
  )
  const shipped = JSON.parse(readFileSync(list, "utf8")) as {
    backgrounds: { id: string; file: string }[]
  }
  const known = shipped.backgrounds.find((b) => b.id === background.builtin)
  if (known === undefined) throw new Error(`no background "${background.builtin}" is shipped`)
  return join(dirname(list), known.file)
}
