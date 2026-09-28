import type { Condition } from "@kiframe/schema"
import { StepError, type StepRef } from "../errors.ts"
import { EXACT_NAMES_HINT, exactNamesFor, isPartialName, ProbeRefusal } from "../secret-state.ts"
import type { Locator as SchemaLocator } from "@kiframe/schema"
import type { Page } from "playwright"
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
        negative,
        failed: (why, waited) =>
          why === "blocked-exact" || why === "blocked-unreadable"
            ? new StepError(
                step,
                "secret-refused",
                `couldn't check the absence of ${describeLocator(locator)}: ${
                  why === "blocked-exact"
                    ? `a partial name${EXACT_NAMES_HINT}`
                    : "the page couldn't be read (navigating)"
                }`,
              )
            : new StepError(
                step,
                reason,
                `${what} (after ${waited} ms)${why === "timeout-exact" ? EXACT_NAMES_HINT : ""}`,
              ),
      })
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

/** One poll of a locator (§3 A8): seen, clear (conclusively none), or blocked (can't conclude). */
type Poll = "seen" | "clear" | "blocked-exact" | "blocked-unreadable"

/**
 * Polls a locator until it's visible (`visible`) or gone (not `visible`), or, for a `negative`
 * check (`ensure: absent` asks "does it appear?"), until it appears or the grace ends.
 *
 * Each poll is `seen` (a count above 0: a real match, even under exact names), `clear` (0, with
 * exact names off and the page readable) or blocked (0 under exact names for a partial name, or a
 * page that can't be read). An absence passes only on two `clear` polls in a row on the same
 * document (`performance.timeOrigin`: mid-navigation a count reads 0). At the deadline, an absence
 * whose last poll was blocked is refused, never timed out into "gone". An absence's time runs from
 * the first poll that wasn't blocked (bounded to twice the timeout).
 */
export async function pollLocator(
  page: Page,
  locator: SchemaLocator,
  o: {
    timeout: number
    visible: boolean
    negative: boolean
    failed: (
      why: "timeout" | "timeout-exact" | "blocked-exact" | "blocked-unreadable",
      waited: number,
    ) => Error
  },
): Promise<void> {
  const absence = o.negative || !o.visible
  const started = Date.now()
  let deadline = started + o.timeout
  let looked = false
  let last: Poll
  let exactSeen = false
  let clearOn: number | undefined
  for (;;) {
    const names = { ...(await exactNamesFor(page, [locator])) }
    const countWith = (exact: boolean) =>
      visibleOnly(toPlaywright(page, locator, exact))
        .count()
        .catch((error: unknown) => {
          if (isNavigationError(error)) return undefined
          throw error
        })
    let count = await countWith(names.exact)
    // A partial match is confirmed: a field holding a secret may have rendered between the rule's
    // check and the count (then only an exact match counts).
    if (count !== undefined && count > 0 && !names.exact && isPartialName(locator)) {
      const again = await exactNamesFor(page, [locator])
      if (again.exact) {
        names.exact = true
        names.unsure = again.unsure
        count = await countWith(true)
      }
    }
    const doc =
      count === 0 && !names.exact && !names.unsure
        ? await page
            .evaluate(() =>
              document.readyState === "loading" ? undefined : performance.timeOrigin,
            )
            .catch(() => undefined)
        : undefined
    exactSeen ||= names.exact
    last =
      count !== undefined && count > 0
        ? "seen"
        : count === undefined || names.unsure || (doc === undefined && count === 0 && !names.exact)
          ? "blocked-unreadable"
          : names.exact
            ? "blocked-exact"
            : "clear"
    if (last === "seen" && (o.visible || o.negative)) return
    if (absence && !looked && last !== "blocked-exact" && last !== "blocked-unreadable") {
      looked = true
      if (o.negative)
        deadline = Math.min(Math.max(deadline, Date.now() + o.timeout), started + 2 * o.timeout)
    }
    if (last === "clear" && !o.visible && !o.negative) {
      if (clearOn !== undefined && clearOn === doc) return
      clearOn = doc
    } else clearOn = undefined
    if (Date.now() >= deadline) {
      const waited = Date.now() - started
      if (absence && (last === "blocked-exact" || last === "blocked-unreadable")) {
        throw o.failed(last, waited)
      }
      // `ensure: absent`: a timeout means "it didn't appear" (absent), only after a clear poll.
      throw o.failed(exactSeen ? "timeout-exact" : "timeout", waited)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
