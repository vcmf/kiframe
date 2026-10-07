import { describe, expect, it } from "vitest"
import { appCard, cleanWhy, isLocal } from "../src/add-app.ts"

describe("add_app's card", () => {
  it("shows the host as the browser reaches it: punycode and port kept, never decoded", () => {
    expect(appCard("a", "https://аpple.example:8443/x", "y")).toMatchObject({
      host: "xn--pple-43d.example:8443",
      lookalike: true,
      plain: false,
    })
    expect(appCard("a", "http://docs.test", "y")).toMatchObject({
      host: "docs.test",
      plain: true,
      lookalike: false,
    })
    expect(appCard("a", "javascript:alert(1)", "y")).toMatchObject({
      error: expect.stringMatching(/^url:/) as unknown,
    })
  })

  it("says a site on this computer or its local network", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "printer.local",
      "127.0.0.1",
      "10.0.0.2",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.1.1",
      "[::1]",
      "[fd00::1]",
    ]) {
      expect(isLocal(host), host).toBe(true)
    }
    for (const host of [
      "router",
      "nas",
      "box.lan",
      "db.internal",
      "pi.home.arpa",
      "[::ffff:c0a8:101]",
    ]) {
      expect(isLocal(host), host).toBe(true)
    }
    for (const host of [
      "minmux.dev",
      "172.32.0.1",
      "8.8.8.8",
      "fdroid.org",
      "fc.example",
      "[::ffff:808:808]",
    ]) {
      expect(isLocal(host), host).toBe(false)
    }
  })

  it("keeps the agent's reason one plain line: no control, bidi or invisible characters", () => {
    expect(cleanWhy("a\nb\r\tc‮d​e⁦f")).toBe("a b c d e f")
    expect(cleanWhy("x".repeat(500))).toHaveLength(200)
  })
})
