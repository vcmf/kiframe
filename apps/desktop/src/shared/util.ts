// Small rules main and the window share (one copy each).

/** An error in words: its message, or what it is. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The list with `item` in: a newer version (same id) replaces the one it has, else appended. */
export function upsert<T extends { id: string }>(items: readonly T[], item: T): T[] {
  const at = items.findIndex((i) => i.id === item.id)
  if (at === -1) return [...items, item]
  const next = [...items]
  next[at] = item
  return next
}

/** An app as the window names it: a web app by its host, a desktop app by its bundle id. */
export function appLabel(
  app: { kind: "web"; origin: string } | { kind: "electron"; bundleId: string },
): string {
  if (app.kind !== "web") return app.bundleId
  try {
    return new URL(app.origin).host
  } catch {
    return app.origin
  }
}
