import { type App, type Apps, appOf, sameApp, type WebApp, webAppsOf } from "@kiframe/schema"
import type { Ctx } from "./context.ts"
import { placeOf } from "../electron.ts"
import { StepError, type StepRef } from "../errors.ts"

// The project's apps a scene moves between (OBJECT-MODEL §0.9). Which app a step means is read
// from its own text, never from where the page went or what ran before it: the app it names
// (`goto { app }`, a URL condition's `app`), else its scene's start app (`ctx.app`), its preset's
// inside a preset, the first app for an interrupt rule. So a step grounded alone on the live page
// means what it means in the replay.

/** An app by name; one the project doesn't list is refused (a step error naming it). */
export function appNamed(apps: Apps, name: string, step: StepRef): App {
  const app = appOf({ apps }, name)
  if (app === undefined) {
    throw new StepError(step, "invalid-setup", `app "${name}" isn't one of the project's apps`)
  }
  return app
}

/**
 * A web app by its name, for what needs an address (a goto, a URL condition): a desktop app has
 * none (it starts where it opens: steps move in it by clicking), refused saying so.
 */
export function webAppNamed(
  apps: Apps,
  name: string,
  step: StepRef,
  what: string,
  electron?: string,
): WebApp {
  // A desktop app's run has that one app: its window never goes to a site (a page loaded in it
  // runs with the app's own privileges).
  if (electron !== undefined) {
    throw new StepError(
      step,
      "invalid-setup",
      `${what} can't run in a desktop app's scene: it stays in "${electron}" (move in it by clicking)`,
    )
  }
  const app = appNamed(apps, name, step)
  if (app.kind !== "web") {
    throw new StepError(
      step,
      "invalid-setup",
      `${what} needs a web app: "${name}" is a desktop app (it opens on its own window: move in it by clicking)`,
    )
  }
  return app
}

/** The listed app whose exact origin `url` (a URL, or an origin) is on (its name), if any. */
export function appAtOrigin(apps: Apps, url: string): string | undefined {
  // An opaque origin ("null": about:blank, data:, a sandboxed page) is no app's.
  const origin = URL.parse(url)?.origin
  if (origin === undefined || origin === "null") return undefined
  return Object.entries(webAppsOf(apps)).find(([, app]) => new URL(app.url).origin === origin)?.[0]
}

/** How long a page off the apps may take to come back (a redirect still in flight: an SSO bounce). */
const BACK_MS = 2500

/** Whether `url` is one of the apps' pages: their site (`sameApp`, a blob: by its creator's origin). */
export function onApps(apps: Apps, url: string): boolean {
  const parsed = URL.parse(url)
  if (parsed === null || !["http:", "https:", "blob:"].includes(parsed.protocol)) return false
  return Object.values(webAppsOf(apps)).some((app) => sameApp(parsed, app.url))
}

/**
 * Where a step left the driven page, allowed: one of the apps' pages (`onApps`), or a blank page (a
 * tab a step opened is followed once its first page loaded, `syncPage`: what it loads is checked).
 * Anything else fails: another site (`off-app`), a page that failed to load, file:, data:… (an
 * allow-list: what isn't the apps is never filmed). A page still on its way back (a redirect) gets
 * a moment first; a stop ends the wait as a stop.
 */
export async function confine(ctx: Ctx, step: StepRef): Promise<void> {
  // A desktop app's run: its own pages only (its guard stopped any other at once), never a web
  // app's (one app per run: its window never shows a site).
  const electron = ctx.options.electron
  if (electron !== undefined) {
    // A stop counts against the step when it was the driven window's (or a frame in it), or a
    // window itself (one the step opened, sent back); a frame of another window is said only.
    // The guard's stops done first: never a window read mid-stop.
    await electron.quiet()
    const stops = electron.stopped()
    for (const s of stops) {
      if (s.page !== ctx.page && !s.window) {
        ctx.options.onEvent?.({
          kind: "warning",
          message: `a frame of another window of "${electron.app}" went to ${s.place}: Kiframe stopped it`,
        })
      }
    }
    const went = stops.filter((s) => s.page === ctx.page || s.window)
    if (went.length > 0) {
      throw new StepError(
        step,
        "off-app",
        `the app's window went to ${went[0]?.place ?? ""}, not the app's own (Kiframe stopped it): if it's the app's, list it in the app's origins; else keep the scene in "${electron.app}"`,
      )
    }
    // A window that opens blank and loads after some setup gets a moment (as a web page does).
    const until = Date.now() + BACK_MS
    while (ctx.page.url() === "about:blank" && Date.now() < until && !ctx.page.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const now = ctx.page.url()
    if (now.startsWith("chrome-error:")) {
      throw new StepError(step, "action-failed", "the page failed to load")
    }
    // Still blank (stopped with nothing to go back to): said, never silent.
    if (now === "about:blank") {
      throw new StepError(
        step,
        "off-app",
        `the app's window is blank (Kiframe stopped a page that wasn't the app's, or it never loaded): relaunch "${electron.app}"`,
      )
    }
    if (electron.allows(now)) return
    throw new StepError(
      step,
      "off-app",
      `the app's window is on ${placeOf(now)}, not the app's own: if it's the app's, list it in the app's origins; else keep the scene in "${electron.app}"`,
    )
  }

  const until = Date.now() + BACK_MS
  for (;;) {
    const now = ctx.page.url()
    if (onApps(ctx.apps, now)) return
    if (now === "about:blank") return
    const url = URL.parse(now)
    // Chromium's error page: the load failed (not another site), said at once.
    if (url?.protocol === "chrome-error:") {
      throw new StepError(step, "action-failed", "the page failed to load")
    }
    if (ctx.options.signal?.aborted === true) {
      throw new StepError(step, "stopped", "the run was stopped")
    }
    if (Date.now() >= until || ctx.page.isClosed()) {
      const where = placeOf(now)
      throw new StepError(
        step,
        "off-app",
        `the page is on ${where}, not one of the project's apps (${Object.keys(ctx.apps).join(", ")}): add it as an app, or keep the scene on them`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
