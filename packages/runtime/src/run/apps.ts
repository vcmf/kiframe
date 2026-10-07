import { type App, type Apps, appOf } from "@kiframe/schema"
import { StepError, type StepRef } from "../errors.ts"

// The project's apps a scene moves between (OBJECT-MODEL §0.9). Which app a step means is read
// from its own text, never from where the page went or what ran before it: the app it names
// (`goto { app }`, a URL condition's `app`), else its scene's start app (`ctx.app`), its preset's
// inside a preset, the first app for an interrupt rule. So a step grounded alone on the live page
// means what it means in the replay, and a teardown cleans the app it was written for.

/** An app by name; one the project doesn't list is refused (a step error naming it). */
export function appNamed(apps: Apps, name: string, step: StepRef): App {
  const app = appOf({ apps }, name)
  if (app === undefined) {
    throw new StepError(step, "invalid-setup", `app "${name}" isn't one of the project's apps`)
  }
  return app
}

/** The listed app whose exact origin `url` (a URL, or an origin) is on (its name), if any. */
export function appAtOrigin(apps: Apps, url: string): string | undefined {
  // An opaque origin ("null": about:blank, data:, a sandboxed page) is no app's.
  const origin = URL.parse(url)?.origin
  if (origin === undefined || origin === "null") return undefined
  return Object.entries(apps).find(([, app]) => new URL(app.url).origin === origin)?.[0]
}
