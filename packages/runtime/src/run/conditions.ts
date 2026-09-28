import type { Condition } from "@kiframe/schema"
import { StepError, type StepRef } from "../errors.ts"
import { EXACT_NAMES_HINT, exactNamesFor, ProbeRefusal } from "../secret-state.ts"
import { describeLocator, isNavigationError, toPlaywright, visibleOnly } from "../targets.ts"
import { type Ctx, firstLine } from "./context.ts"

// Conditions for `waitFor` / `expect` / `ensure`, and URL matching.

/** Signals a condition that timed out without a Playwright TimeoutError (network idle). */
class ConditionTimeout extends Error {}

export async function waitForCondition(
  ctx: Ctx,
  condition: Condition,
  timeout: number,
  step: StepRef,
  reason: "condition-timeout" | "expectation-failed",
  /** The check is for an absence (`ensure: absent` asks "does it appear?" expecting no). */
  negative = false,
) {
  const { page } = ctx
  const what = describeCondition(condition)
  const exactHint = EXACT_NAMES_HINT
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
      // One polling loop: the locator is rebuilt at every poll with the exact-names rule of the
      // moment (§3 A8; a no-op while no value is known).
      const wantVisible = !("hidden" in condition)
      const absence = negative || !wantVisible
      const started = Date.now()
      let deadline = started + timeout
      // Whether any poll could look (exact names off, the page readable), and when the first did:
      // an absence's grace runs from there (the wait for a secret field to go doesn't eat it).
      let firstLook: number | undefined
      // An absence counts only when seen twice in a row on the same, fully loaded document: mid-
      // navigation, `count()` reads 0 on a page being replaced.
      let zeroOn: string | undefined
      for (;;) {
        const rule = await exactNamesFor(page, [locator])
        const blocked = absence && (rule.exact || rule.unsure)
        if (!blocked) {
          if (firstLook === undefined) {
            firstLook = Date.now()
            // Bounded: at most one more timeout past the step's own.
            if (absence)
              deadline = Math.min(Math.max(deadline, firstLook + timeout), started + 2 * timeout)
          }
          const count = await visibleOnly(toPlaywright(page, locator, rule.exact))
            .count()
            .catch((error: unknown) => {
              // A navigation replaced the page mid-poll: poll again on the new one. Anything
              // else is a real failure (never read as "met").
              if (isNavigationError(error)) return undefined
              throw error
            })
          if (count !== undefined && count > 0 && wantVisible) return
          if (count === 0 && !wantVisible) {
            const doc = await page
              .evaluate(() => (document.readyState === "complete" ? location.href : undefined))
              .catch(() => undefined)
            if (doc !== undefined && doc === zeroOn) return
            zeroOn = doc
          } else zeroOn = undefined
        } else zeroOn = undefined
        if (Date.now() >= deadline) {
          // Never a timeout for an absence no poll could check: `ensure: absent` would read a
          // timeout as "not there".
          if (absence && firstLook === undefined) {
            throw new StepError(
              step,
              "secret-refused",
              `${describeAbsence(locator)}: couldn't check it by a partial name${exactHint}`,
            )
          }
          throw new StepError(
            step,
            reason,
            `${what} (after ${timeout} ms)${rule.exact ? exactHint : ""}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } else if ("url" in condition) {
      const expected = new URL(condition.url, ctx.base)
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

function describeAbsence(locator: Parameters<typeof describeLocator>[0]): string {
  return `the absence of ${describeLocator(locator)}`
}

function describeCondition(condition: Condition): string {
  if ("visible" in condition) return `${describeLocator(condition.visible)} never became visible`
  if ("hidden" in condition) return `${describeLocator(condition.hidden)} never disappeared`
  if ("text" in condition) return `text "${condition.text}" never appeared`
  if ("url" in condition) return `URL never matched ${condition.url}`
  return "network never went idle"
}

/**
 * URL condition: same origin, the path equals the expected path or continues it at a segment
 * boundary (`/projects/1` matches `/projects/1` and `/projects/1/edit`, not `/projects/12`); the root
 * `/` only matches the root itself. Every expected query parameter must be present with its value,
 * and an expected `#hash` (hash-routed apps) is matched the same way as a path.
 */
export function urlMatches(actual: URL, expected: URL): boolean {
  if (actual.origin !== expected.origin) return false
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
