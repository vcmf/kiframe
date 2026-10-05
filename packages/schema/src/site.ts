// When a page is on the target app, for navigation and what the agent is told: its own origin, or
// the same host with or without a leading `www.` (either way) over the same protocol or an upgrade
// from http to https. A site redirecting its address there (minmux.dev → www.minmux.dev) is the
// same app for its steps and URL checks: decided by the user, 2026-10-04. Any other host (a
// subdomain such as app. or login., an SSO provider, another site) is not.
//
// Never for secrets: a secret is typed only on the exact origin it was added for, and its approval
// names that host (an alias would have the user approve one host and the value go to another).

/** Whether `url` is on the app at `app` (both URLs or origins). */
export function sameApp(url: string | URL, app: string | URL): boolean {
  let page: URL
  let target: URL
  try {
    page = new URL(url)
    target = new URL(app)
  } catch {
    return false
  }
  if (page.origin === "null" || target.origin === "null") return false
  if (page.origin === target.origin) return true
  // Compared by their origins (a blob: URL's is its creator's: blob:https://www.x/… is on www.x).
  const p = new URL(page.origin)
  const t = new URL(target.origin)
  const host = (u: URL) => u.host.replace(/^www\./, "")
  const protocolOk =
    p.protocol === t.protocol || (t.protocol === "http:" && p.protocol === "https:")
  return host(p) === host(t) && protocolOk
}
