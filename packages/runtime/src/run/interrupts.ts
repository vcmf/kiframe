import { firstApp, type ProjectConfig } from "@kiframe/schema"
import type { Page } from "playwright"
import { StepError, type StepRef } from "../errors.ts"
import {
  EXACT_NAMES_HINT,
  exactNamesFor,
  isPartialName,
  isSafeSelector,
  ProbeRefusal,
} from "../secret-state.ts"
import { pollLocator } from "./conditions.ts"
import { countUnderRule } from "../targets.ts"
import { type Ctx, firstLine, guard } from "./context.ts"
import { requireApproval } from "./risky.ts"
import { settle } from "./settle.ts"

// Interrupt rules (handled off camera, cut from the video) and hide rules (injected CSS).

/** One `display: none` rule per selector: a selector the browser rejects doesn't void the others. */
export function hideCss(selectors: readonly string[]): { css: string; skipped: string[] } {
  // The A8 grammar always (§3): a hide rule is live CSS for the whole page, and a later run on it
  // may know a secret (`form:has(input[value^=h]) button` would change what later steps see).
  const kept: string[] = []
  const skipped: string[] = []
  for (const s of selectors) (isSafeSelector(s) ? kept : skipped).push(s)
  return { css: kept.map((s) => `${s} { display: none !important; }`).join("\n"), skipped }
}

/** Pages already hiding a given CSS (a harness may run many scenarios on one page). */
const hiddenOn = new WeakMap<Page, Set<string>>()

/**
 * Hides the project's `hide` selectors on a page: in the current document and in every later one
 * (an init script adds the style at each navigation). Off camera and on: they're never filmed.
 */
export async function applyHide(ctx: Ctx, page: Page): Promise<void> {
  if (ctx.hideCss === "") return
  const applied = hiddenOn.get(page) ?? new Set<string>()
  if (applied.has(ctx.hideCss)) return
  try {
    await page.addInitScript((css: string) => {
      // The top document only (not third-party iframes), in its <head> as soon as it exists:
      // server-rendered hidden elements are never painted, and the tree a hydrating app compares
      // against only gains a <style> in <head>, like an extension's.
      if (window !== window.top) return
      const add = () => {
        const style = document.createElement("style")
        style.textContent = css
        document.head.append(style)
      }
      if (document.head !== null) add()
      else {
        new MutationObserver((_, observer) => {
          if (document.head === null) return
          observer.disconnect()
          add()
        }).observe(document, { childList: true, subtree: true })
      }
    }, ctx.hideCss)
    // Marked only once it worked: a failure is retried at the next switch.
    applied.add(ctx.hideCss)
    hiddenOn.set(page, applied)
  } catch {
    // the current document still gets the style below
  }
  await page.addStyleTag({ content: ctx.hideCss }).catch(() => {
    // Typically a Content-Security-Policy without inline styles: say so, never film them silently.
    if (page.isClosed()) return
    ctx.options.onEvent?.({
      kind: "warning",
      message:
        "the `hide` rules couldn't be applied on a page (a security policy blocking inline styles?): hidden elements may be filmed",
    })
  })
}

const whenLocator = (rule: ProjectConfig["interrupts"][number]) =>
  "by" in rule.when ? rule.when : { by: "text" as const, text: rule.when.text }

/** Rules already reported as skipped (§3 A8), per context: one warning each, not one per step. */
const skippedRulesOf = new WeakMap<object, Set<string>>()

const exactRulesOf = new WeakMap<object, Set<string>>()

/** The first rule (in order, not in `skip`) whose `when` is visible right now (no waiting). */
async function matchingInterrupt(
  ctx: Ctx,
  skip: ReadonlySet<string>,
): Promise<ProjectConfig["interrupts"][number] | undefined> {
  const rules = ctx.interrupts.filter((r) => !skip.has(r.id))
  // The exact-names rule (§3 A8) decided once for all the rules.
  const names = await exactNamesFor(
    ctx.page,
    rules.map((r) => whenLocator(r)),
  )
  const context = ctx.page.context()
  const skippedRules = skippedRulesOf.get(context) ?? new Set<string>()
  skippedRulesOf.set(context, skippedRules)
  // A partial `when` matches exactly for now: said once per rule (a banner it no longer sees would
  // otherwise block a click with nothing pointing at names).
  const exactRules = exactRulesOf.get(context) ?? new Set<string>()
  exactRulesOf.set(context, exactRules)
  if (names.exact) {
    for (const rule of rules) {
      if (!isPartialName(whenLocator(rule)) || exactRules.has(rule.id)) continue
      exactRules.add(rule.id)
      ctx.options.onEvent?.({
        kind: "warning",
        message: `interrupt rule "${rule.id}" matches its name exactly for now${EXACT_NAMES_HINT}`,
      })
    }
  }
  // All rules queried at once, not one after another (an org rule bank can be long).
  const counts = await Promise.all(
    rules.map(async (rule) => {
      try {
        // Counted under the rule decided once for this check; partial matches confirmed together
        // below (one page check, not one per rule: §3 A8).
        return (
          (await countUnderRule(ctx.page, whenLocator(rule), names, { confirm: false })).count ?? 0
        )
      } catch (error) {
        // A `when` that could probe a known value (§3 A8) never matches while secrets are known,
        // with one warning per rule; any other failure (a selector the browser rejects) is no
        // match, as it always was.
        if (error instanceof ProbeRefusal && !skippedRules.has(rule.id)) {
          skippedRules.add(rule.id)
          ctx.options.onEvent?.({
            kind: "warning",
            message: `interrupt rule "${rule.id}" is skipped: ${error.message}`,
          })
        }
        return 0
      }
    }),
  )
  // A partial match is confirmed once for all the rules: a field holding a secret may have rendered
  // since the rule's check. If so, the matching rules are counted again exactly.
  const partialHit = rules.some((r, i) => (counts[i] ?? 0) > 0 && isPartialName(whenLocator(r)))
  if (!names.exact && partialHit && (await exactNamesFor(ctx.page, rules.map(whenLocator))).exact) {
    const exact = { exact: true, unsure: false }
    await Promise.all(
      rules.map(async (rule, i) => {
        if ((counts[i] ?? 0) === 0 || !isPartialName(whenLocator(rule))) return
        counts[i] =
          (await countUnderRule(ctx.page, whenLocator(rule), exact).catch(() => undefined))
            ?.count ?? 0
      }),
    )
  }
  return rules.find((_, i) => (counts[i] ?? 0) > 0)
}

/**
 * The explicit interrupt check (OBJECT-MODEL §2b), not Playwright's locator handlers (they fire
 * between a mouse move and a press). Each matching rule's `do` runs off camera; the span is marked
 * (interrupt_start / _end) so the generators cut it. Up to 3 in a row (a banner, then a modal).
 * A rule runs at most once per page: a dismissed banner may stay in the page, faded out.
 */
export async function handleInterrupts(ctx: Ctx, step: StepRef): Promise<void> {
  // A rule's own click never checks again (a modal over its button would loop forever).
  if (ctx.inInterrupt || ctx.interrupts.length === 0 || ctx.page.isClosed()) return
  const page = ctx.page
  const done = ctx.interruptsDone.get(page) ?? new Set<string>()
  ctx.interruptsDone.set(page, done)
  for (let round = 0; round < 3; round++) {
    const rule = await matchingInterrupt(ctx, done)
    if (rule === undefined) break
    done.add(rule.id)
    ctx.options.onEvent?.({ kind: "interrupt_start", step, rule: rule.id })
    // Off camera: no human pacing, no settle beat (the span is cut anyway).
    const ref: StepRef = {
      phase: "setup",
      index: step.index,
      action: `interrupt ${rule.id}`,
      interrupt: rule.id,
    }
    ctx.inInterrupt = true
    try {
      if (rule.do.risky === true) {
        await requireApproval(ctx, ref, "risky step needs approval")
      }
      // A rule fires on any page, mid-anything: its goto means the first app, always (the scene's
      // app is back after it).
      const scene = ctx.app
      ctx.app = firstApp({ apps: ctx.apps }).name
      try {
        await ctx.perform(rule.do, ref)
      } finally {
        ctx.app = scene
      }
      await guard(ref, () => settle(ctx, false))
      // Best effort, inside the cut: a dialog fading out is gone before the step is filmed. One
      // that fades in place (opacity 0) never counts as hidden: the wait just ends.
      // A polling loop with the exact-names rule of each moment (§3 A8): the `do` may have just
      // made a secret known. An absence it can't check by a partial name ends the wait.
      await waitGone(ctx, rule)
    } catch (error) {
      // Its own reason kept (a refused approval stays `risky-not-approved`).
      const reason = error instanceof StepError ? error.reason : "action-failed"
      const detail = error instanceof StepError ? error.detail : firstLine(error)
      throw new StepError(
        { ...step, interrupt: rule.id },
        reason,
        `the interrupt "${rule.id}" couldn't be handled: ${detail}`,
        { cause: error },
      )
    } finally {
      ctx.inInterrupt = false
    }
    ctx.options.onEvent?.({ kind: "interrupt_end", step, rule: rule.id })
  }
}

/** Waits (up to 1 s, best effort) for a handled rule's `when` to be gone (`pollLocator`). */
async function waitGone(ctx: Ctx, rule: ProjectConfig["interrupts"][number]): Promise<void> {
  await pollLocator(ctx.page, whenLocator(rule), {
    timeout: Math.min(ctx.timeoutMs, 1000),
    visible: false,
    negative: false,
    bestEffort: true,
    failed: () => new Error("still there"),
  }).catch(() => undefined)
}
