// An app's address, resolved once when it's added (OBJECT-MODEL §0.9): a site that redirects its
// address to its www. or https form (minmux.dev → www.minmux.dev) is stored where it lands, so a
// secret is added for the origin its login is really on. Any other redirect (a login host, an SSO
// provider, another site) is never adopted: the address stays as typed.
import { sameApp } from "@kiframe/schema"

/** Redirects followed at most (each one checked, never the fetcher's own limit). */
const MAX_HOPS = 5

/**
 * The address to store for `typed`: where its site's root lands, when `typed` is that root (a bare
 * address: a typed path was never checked on another origin, and the app may live there on this
 * one) and it lands on the same app; else `typed` as it is (an error, a timeout or offline
 * included: never fails). With Node's fetch (no browser session or cookies), the body never read.
 */
export async function resolveAppAddress(
  typed: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const asked = new URL(typed)
  if (asked.pathname !== "/" || asked.search !== "" || asked.hash !== "") return typed
  const get = options.fetch ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
  let at = asked
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const response = await get(at, { redirect: "manual", credentials: "omit", signal })
      await response.body?.cancel().catch(() => undefined)
      const location = response.headers.get("location")
      if (response.status < 300 || response.status >= 400 || location === null) {
        // Landed: adopted only where the same app answers (never an error page), at its root.
        const ok = response.status >= 200 && response.status < 300
        return ok && at.origin !== asked.origin && sameApp(at, asked) ? `${at.origin}/` : typed
      }
      const next = new URL(location, at)
      if (next.protocol !== "https:" && next.protocol !== "http:") return typed
      at = next
    }
  } catch {
    // unreachable, slow or refused: as typed
  }
  return typed
}
