// The app's window and the hardening every web contents gets: no new windows, no navigation away,
// no permissions, the CSP on every response, and the pages served from the app's own protocol.
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { app, BrowserWindow, protocol, session } from "electron"
import { APP_ORIGIN, APP_SCHEME, appFile, contentSecurityPolicy, isAppUrl } from "./security.ts"

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}

/** Before `ready`: the app's scheme is a secure, standard one (fetch, relative URLs work). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/** At `ready`: serve the built window from `root`, the CSP on every page. */
export function serveApp(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = appFile(root, request.url)
    if (file === undefined) return new Response("not found", { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, {
        headers: {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "content-security-policy": contentSecurityPolicy(),
          "x-content-type-options": "nosniff",
        },
      })
    } catch {
      return new Response("not found", { status: 404 })
    }
  })
}

/** Every web contents: no windows, no navigation, no webviews; every permission refused. */
export function hardenSessions(devServer?: string): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  if (devServer !== undefined) {
    // The dev server's pages get the CSP too (its own, with hot reload).
    ses.webRequest.onHeadersReceived({ urls: [`${devServer}/*`] }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "content-security-policy": [contentSecurityPolicy(devServer)],
        },
      })
    })
  }
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    contents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url, devServer)) event.preventDefault()
    })
    contents.on("will-redirect", (event, url) => {
      if (!isAppUrl(url, devServer)) event.preventDefault()
    })
    contents.on("will-attach-webview", (event) => event.preventDefault())
  })
}

/** The main window, as in the mockup: the app draws its own title bar. */
export function createWindow(preloadDir: string, devServer?: string): BrowserWindow {
  const mac = process.platform === "darwin"
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: app.getName(),
    backgroundColor: "#FFFFFF",
    show: false,
    ...(mac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(preloadDir, "index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  window.on("page-title-updated", (event) => event.preventDefault())
  window.once("ready-to-show", () => window.show())
  void window.loadURL(devServer ?? `${APP_ORIGIN}/index.html`)
  return window
}
