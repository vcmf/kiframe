import type { Condition } from "@kiframe/schema"
import type { Locator } from "playwright"
import { StepError, type StepRef } from "../errors.ts"
import { ProbeRefusal, refreshExactNames, secretsOf } from "../secret-state.ts"
import { describeLocator, toPlaywright, visibleOnly } from "../targets.ts"
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
) {
  const { page } = ctx
  const what = describeCondition(condition)
  // While secrets are known, a locator is rebuilt at every poll with the exact-names rule of the
  // moment (§3 A8): one built once would keep partial matching after a secret field renders.
  const strict = secretsOf(page.context()).values.size > 0
  const locate = (): Locator | undefined => {
    if ("visible" in condition) return toPlaywright(page, condition.visible)
    if ("hidden" in condition) return toPlaywright(page, condition.hidden)
    if ("text" in condition) return toPlaywright(page, { by: "text", text: condition.text })
    return undefined
  }
  try {
    if (strict && locate() !== undefined) {
      const wantVisible = !("hidden" in condition)
      const deadline = Date.now() + timeout
      for (;;) {
        await refreshExactNames(page)
        const count = await visibleOnly(locate() as Locator)
          .count()
          .catch(() => 0)
        if (count > 0 === wantVisible) break
        if (Date.now() >= deadline) throw new ConditionTimeout()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } else if ("visible" in condition) {
      // Any VISIBLE match counts (a hidden template of the same element doesn't block).
      await visibleOnly(toPlaywright(page, condition.visible))
        .first()
        .waitFor({ state: "visible", timeout })
    } else if ("hidden" in condition) {
      // Hidden = no visible match left.
      await visibleOnly(toPlaywright(page, condition.hidden))
        .first()
        .waitFor({ state: "detached", timeout })
    } else if ("text" in condition) {
      await visibleOnly(toPlaywright(page, { by: "text", text: condition.text }))
        .first()
        .waitFor({ state: "visible", timeout })
    } else if ("url" in condition) {
      const expected = new URL(condition.url, ctx.base)
      await page.waitForURL((url) => urlMatches(url, expected), { timeout })
    } else if (!(await ctx.network.waitForIdle(timeout))) {
      throw new ConditionTimeout()
    }
  } catch (cause) {
    // Only a timeout means "the condition wasn't met"; anything else (page closed, crashed…) is
    // reported as an action failure with its cause, so it isn't mistaken for a locator problem.
    if (
      cause instanceof ConditionTimeout ||
      (cause instanceof Error && cause.name === "TimeoutError")
    ) {
      // Say it when the exact-names rule (§3 A8) was on: a partial name no longer matches.
      const exact = secretsOf(page.context()).exactNames && !("url" in condition)
      const hint = exact
        ? " (names match exactly while a field holding a secret is on the page)"
        : ""
      throw new StepError(step, reason, `${what} (after ${timeout} ms)${hint}`)
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
