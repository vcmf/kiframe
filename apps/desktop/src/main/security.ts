// The window's hardening, as plain functions (tested without Electron): the CSP, which links may
// open in the user's browser, and which app files the app's protocol may serve.
import { relative, resolve, sep } from "node:path"
import { hasUrlCredentials } from "@kiframe/schema"

/** The app's own origin: the window's pages are served from it (never `file://`). */
export const APP_SCHEME = "kiframe-app"
export const APP_ORIGIN = `${APP_SCHEME}://app`

/**
 * The window's content security policy: only the app's own scripts, styles, fonts and images; no
 * frames, plugins, forms or base changes. `devServer` (development only) adds the dev server and
 * its hot-reload socket, and the inline preamble React's refresh needs.
 */
export function contentSecurityPolicy(devServer?: string): string {
  const self = devServer === undefined ? "'self'" : `'self' ${devServer}`
  const socket = devServer === undefined ? "" : ` ${devServer.replace(/^http/, "ws")}`
  return [
    "default-src 'none'",
    `script-src ${self}${devServer === undefined ? "" : " 'unsafe-inline'"}`,
    `style-src ${self}${devServer === undefined ? "" : " 'unsafe-inline'"}`,
    `font-src ${self}`,
    `img-src ${self} data: blob:`,
    `connect-src ${self}${socket}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
}

/** A link the user may open in their browser: https only, no credentials in it. */
export function isSafeExternal(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === "https:" && !hasUrlCredentials(url)
}

/**
 * The file under `root` an app URL names, or undefined (another origin, or a path leaving the
 * root: `..`, an encoded separator).
 */
export function appFile(root: string, url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (`${parsed.protocol}//${parsed.host}` !== APP_ORIGIN) return undefined
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return undefined
  }
  if (path.includes("\0")) return undefined
  const base = resolve(root)
  const file = resolve(base, `.${path === "/" ? "/index.html" : path}`)
  const rel = relative(base, file)
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || resolve(base, rel) !== file) {
    return undefined
  }
  return file
}

/** Whether a frame's URL is the app's own page (the only sender main answers). */
export function isAppUrl(url: string, devServer?: string): boolean {
  try {
    const parsed = new URL(url)
    const origin = `${parsed.protocol}//${parsed.host}`
    return (
      origin === APP_ORIGIN || (devServer !== undefined && origin === new URL(devServer).origin)
    )
  } catch {
    return false
  }
}
