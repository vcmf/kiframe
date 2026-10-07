import { describe, expect, it } from "vitest"
import { sameApp } from "./site.ts"

describe("when a page is on the app", () => {
  it("takes its own origin, and its host under www. either way, or upgraded to https", () => {
    expect(sameApp("https://minmux.dev/docs", "https://minmux.dev")).toBe(true)
    expect(sameApp("https://www.minmux.dev/docs", "https://minmux.dev")).toBe(true)
    expect(sameApp("https://minmux.dev/", "https://www.minmux.dev")).toBe(true)
    expect(sameApp("https://app.test/", "http://app.test")).toBe(true)
    expect(sameApp("http://localhost:4000/x", "http://localhost:4000")).toBe(true)
    // A trailing dot names the same host.
    expect(sameApp("https://minmux.dev./x", "https://minmux.dev")).toBe(true)
    expect(sameApp("https://minmux.dev.:8443/", "https://minmux.dev:8443")).toBe(true)
  })

  it("never another host, port, a downgrade, or a page without an origin", () => {
    expect(sameApp("https://login.minmux.dev/", "https://minmux.dev")).toBe(false)
    expect(sameApp("https://minmux.dev.evil.com/", "https://minmux.dev")).toBe(false)
    expect(sameApp("https://wwwminmux.dev/", "https://minmux.dev")).toBe(false)
    expect(sameApp("http://minmux.dev/", "https://minmux.dev")).toBe(false)
    expect(sameApp("https://minmux.dev:8443/", "https://minmux.dev")).toBe(false)
    expect(sameApp("data:text/html,hi", "https://minmux.dev")).toBe(false)
    expect(sameApp("not a url", "https://minmux.dev")).toBe(false)
  })

  it("takes a blob: page by its creator's origin, redirected too", () => {
    expect(sameApp("blob:https://www.minmux.dev/1234", "https://minmux.dev")).toBe(true)
    expect(sameApp("blob:https://evil.dev/1234", "https://minmux.dev")).toBe(false)
  })
})
