import { describe, expect, it } from "vitest"
import { appFile, contentSecurityPolicy, isAppUrl, isSafeExternal } from "../src/main/security.ts"

describe("the window's hardening", () => {
  it("serves only files under the app's root, from its own origin", () => {
    expect(appFile("/app/out", "kiframe-app://app/index.html")).toBe("/app/out/index.html")
    expect(appFile("/app/out", "kiframe-app://app/")).toBe("/app/out/index.html")
    expect(appFile("/app/out", "kiframe-app://app/assets/a.js")).toBe("/app/out/assets/a.js")
    // A `..` segment (`%2e%2e` too) is resolved by the URL parser itself: still under the root.
    expect(appFile("/app/out", "kiframe-app://app/../secret")).toBe("/app/out/secret")
    expect(appFile("/app/out", "kiframe-app://app/%2e%2e/secret")).toBe("/app/out/secret")
    for (const url of [
      // Encoded separators reach the decoder as `../..`: refused.
      "kiframe-app://app/assets/%2e%2e%2f%2e%2e%2fsecret",
      "kiframe-app://app/a%00.js",
      "kiframe-app://other/index.html",
      "https://app/index.html",
      "kiframe-app://app/%E0%A4%A",
      "not a url",
    ]) {
      expect(appFile("/app/out", url), url).toBeUndefined()
    }
  })

  it("opens only https links without credentials in the user's browser", () => {
    expect(isSafeExternal("https://openrouter.ai/keys")).toBe(true)
    for (const url of [
      "http://openrouter.ai",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://u:p@x.com",
      "https://u@x.com",
      "x",
    ]) {
      expect(isSafeExternal(url), url).toBe(false)
    }
  })

  it("answers only the app's own pages (and the dev server, in development)", () => {
    expect(isAppUrl("kiframe-app://app/index.html")).toBe(true)
    expect(isAppUrl("https://evil.example/")).toBe(false)
    expect(isAppUrl("http://localhost:5173/")).toBe(false)
    expect(isAppUrl("http://localhost:5173/", "http://localhost:5173")).toBe(true)
  })

  it("allows no inline script, frame or plugin in the shipped window", () => {
    const csp = contentSecurityPolicy()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("unsafe")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(contentSecurityPolicy("http://localhost:5173")).toContain(
      "connect-src 'self' http://localhost:5173 ws://localhost:5173",
    )
  })
})
