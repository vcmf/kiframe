import { describe, expect, it } from "vitest"
import { resolveAppAddress } from "../src/main/app-address.ts"

/** A fetch that answers from a table of redirects (`from → to`), recording what it was asked. */
function sites(redirects: Record<string, string>, fail?: Error) {
  const asked: { url: string; init: RequestInit | undefined }[] = []
  const fetcher = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
    asked.push({ url, init })
    if (fail !== undefined) return Promise.reject(fail)
    const to = redirects[url]
    return Promise.resolve(
      to === undefined
        ? new Response("<html>app</html>", { status: 200 })
        : new Response(null, { status: 302, headers: { location: to } }),
    )
  }) as typeof fetch
  return { fetcher, asked }
}

describe("an app's address, resolved when it's added", () => {
  it("is stored where its www. form lands, at its root", async () => {
    const { fetcher } = sites({ "https://minmux.dev/": "https://www.minmux.dev/home" })
    expect(await resolveAppAddress("https://minmux.dev", { fetch: fetcher })).toBe(
      "https://www.minmux.dev/",
    )
  })

  it("keeps a typed path as it is (the app may live there on the typed site), never fetched", async () => {
    const { fetcher, asked } = sites({ "https://acme.test/": "https://www.acme.test/" })
    for (const typed of [
      "https://acme.test/app",
      "https://acme.test/auth/magic?token=once",
      "https://acme.test/#/board",
    ]) {
      expect(await resolveAppAddress(typed, { fetch: fetcher })).toBe(typed)
    }
    expect(asked).toEqual([])
  })

  it("follows an upgrade to https, and a relative redirect", async () => {
    const { fetcher } = sites({
      "http://acme.test/": "https://acme.test/",
      "https://acme.test/": "/home",
    })
    expect(await resolveAppAddress("http://acme.test", { fetch: fetcher })).toBe(
      "https://acme.test/",
    )
  })

  it("never adopts a login host, an SSO provider or another site", async () => {
    for (const to of [
      "https://login.acme.test/",
      "https://accounts.google.com/o/oauth2",
      "https://elsewhere.test/",
    ]) {
      const { fetcher } = sites({ "https://acme.test/": to })
      expect(await resolveAppAddress("https://acme.test", { fetch: fetcher })).toBe(
        "https://acme.test",
      )
    }
  })

  it("never adopts an error page (a bot challenge, a server error) on the www. form", async () => {
    for (const status of [403, 404, 503]) {
      const fetcher = ((input: URL | RequestInfo) =>
        Promise.resolve(
          input instanceof URL && input.href === "https://acme.test/"
            ? new Response(null, { status: 301, headers: { location: "https://www.acme.test/" } })
            : new Response("no", { status }),
        )) as typeof fetch
      expect(await resolveAppAddress("https://acme.test", { fetch: fetcher }), String(status)).toBe(
        "https://acme.test",
      )
    }
  })

  it("never adopts a downgrade to http", async () => {
    const { fetcher } = sites({ "https://acme.test/": "http://www.acme.test/" })
    expect(await resolveAppAddress("https://acme.test", { fetch: fetcher })).toBe(
      "https://acme.test",
    )
  })

  it("fetches the root without cookies, following redirects one by one", async () => {
    const { fetcher, asked } = sites({})
    await resolveAppAddress("https://acme.test", { fetch: fetcher })
    expect(asked.map((a) => a.url)).toEqual(["https://acme.test/"])
    expect(asked[0]?.init).toMatchObject({ redirect: "manual", credentials: "omit" })
  })

  it("keeps the address as typed when the site can't be reached, or redirects without end", async () => {
    const { fetcher } = sites({}, new TypeError("fetch failed"))
    expect(await resolveAppAddress("https://acme.test", { fetch: fetcher })).toBe(
      "https://acme.test",
    )
    // Every hop on the www. form: still never adopted (it never landed).
    const loop = sites({
      "https://acme.test/": "https://www.acme.test/a",
      "https://www.acme.test/a": "https://www.acme.test/b",
      "https://www.acme.test/b": "https://www.acme.test/a",
    })
    expect(await resolveAppAddress("https://acme.test", { fetch: loop.fetcher })).toBe(
      "https://acme.test",
    )
    expect(loop.asked.length).toBeLessThanOrEqual(6)
  })

  it("never follows a redirect to another scheme", async () => {
    const { fetcher, asked } = sites({ "https://acme.test/": "data:text/html,hi" })
    expect(await resolveAppAddress("https://acme.test", { fetch: fetcher })).toBe(
      "https://acme.test",
    )
    expect(asked.map((a) => a.url)).toEqual(["https://acme.test/"])
  })

  it("gives up after its timeout", async () => {
    const never = (async (_: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as typeof fetch
    expect(await resolveAppAddress("https://acme.test", { fetch: never, timeoutMs: 50 })).toBe(
      "https://acme.test",
    )
  })
})
