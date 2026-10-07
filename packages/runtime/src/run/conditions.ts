import { type Condition, sameApp } from "@kiframe/schema"
import { StepError, type StepRef } from "../errors.ts"
import { EXACT_NAMES_HINT, ProbeRefusal } from "../secret-state.ts"
import type { Locator as SchemaLocator } from "@kiframe/schema"
import type { Page } from "playwright"
import { countUnderRule, describeLocator, documentOf } from "../targets.ts"
import { appNamed } from "./apps.ts"
import { type Ctx, firstLine } from "./context.ts"

// Conditions for `waitFor` / `expect`, and URL matching.

/** Signals a condition that timed out without a Playwright TimeoutError (network idle). */
class ConditionTimeout extends Error {}

export async function waitForCondition(
  ctx: Ctx,
  condition: Condition,
  timeout: number,
  step: StepRef,
  reason: "condition-timeout" | "expectation-failed",
) {
  const { page } = ctx
  const what = describeCondition(condition)
  const locator =
    "visible" in condition
      ? condition.visible
      : "hidden" in condition
        ? condition.hidden
        : "text" in condition
          ? { by: "text" as const, text: condition.text }
          : undefined
  try {
    if (locator !== undefined) {
      await pollLocator(page, locator, {
        timeout,
        visible: !("hidden" in condition),
        failed: (why, waited) =>
          why === "blocked-exact"
            ? new StepError(
                step,
                "secret-refused",
                `couldn't check the absence of ${describeLocator(locator)} by a partial name${EXACT_NAMES_HINT}`,
              )
            : new StepError(
                step,
                reason,
                `${what} (after ${waited} ms)${why === "timeout-exact" ? EXACT_NAMES_HINT : ""}`,
              ),
      })
    } else if ("url" in condition) {
      // Relative to the app it names, else the one its step means.
      const app = appNamed(ctx.apps, condition.app ?? ctx.app, step)
      const expected = new URL(condition.url, app.url)
      await page.waitForURL((url) => urlMatches(url, expected), { timeout })
    } else if (!(await ctx.network.waitForIdle(timeout))) {
      throw new ConditionTimeout()
    }
  } catch (cause) {
    if (cause instanceof StepError) throw cause
    // Only a timeout means "the condition wasn't met"; anything else (page closed, crashed…) is
    // reported as an action failure with its cause, so it isn't mistaken for a locator problem.
    if (
      cause instanceof ConditionTimeout ||
      (cause instanceof Error && cause.name === "TimeoutError")
    ) {
      throw new StepError(step, reason, `${what} (after ${timeout} ms)`)
    }
    if (cause instanceof ProbeRefusal) throw new StepError(step, "secret-refused", cause.message)
    throw new StepError(step, "action-failed", firstLine(cause), { cause })
  }
}

function describeCondition(condition: Condition): string {
  if ("visible" in condition) return `${describeLocator(condition.visible)} never became visible`
  if ("hidden" in condition) return `${describeLocator(condition.hidden)} never disappeared`
  if ("text" in condition) return `text "${condition.text}" never appeared`
  if ("url" in condition) return `URL never matched ${condition.url}`
  return "network never went idle"
}

/**
 * URL condition: on the app's site (its origin, or its address redirected to www. or https:
 * `sameApp`; never an origin check for secrets), the path equals the expected path or continues it at a segment
 * boundary (`/projects/1` matches `/projects/1` and `/projects/1/edit`, not `/projects/12`); the root
 * `/` only matches the root itself. Every expected query parameter must be present with its value,
 * and an expected `#hash` (hash-routed apps) is matched the same way as a path.
 */
export function urlMatches(actual: URL, expected: URL): boolean {
  // The app's site (its address may redirect to www., or http to https).
  if (!sameApp(actual, expected)) return false
  if (!pathMatches(actual.pathname, expected.pathname)) return false
  for (const [key, value] of expected.searchParams) {
    if (!actual.searchParams.getAll(key).includes(value)) return false
  }
  if (expected.hash !== "") {
    // Hash routes (`#/projects?tab=members`) have their own path and query.
    const want = new URL(expected.hash.slice(1), "http://hash.invalid")
    const have = new URL(actual.hash.slice(1), "http://hash.invalid")
    if (!pathMatches(have.pathname, want.pathname)) return false
    for (const [key, value] of want.searchParams) {
      if (!have.searchParams.getAll(key).includes(value)) return false
    }
  }
  return true
}

function pathMatches(actual: string, expected: string): boolean {
  const want = expected.replace(/\/+$/, "")
  const path = actual.replace(/\/+$/, "")
  if (want === "") return path === ""
  return path === want || path.startsWith(`${want}/`)
}

/** One poll of a locator (§3 A8): seen, clear (conclusively none), or blocked (can't conclude). */
type Poll = "seen" | "clear" | "blocked-exact" | "blocked-unreadable"

/**
 * Polls a locator until it's visible (`visible`) or gone (not `visible`).
 *
 * Each poll (`countUnderRule`) is `seen` (a match: real even under exact names), `clear` (none,
 * exact names off, the page readable) or blocked (none under exact names for a partial name, or a
 * page that can't be read). An absence passes only on two `clear` polls in a row on the same
 * document (`performance.timeOrigin`: mid-navigation a count reads 0). At the deadline: blocked by
 * exact names, refused (`blocked-exact`); else a timeout.
 */
export async function pollLocator(
  page: Page,
  locator: SchemaLocator,
  o: {
    timeout: number
    visible: boolean
    /** Stop at once, without concluding, when a poll is blocked by exact names (a wait, not a check). */
    bestEffort?: boolean
    failed: (why: "timeout" | "timeout-exact" | "blocked-exact", waited: number) => Error
  },
): Promise<void> {
  const absence = !o.visible
  const started = Date.now()
  const deadline = started + o.timeout
  let exactSeen = false
  let last: Poll
  // Consecutive clear polls on one document (its timeOrigin).
  let clears = 0
  let clearOn: number | undefined
  for (;;) {
    const r = await countUnderRule(page, locator)
    exactSeen ||= r.exact
    // The document, for an absence only (twice on the same one).
    const doc =
      absence && r.count === 0 && !r.exact && !r.unsure ? await documentOf(page) : undefined
    last =
      r.count !== undefined && r.count > 0
        ? "seen"
        : r.count === 0 && r.exact && !r.unsure
          ? "blocked-exact"
          : r.count === undefined || r.unsure || (absence && doc === undefined)
            ? "blocked-unreadable"
            : "clear"
    if (last === "seen" && o.visible) return
    if (o.bestEffort === true && last === "blocked-exact") return
    if (last === "clear" && absence) {
      clears = clearOn !== undefined && clearOn === doc ? clears + 1 : 1
      clearOn = doc
      if (clears >= 2) return
    } else {
      clears = 0
      clearOn = undefined
    }
    if (Date.now() >= deadline) {
      const waited = Date.now() - started
      if (absence && last === "blocked-exact") throw o.failed("blocked-exact", waited)
      throw o.failed(exactSeen ? "timeout-exact" : "timeout", waited)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
