import { WebApp } from "@kiframe/schema"
import type { AppCard } from "./studio.ts"

// `add_app`'s card (OBJECT-MODEL §0.9): what the user approves, built from the very address that
// would be written. The agent's reason is its words, possibly steered by a page it read: plain text
// on one line, never anything that could pass for Kiframe's own interface.

/** The agent's reason, as the card shows it: no control or invisible characters, one line, short. */
export function cleanWhy(why: string): string {
  return why
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

/** Whether a host is this computer or its local network (a dev server, a router, a NAS: said). */
export function isLocal(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  // A single label (http://router/, http://nas:5000/) or a local-only name.
  if (!h.includes(".") && !h.includes(":")) return true
  if (/(^|\.)(localhost|local|lan|internal|home\.arpa)$/.test(h)) return true
  if (h.includes(":")) {
    // IPv6: loopback, unique local, link-local, or an IPv4 address in it.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
    if (mapped !== null) {
      const [hi, lo] = [parseInt(mapped[1] ?? "0", 16), parseInt(mapped[2] ?? "0", 16)]
      return isLocal(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || h.startsWith("fe80:")
  }
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h)
  if (v4 === null) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  )
}

/** The card for `url` (already resolved and checked by the `App` rule), or why it can't be one. */
export function appCard(
  name: string,
  url: string,
  why: string,
): Omit<AppCard, "secrets" | "usedBy"> | { error: string } {
  const checked = WebApp.shape.url.safeParse(url)
  if (!checked.success)
    return { error: `url: ${checked.error.issues[0]?.message ?? "not an address"}` }
  const at = new URL(checked.data)
  return {
    name,
    url: checked.data,
    host: at.host,
    plain: at.protocol === "http:",
    lookalike: at.hostname.split(".").some((label) => label.startsWith("xn--")),
    local: isLocal(at.hostname),
    why: cleanWhy(why),
  }
}
