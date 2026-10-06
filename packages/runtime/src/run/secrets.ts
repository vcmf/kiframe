import {
  canonicalTarget,
  type GroundedTarget,
  isGrounded,
  SceneId,
  type Target,
} from "@kiframe/schema"
import type { ElementHandle, Locator, Page } from "playwright"
import {
  type ApprovalRequest,
  isSecretRefusal,
  type SecretUse,
  StepError,
  type StepRef,
} from "../errors.ts"
import type { Box } from "../motion.ts"
import { escapeRegExp, scanSecretTextPartly } from "../scanner.ts"
import { isNavigationError, viewportOf } from "../targets.ts"
import { appAtOrigin } from "./apps.ts"
import { type Ctx, firstLine, guard, type RegionReport, type Viewport } from "./context.ts"
import {
  containsKnownValue,
  isSafeSelector,
  liveWritten,
  SAFE_SELECTOR_RULES,
} from "../secret-state.ts"
import { now } from "../clock.ts"

// Everything about secret values: resolution, origin checks, the scrubber, field tracking and the text scan.

/** The page a read is of, and when the run switched to it (T3); by default the driven page. */
export interface ReadOf {
  page: Page
  shown: number
}

/**
 * Re-reads every field a secret was typed into, on a page (the driven one by default, or the one
 * the capture is about to leave: `of`), and reports where it is (the blur follows it) or that it's
 * gone (navigated away, removed: nothing left to blur). A field on another page was left with its
 * page (`leaveSecretFields`). Bounded, never fails a step.
 */
export async function followSecretFields(ctx: Ctx, step: StepRef, of?: ReadOf): Promise<void> {
  // One at a time (the recording tick reads too): a later one waits for the one running.
  const previous = ctx.fieldsInflight
  const run = (async () => {
    await previous?.catch(() => undefined)
    await readFields(ctx, step, of ?? { page: ctx.page, shown: ctx.pageShownAt })
  })()
  ctx.fieldsInflight = run
  try {
    await run
  } finally {
    if (ctx.fieldsInflight === run) ctx.fieldsInflight = undefined
  }
}

/** Reads a page's fields and moves each through its state (`Ctx` secretFields, T2–T4). */
async function readFields(ctx: Ctx, step: StepRef, of: ReadOf): Promise<void> {
  // The page read, fixed throughout (a switch may start while this runs). Followed from its
  // type_start only (T3: the empty field isn't blurred before typing). A field known gone is read
  // too: a re-mounted one comes back mid-step (the switch read settles a field left with its page).
  const { page } = of
  const fields = ctx.secretFields.filter((f) => f.state !== "pending" && f.page === page)
  if (fields.length === 0) return
  // When the read started (T2; the events are handled later: a move's hull starts here), and when
  // the run switched to its page (nothing it saw was on screen before: T3).
  const times = { at: now(), shown: of.shown }
  // Bounded as a whole (a frozen page): what it read is used only if it finished in time. The page
  // is only waited on (its viewport, its drawing) when the read has something to report.
  const read = await boundedRead(ctx, page, async () => {
    const measured = await Promise.all(fields.map((field) => measureSecretField(field)))
    const reports = measured.some((m, i) => m !== null || fields[i]?.state === "on")
    if (!reports) return { measured, viewport: undefined, end: now() }
    const viewport = await viewportOf(page).catch(() => undefined)
    // Its end (T2): once the page drew what it read. No drawing: unsure.
    const end = await drawnSince(page)
    return end === undefined ? undefined : { measured, viewport, end }
  })
  const end = read?.end ?? now()
  for (const [i, field] of fields.entries()) {
    const report = (r: RegionReport, at = times.at) =>
      ctx.options.onEvent?.({ kind: "secret_field", step, id: field.id, ...times, at, end, ...r })
    // An unsure read: every field "unknown" (never `??`: null is "gone").
    const box = read === undefined ? "unknown" : read.measured[i]
    if (box === "unknown" || box === undefined) {
      // Unsure, just back on its page: its last box comes back (the whole frame without one), as
      // read from the switch (a move's hull then covers from there too). Fails closed.
      if (field.state === "left") {
        report({ ...placed(field.lastBox, field.lastViewport), since: times.shown }, times.shown)
        field.state = "on"
      }
      continue
    }
    if (box === null) {
      // Gone: reported only while its region is open (a removed field is read again and again);
      // a return is dated from the last read that found it gone (T3).
      if (field.state === "on") report({ state: "gone" })
      field.state = "gone"
      field.goneReadAt = times.at
      continue
    }
    // Back on its page: on screen since the run switched to it; back after a "gone": since the
    // last read that found it gone.
    const since =
      field.state === "left" ? times.shown : field.state === "gone" ? field.goneReadAt : undefined
    report({ ...placed(box, read?.viewport), ...(since !== undefined && { since }) })
    field.state = "on"
    // Its last placement: a box with the viewport it was measured in; without one, none (an
    // unsure return then falls back to the whole frame, never to an older, stale box).
    field.lastBox = read?.viewport === undefined ? undefined : box
    field.lastViewport = read?.viewport
  }
}

/**
 * A box to report: where it was measured, or the whole frame when there's no usable box or no
 * viewport to place it in (fails closed: a box normalized in another page's viewport would miss).
 */
export function placed(
  box: Box | undefined,
  viewport: Viewport | undefined,
): Extract<RegionReport, { state: "at" }> {
  if (box === undefined || viewport === undefined || !usableBox(box)) {
    return { state: "at", ...WHOLE_FRAME }
  }
  return { state: "at", box, viewport }
}

/** The whole frame, as a box in its own unit viewport (the fallback without a placed box). */
export const WHOLE_FRAME = {
  box: { x: 0, y: 0, width: 1, height: 1 },
  viewport: { width: 1, height: 1 },
} as const

/** A page's viewport, or undefined when it can't be read within `ms` (the timer cleared). */
export async function viewportWithin(page: Page, ms: number): Promise<Viewport | undefined> {
  const fixed = page.viewportSize()
  if (fixed !== null) return fixed
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    viewportOf(page).catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** A box that shows something (the one definition of "no size": gone at the source). */
export function usableBox(box: Box): boolean {
  return Number.isFinite(box.x + box.y + box.width + box.height) && box.width > 0 && box.height > 0
}

/**
 * The capture left the fields' page (T4): their open regions are left now (they last until the
 * next page's first frame), then the fields of pages that closed are dropped (their handles
 * released). No read of any page: a stuck page never keeps them open.
 */
export function leaveSecretFields(ctx: Ctx, step: StepRef): void {
  const t = now()
  for (const field of ctx.secretFields) {
    if (field.page === ctx.page || field.state !== "on") continue
    field.state = "left"
    ctx.options.onEvent?.({
      kind: "secret_field",
      step,
      id: field.id,
      at: t,
      end: t,
      shown: ctx.pageShownAt,
      state: "left",
    })
  }
  for (const field of ctx.secretFields.filter((f) => f.page.isClosed())) {
    ctx.secretFields.splice(ctx.secretFields.indexOf(field), 1)
    void field.handle?.dispose().catch(() => undefined)
  }
}

/**
 * T2: the end of a read of `page`: when the page has run two rendering updates since (a busy page
 * can't draw before its task is done, so frames after it show at least what the read saw).
 * Undefined when it didn't draw within a second (a throttled or closing page: the read is unsure).
 */
export async function drawnSince(page: Page): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const drew = await Promise.race([
    page
      .evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            // A hidden page draws no frames (nothing to film until it shows, and then from the
            // DOM of that moment): drawn as of now.
            if (document.visibilityState !== "visible") {
              resolve(true)
              return
            }
            const t = setTimeout(() => resolve(false), 1000)
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                clearTimeout(t)
                resolve(true)
              }),
            )
          }),
      )
      .catch(() => false),
    // A frozen page never runs the timer above: bounded here too (never hangs a step or the run).
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 1200)
    }),
  ]).finally(() => clearTimeout(timer))
  return drew ? now() : undefined
}

/** How often the page is scanned for secret text while recording. */
export const TEXT_SCAN_MS = 300
/** How long a read may take in all (a scan, a field read: a frozen page makes it unsure). */
const READ_TIMEOUT_MS = 3500

/**
 * A read of `page` bounded in time: undefined (unsure) when it took longer than READ_TIMEOUT_MS.
 * While one that took too long is still pending in the page, no new read of it starts (they'd pile
 * up in a frozen page's queue and all run when it wakes): those are unsure too.
 */
export async function boundedRead<T>(
  ctx: Pick<Ctx, "stuckReads">,
  page: Page,
  read: () => Promise<T>,
): Promise<T | undefined> {
  if ((ctx.stuckReads.get(page) ?? 0) > 0) return undefined
  const pending = read()
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    pending.then((value) => ({ value })),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), READ_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
  if (result !== undefined) return result.value
  // Only this page's reads wait (a stuck opener never blinds the reads of a popup), until every
  // read of it that took too long has settled.
  ctx.stuckReads.set(page, (ctx.stuckReads.get(page) ?? 0) + 1)
  void pending
    .catch(() => undefined)
    .finally(() => ctx.stuckReads.set(page, (ctx.stuckReads.get(page) ?? 1) - 1))
  return undefined
}

/**
 * The capture left the page (T4): its text regions are left now (they last until the next page's
 * first frame). A later scan of the page, back on it, finds them again.
 */
export function leaveSecretText(ctx: Ctx, step: StepRef): void {
  const state = ctx.secretText
  const t = now()
  for (const id of state.shown.values()) {
    ctx.options.onEvent?.({
      kind: "secret_text",
      step,
      id,
      at: t,
      end: t,
      shown: ctx.pageShownAt,
      state: "left",
    })
  }
  state.shown.clear()
}

/**
 * Secret values shown as text on the driven page (DOM-text scan, `scanner.ts`). A region is one
 * exact box: it keeps its id while the box stays, and ends when the box is gone. A new box is a new
 * region (ids are never reused), blurred from the previous scan (it may have appeared right after
 * it). An unsure occurrence (re-rendered mid-scan) ends nothing that scan; a failed scan changes
 * nothing. `fresh`: a scan that starts now (a running one read the page earlier). Never fails.
 */
export async function followSecretText(
  ctx: Ctx,
  step: StepRef,
  fresh = false,
  of?: ReadOf,
): Promise<void> {
  const state = ctx.secretText
  if (state.inflight !== undefined) {
    await state.inflight
    if (!fresh) return
  }
  const run = async () => {
    const started = now()
    const page = of?.page ?? ctx.page
    const shown = of?.shown ?? ctx.pageShownAt
    // A value new to the scan (resolved just now) may have been on screen all along: its first
    // regions are blurred from the run's start (over-blurring that box is safe).
    if (ctx.secretValues.size !== state.values) {
      state.values = ctx.secretValues.size
      state.lastScan = state.runStart
    }
    if (ctx.secretValues.size === 0 || page.isClosed()) return
    // Bounded as a whole: a frozen page never hangs the step (or the end of the run), and what a
    // scan read is used only if it finished in time. (A switch waits for this scan: what it saw
    // of its page is reported, never dropped.)
    const scanned = await boundedRead(ctx, page, async () => {
      const boxes = await scanSecretTextPartly(page, ctx.secretValues).catch(() => undefined)
      if (boxes === undefined) return undefined
      const viewport = await viewportOf(page).catch(() => undefined)
      // T2: the read's end, once the page drew what it read (else unsure: nothing changes).
      const end = await drawnSince(page)
      return end === undefined ? undefined : { boxes, viewport, end }
    })
    if (scanned === undefined) return
    const { boxes, viewport, end } = scanned
    const read = { at: started, end, shown }
    const current = new Map<string, Box>()
    for (const b of boxes) if (b !== null) current.set(`${b.x},${b.y},${b.width},${b.height}`, b)
    for (const [key, box] of current) {
      if (state.shown.has(key)) continue
      const id = `text:${state.next++}`
      state.shown.set(key, id)
      ctx.options.onEvent?.({
        kind: "secret_text",
        step,
        id,
        ...read,
        ...placed(box, viewport),
        since: state.lastScan,
      })
    }
    // Unsure about one: the others' boxes may be it, re-rendered. End nothing this time, and the
    // next scan's new regions are still blurred from before this one.
    if (boxes.some((b) => b === null)) return
    for (const [key, id] of state.shown) {
      if (current.has(key)) continue
      state.shown.delete(key)
      ctx.options.onEvent?.({ kind: "secret_text", step, id, ...read, state: "gone" })
    }
    state.lastScan = started
  }
  state.inflight = run()
    .catch(() => undefined)
    .finally(() => (state.inflight = undefined))
  await state.inflight
}

/**
 * Where a secret field is now: the written element itself while it's in the page (its handle), else
 * the target as the type step found it (a re-mounted field).
 */
async function measureSecretField(
  field: Ctx["secretFields"][number],
): Promise<Box | null | "unknown"> {
  const handle = field.handle
  let box: Box | null | "unknown"
  if (handle !== undefined && (await handle.evaluate((e) => e.isConnected).catch(() => false))) {
    box = (await handle.boundingBox().catch(() => "unknown" as const)) ?? null
    // Attached but not rendered (a form swapping inputs): a visible twin the target finds counts.
    if (box === null) box = await measureField(field.locator)
  } else box = await measureField(field.locator)
  // A box of no size shows nothing: gone (one definition for the runtime and the regions).
  return box !== null && box !== "unknown" && !usableBox(box) ? null : box
}

/**
 * Where the target finds the field: its box (null when it finds nothing rendered), "unknown" when
 * measuring failed (a timeout): the blur stays. Several matches (a responsive duplicate, the field
 * re-mounted next to another): the union of the rendered ones, fails closed and follows them (never
 * a strict-mode "unknown" that would hold a blur forever).
 */
async function measureField(locator: Locator): Promise<Box | null | "unknown"> {
  try {
    // count() doesn't wait: a field that's gone (after a login submit) costs one round trip, not
    // boundingBox's attach timeout on every later step.
    const n = await locator.count()
    if (n === 0) return null
    if (n === 1) return await locator.boundingBox({ timeout: 300 })
    const boxes = await Promise.all(
      Array.from({ length: Math.min(n, 5) }, (_, i) =>
        locator.nth(i).boundingBox({ timeout: 300 }),
      ),
    )
    const shown = boxes.filter((b): b is Box => b !== null)
    if (shown.length === 0) return null
    return shown.reduce((a, b) => {
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
      }
    })
  } catch {
    return "unknown"
  }
}

async function resolveSecret(
  ctx: Ctx,
  name: string,
  step: StepRef,
  use: SecretUse,
  input: ElementHandle,
): Promise<string> {
  if (ctx.options.resolveSecret === undefined) {
    throw new StepError(
      step,
      "secret-unavailable",
      `secret "${name}" needed but no secret resolver given`,
    )
  }
  const resolve = ctx.options.resolveSecret
  const attempt = async () => {
    const value = await resolve(name, use)
    if (value !== "") ctx.secretValues.add(value)
    return value
  }
  try {
    try {
      return await attempt()
    } catch (error) {
      // No grant yet: an interactive run asks the user once, with the element to outline.
      const ask = ctx.options.requestApproval
      if (!isSecretRefusal(error) || error.reason !== "no-grant" || ask === undefined) throw error
      const box = (await input.boundingBox().catch(() => null)) ?? undefined
      const shot = await pageShot(ctx.page)
      if (!(await guard(step, async () => ask({ secret: name, use, box, shot })))) {
        throw new StepError(
          step,
          "secret-declined",
          `the user declined typing secret "${name}" here`,
        )
      }
      return await attempt()
    }
  } catch (error) {
    if (error instanceof StepError) throw error
    // The vault's refusals say why (origin, grant) and never hold a value; any other error's
    // message could contain one: never included.
    if (isSecretRefusal(error)) {
      throw new StepError(step, "secret-refused", firstLine(error.message))
    }
    throw new StepError(step, "secret-unavailable", `secret "${name}" is unavailable`)
  }
}

/**
 * The viewport as it is, for an approval prompt (undefined if it can't be taken): the user's own
 * screen, shown to them only (APPROACHES §0: never masked; it never reaches the agent or a take).
 */
async function pageShot(page: Page): Promise<ApprovalRequest["shot"]> {
  const size = page.viewportSize()
  if (size === null) return undefined
  const jpeg = await page
    .screenshot({ type: "jpeg", quality: 75, timeout: 3000, caret: "initial", animations: "allow" })
    .catch(() => undefined)
  if (jpeg === undefined) return undefined
  return { jpeg: jpeg.toString("base64"), width: size.width, height: size.height }
}

/** How `value` appears in a URL path (WHATWG path percent-encoding), or undefined if it can't. */
function urlPath(value: string): string | undefined {
  // Per character, never through the URL parser: it would cut the value at ? or # and resolve ".."
  // (a secret "p#Kd93!x" must not become the pattern "p").
  try {
    return value.replace(/[^\x21-\x7e]|["#<>?`{}]/gu, (c) => encodeURIComponent(c))
  } catch {
    return undefined
  }
}

/**
 * Replaces every known secret value in `text` (as-is and in its common encodings: URL-encoded,
 * form-encoded, base64, JSON-escaped, HTML-escaped) with `[secret]`, ignoring case. A value split by
 * whitespace or line breaks (page text across DOM nodes, an accessibility snapshot) is matched too.
 */
export function scrubSecrets(text: string, values: Iterable<string>): string {
  return secretScrubber(values)(text)
}

/** `scrubSecrets` for many texts: the values' variants and their pattern built once. */
export function secretScrubber(values: Iterable<string>): (text: string) => string {
  const list = [...values]
  const variants = new Set<string>()
  const encode = (f: (s: string) => string, s: string): string | undefined => {
    try {
      return f(s)
    } catch {
      return undefined // a lone surrogate can't be URI-encoded: the raw value is still matched
    }
  }
  for (const value of list) {
    const component = encode(encodeURIComponent, value)
    // WHATWG application/x-www-form-urlencoded (what browsers use for GET forms): also encodes !'()~
    const form = new URLSearchParams({ v: value }).toString().slice(2)
    const base64 = Buffer.from(value).toString("base64")
    const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    for (const v of [
      value,
      component,
      component?.replace(/%20/g, "+"),
      form,
      // Encoded twice (a URL inside a `?next=` / `?return=` parameter).
      component === undefined ? undefined : encode(encodeURIComponent, component),
      encode(encodeURIComponent, form),
      encode(encodeURI, value),
      // WHATWG path encoding (what a URL's pathname holds): leaves |[]^ as they are, unlike encodeURI.
      urlPath(value),
      base64,
      encode(encodeURIComponent, base64),
      base64url,
      JSON.stringify(value).slice(1, -1),
      htmlEscape(value, "&#39;"),
      htmlEscape(value, "&#x27;"),
      // What serializers actually escape: text (& < >) or attribute values (& ").
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      value.replace(/&/g, "&amp;").replace(/"/g, "&quot;"),
    ]) {
      if (v !== undefined && v !== "") variants.add(v)
    }
  }
  if (variants.size === 0) return (text) => text
  // Patterns with the length of the text they can match (a split value: its characters, at least).
  const patterns: { source: string; length: number }[] = [...variants].map((v) => ({
    source: escapeRegExp(v),
    length: v.length,
  }))
  // Split by whitespace: the raw values only (at least 4 characters, not to eat ordinary words),
  // each character optionally followed by whitespace.
  for (const v of list) {
    const chars = [...v.replace(/\s/g, "")]
    if (chars.length >= 4)
      patterns.push({ source: chars.map(escapeRegExp).join("\\s*"), length: v.length })
  }
  // One pass over one alternation of every pattern, longest first: a secret that contains another
  // ("bob@acme.com", "bob"), even split by whitespace, is replaced whole, and a replacement is never
  // re-scanned (no "[[sec]ret]"). Case-insensitive: percent-encodings are (%2F = %2f), and
  // over-scrubbing is safe.
  const alternation = patterns
    .sort((a, b) => b.length - a.length)
    .map((p) => p.source)
    .join("|")
  const pattern = new RegExp(alternation, "giu")
  return (text) => text.replace(pattern, "[secret]")
}

function htmlEscape(value: string, apostrophe: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, apostrophe)
}

/** `https://host/path?query#hash` → `https://host/path` (non-URLs are returned as they are). */
export function pathOnly(url: string): string {
  const parsed = URL.parse(url)
  if (parsed === null) return url
  // blob:, data:, about:, javascript:… have no meaningful origin/path: only the scheme is kept
  // (never a data: payload).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol
  return `${parsed.origin}${parsed.pathname}`
}

/**
 * A secret is typed only on a listed app's exact origin (a redirect may have left them, e.g. SSO;
 * never a `www.` alias). Which app's: the resolver's to say (the vault checks the secret's own
 * origins; `resolveSecret` must refuse any other).
 */
export function assertSecretOrigin(ctx: Ctx, secret: string | undefined, step: StepRef) {
  if (secret === undefined) return
  const origin = new URL(ctx.page.url()).origin
  if (appAtOrigin(ctx.apps, origin) === undefined) {
    throw new StepError(step, "off-origin", `refusing to type secret "${secret}" on ${origin}`)
  }
}

/**
 * The input or textarea a secret would be written to (runs in the page): the target itself must be
 * focused (a web component: its host, then the focused element in its shadow root). Null otherwise.
 */
function secretInputOf(el: Element): HTMLInputElement | HTMLTextAreaElement | null {
  const root = el.getRootNode()
  const active = root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null
  if (active !== el) return null
  let inner: Element = el
  while (inner.shadowRoot?.activeElement) inner = inner.shadowRoot.activeElement
  return inner instanceof HTMLInputElement || inner instanceof HTMLTextAreaElement ? inner : null
}

/** The same error with its message (and a StepError's detail) scrubbed of secret values; no cause kept. */
export function scrubError(error: Error, secrets: Set<string>): Error {
  if (secrets.size === 0) return error
  // Rebuilt even when the message is clean: the cause (Playwright's full call log) could hold a secret.
  const message = scrubSecrets(error.message, secrets)
  if (error instanceof StepError)
    return new StepError(error.step, error.reason, scrubSecrets(error.detail, secrets))
  const scrubbed = new Error(message)
  scrubbed.name = error.name // e.g. TimeoutError: callers may branch on it
  return scrubbed
}

/** A secret about to be written: the approved element (a handle), the value, and the use. */
export interface SecretWrite {
  secret: string
  /** The secret field the blur follows (recording): its entry, not its id (ids can repeat). */
  field?: Ctx["secretFields"][number] | undefined
  input: ElementHandle<HTMLInputElement | HTMLTextAreaElement>
  value: string
  use: SecretUse
}

/**
 * Follows a field a secret is typed into until the end of the take (recording): its blur rect
 * moves with it. Returns the id of its sensitive region.
 */
export function followSecretField(
  ctx: Ctx,
  step: StepRef,
  secret: string,
  target: Locator,
): { id: string; field: Ctx["secretFields"][number] | undefined } {
  // Unique per write (an `ensure` replays several steps under one index): one region per field.
  const id = `secret:${secret}:${step.phase}:${step.index}${step.interrupt === undefined ? "" : `:${step.interrupt}`}:${ctx.secretFieldCount++}`
  if (ctx.options.recording !== true) return { id, field: undefined }
  const field: Ctx["secretFields"][number] = {
    id,
    locator: target,
    page: ctx.page,
    state: "pending",
  }
  ctx.secretFields.push(field)
  return { id, field }
}

/**
 * The approvals a step's secret use falls under (SECRETS-DESIGN §3 A1): its scope (the host's
 * project id; the org, for an org interrupt rule) and its step key. The scene part is the host's
 * id for the scene (a deleted scene's replacement gets another one, even with the same ids).
 * Without the host's ids the use is refused: never a shared default.
 */
function approvalKeyOf(
  ctx: Ctx,
  step: StepRef,
  secret: string,
): { scope: string; stepKey: string } {
  const { scope, sceneId, orgInterrupts: org } = ctx.options
  const missing = (what: string) =>
    new StepError(
      step,
      "secret-refused",
      `secret "${secret}": no ${what} from the host (approvals need it)`,
    )
  if (step.interrupt !== undefined && org !== undefined && org.ruleIds.includes(step.interrupt)) {
    return { scope: `org:${org.orgId}`, stepKey: `org:${org.orgId}/interrupt:${step.interrupt}` }
  }
  if (scope === undefined || scope === "") throw missing("project scope")
  if (step.interrupt !== undefined) return { scope, stepKey: `interrupt:${step.interrupt}` }
  // Approvals are keyed by the step's id (the schema requires one; a scenario built in code may not).
  if (step.stepId === undefined || step.stepId === "") {
    throw new StepError(
      step,
      "secret-refused",
      `secret "${secret}": a step typing a secret needs an id`,
    )
  }
  if (step.preset !== undefined)
    return { scope, stepKey: `preset:${step.preset}/${step.stepId ?? ""}` }
  if (sceneId === undefined || sceneId === "") throw missing("scene id")
  if (!SceneId.safeParse(sceneId).success) {
    throw new StepError(
      step,
      "secret-refused",
      `secret "${secret}": the host's scene id "${sceneId}" isn't a scene id (kebab-case)`,
    )
  }
  return { scope, stepKey: `scene:${sceneId}/${step.keyPhase ?? step.phase}/${step.stepId ?? ""}` }
}

/**
 * What a grant binds as the target (§3 A1, A6): the step's canonical target; for an interrupt
 * rule, its `when` too (a rule approved for a "Session expired" modal can't be retargeted).
 */
function grantedTarget(ctx: Ctx, step: StepRef, target: GroundedTarget): string {
  const canonical = canonicalTarget(target)
  if (step.interrupt === undefined) return canonical
  const rule = ctx.interrupts.find((r) => r.id === step.interrupt)
  const when =
    rule === undefined
      ? null
      : "by" in rule.when
        ? canonicalTarget(rule.when)
        : JSON.stringify({ text: rule.when.text })
  return JSON.stringify({ do: canonical, when })
}

/** What an element a secret goes into is: tag, type, and its label (never a placeholder). */
type ElementInfo = { tag: "input" | "textarea"; type: string; label: string | null }

/**
 * The page side of a secret write (runs in the page): the element's info, and, given the approved
 * info and a value, the check and the write in one synchronous turn (nothing the page does can come
 * between them: a "show password" toggle, a script changing the type). Sets the value through the
 * prototype's setter, then the events a framework listens to; returns what the field holds.
 */
function fieldWrite(
  el: HTMLInputElement | HTMLTextAreaElement,
  arg: { expected?: ElementInfo; value?: string },
): { info: ElementInfo; written: boolean; landed?: string } {
  const text = (s: string | null | undefined) => {
    const t = s?.replace(/\s+/g, " ").trim().slice(0, 200)
    return t === undefined || t === "" ? null : t
  }
  // The accessible name's order: aria-labelledby, then aria-label, then a <label>; rendered text
  // only (hidden text isn't part of it); never a placeholder (apps localize or change it).
  const rendered = (n: Element | null | undefined) =>
    n instanceof HTMLElement ? n.innerText : n?.textContent
  const labelledBy = el.getAttribute("aria-labelledby")
  const root = el.getRootNode() as Document | ShadowRoot
  const label =
    (labelledBy === null
      ? null
      : text(
          labelledBy
            .split(/\s+/)
            .map((id) => rendered(root.getElementById?.(id)) ?? "")
            .join(" "),
        )) ??
    text(el.getAttribute("aria-label")) ??
    text(rendered(el.labels?.[0]))
  const info: ElementInfo =
    el instanceof HTMLInputElement
      ? { tag: "input", type: el.type, label }
      : { tag: "textarea", type: "textarea", label }
  const { expected, value } = arg
  if (expected === undefined || value === undefined) return { info, written: false }
  // Every key of the approved info (a key added to ElementInfo is compared too).
  for (const key of Object.keys(expected) as (keyof ElementInfo)[]) {
    if (info[key] !== expected[key]) return { info, written: false }
  }
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  // The prototype's setter: a framework's own (React) tracks the value through it.
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value)
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { info, written: true, landed: el.value }
}

/**
 * The element a secret goes into and its value, resolved now (the field is focused). The target
 * itself (or the input in its shadow root), never another field inside it: the one focused before
 * could be a visible text box. Only an input or a textarea (a value written as a whole). A handle is
 * bound to its document, so a navigation (another origin, another page) can't swap it between the
 * checks and the write. The use is what the vault checks against the user's grants; an interactive
 * run asks the user once when there's none yet (§3 A3).
 */
export async function prepareSecretWrite(
  ctx: Ctx,
  target: Locator,
  step: StepRef,
  secret: string,
  stepTarget: Target,
): Promise<SecretWrite> {
  const timeout = ctx.timeoutMs
  const handle = await target.evaluateHandle(secretInputOf, undefined, { timeout })
  const input = handle.asElement() as ElementHandle<HTMLInputElement | HTMLTextAreaElement> | null
  if (input === null) {
    await handle.dispose()
    throw new StepError(
      step,
      "action-failed",
      `secret "${secret}" goes into an input or a textarea itself: use a locator for the field, not a container`,
    )
  }
  try {
    if (!isGrounded(stepTarget)) throw new StepError(step, "not-grounded", "target not grounded")
    const url = new URL(ctx.page.url())
    const use: SecretUse = {
      ...approvalKeyOf(ctx, step, secret),
      origin: url.origin,
      path: url.pathname,
      target: grantedTarget(ctx, step, stepTarget),
      element: (await input.evaluate(fieldWrite, {})).info,
    }
    const value = await resolveSecret(ctx, secret, step, use, input)
    return { secret, input, value, use }
  } catch (error) {
    await input.dispose().catch(() => undefined)
    throw error
  }
}

/**
 * Writes the secret into the approved element itself, not to whatever has focus now (focus may
 * have moved while the vault resolved it: a keychain prompt, an autofocus script). A handle whose
 * document was replaced throws: nothing is written anywhere; the origin and path are checked again
 * right before (a `pushState` doesn't replace the document). Appended to what the field holds,
 * like typing. The element is remembered: nothing is copied or dragged out of it (§3 A5).
 */
export async function writeSecret(
  ctx: Ctx,
  write: SecretWrite,
  step: StepRef,
  timeout: number,
): Promise<void> {
  try {
    const before = await write.input.inputValue({ timeout })
    // Actionable first, so `fill` doesn't wait itself: then the page's URL last (a `pushState`
    // doesn't detach the handle), and nothing awaits between it and the write but the write.
    await write.input.waitForElementState("visible", { timeout })
    await write.input.waitForElementState("editable", { timeout })
    const now = new URL(ctx.page.url())
    if (now.origin !== write.use.origin || now.pathname !== write.use.path) {
      throw new StepError(
        step,
        "off-origin",
        `the page moved to ${now.origin}${now.pathname} while the secret was resolved`,
      )
    }
    // Checked against the approved element and written in one page turn: the approval prompt or
    // the keychain may have taken seconds, and a "show password" toggle (or the page) may have
    // turned it into a text field meanwhile. Never typed: `fill` sends the text to whatever has
    // focus, which a page can move.
    const wanted = before + write.value
    const result = await write.input.evaluate(fieldWrite, {
      expected: write.use.element,
      value: wanted,
    })
    if (!result.written) {
      throw new StepError(step, "secret-refused", "the field changed while the secret was resolved")
    }
    // Read back in a later turn: a framework that resets or reformats the field in its own
    // microtask or frame (Vue's nextTick, Lit's update) is caught. A field that submitted or
    // navigated on input can't be read again: the page took the value, as read in the write's turn.
    const landed = await write.input
      .evaluate((el) => el.value)
      .catch((error: unknown) => {
        if (isNavigationError(error) || ctx.page.isClosed()) return result.landed
        throw error
      })
    // Whatever it holds now may be part of the secret: the field counts as holding one (A5, A8).
    ctx.secretWritten.push({ page: ctx.page, handle: write.input })
    if (write.field !== undefined) write.field.handle = write.input
    if (landed !== wanted) {
      throw new StepError(
        step,
        "action-failed",
        `secret "${write.secret}": the field didn't take the value`,
      )
    }
  } catch (error) {
    // Released unless it's followed as a field holding a secret.
    if (!ctx.secretWritten.some((w) => w.handle === write.input)) {
      await write.input.dispose().catch(() => undefined)
    }
    throw error
  }
}

/**
 * A shortcut as a set of normalized parts ("ControlOrMeta+Shift+KeyV" → mod, shift, v): every
 * spelling Playwright accepts for a key (aliases, left/right variants, `Key…` code names) is the
 * same part, so no spelling slips past the refusals.
 */
function chord(keys: string): Set<string> {
  const part = (raw: string) => {
    let k = raw.trim().toLowerCase()
    if (k === "controlormeta" || k === "cmdorctrl" || k === "commandorcontrol") return "mod"
    k = k.replace(/(left|right)$/, "")
    if (k === "ctrl") return "control"
    if (k === "cmd" || k === "command" || k === "os") return "meta"
    if (/^key[a-z]$/.test(k)) return k.slice(3)
    return k
  }
  return new Set(keys.split("+").map(part))
}
const hasCommand = (c: Set<string>) => c.has("mod") || c.has("control") || c.has("meta")
/**
 * Pastes, in every form: Mod/Ctrl/Meta+V, Shift+Insert, and Ctrl+Y (macOS "yank": what Ctrl+K
 * "killed" out of a field; on Windows it's redo, refused too while secrets are known).
 */
const isPasteLike = (c: Set<string>) =>
  (hasCommand(c) && (c.has("v") || c.has("y"))) || (c.has("shift") && c.has("insert"))
/**
 * The only keys pressed while focus is in a field holding a secret: an allowlist, not a denylist
 * (copy, cut, select, kill: text-editing commands differ per platform and keep growing).
 */
const ALLOWED_IN_SECRET_FIELD = new Set(["enter", "tab", "shift+tab", "escape"])
const chordName = (c: Set<string>) =>
  [...c].sort((a, b) => (a === "shift" ? -1 : b === "shift" ? 1 : a < b ? -1 : 1)).join("+")

/** Whether a text contains a known value (in Node: values never go to the page). */
const containsKnown = (ctx: Ctx, text: string | null | undefined) =>
  containsKnownValue(ctx.secretValues, text)

const writtenHere = (ctx: Ctx) => liveWritten(ctx.page)

/**
 * Where focus is (runs in the page): whether it's in one of the written elements, and the focused
 * field's value and the selected text (page text, read into Node, where it's matched).
 */
function focusedText(written: Element[]): {
  inWritten: boolean
  value: string | null
  selection: string
} {
  let active: Element | null = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  let inWritten = false
  for (let at: Node | null = active; at !== null && !inWritten;) {
    inWritten = written.includes(at as Element)
    at = at.parentNode ?? (at instanceof ShadowRoot ? at.host : null)
  }
  const value =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.value
      : null
  return { inWritten, value, selection: getSelection()?.toString() ?? "" }
}

/**
 * SECRETS-DESIGN §3 A5. While secrets are known: no paste in any form (an app's own "Copy" button
 * may have put a value in the clipboard), and, while focus is in a field holding a secret (one it
 * was written to, or any field whose value or selection contains a known value: a re-mounted
 * input keeps its value), only Enter, Tab, Shift+Tab and Escape.
 */
export async function assertKeysKeepSecrets(ctx: Ctx, step: StepRef, keys: string): Promise<void> {
  if (ctx.secretValues.size === 0) return
  const c = chord(keys)
  if (isPasteLike(c)) {
    throw new StepError(
      step,
      "secret-refused",
      `no paste ("${keys}") in a scene that knows a secret: type the text instead`,
    )
  }
  if (ALLOWED_IN_SECRET_FIELD.has(chordName(c))) return
  const read = async () => ctx.page.evaluate(focusedText, await writtenHere(ctx))
  // A navigation committing (execution context destroyed): once more on the new document.
  const focus = await read().catch(async () => {
    await ctx.page
      .waitForLoadState("domcontentloaded", { timeout: ctx.timeoutMs })
      .catch(() => undefined)
    return read().catch(() => undefined)
  })
  // Unsure where focus is: refused (fails closed).
  if (
    focus === undefined ||
    focus.inWritten ||
    containsKnown(ctx, focus.value) ||
    containsKnown(ctx, focus.selection)
  ) {
    throw new StepError(
      step,
      "secret-refused",
      `"${keys}" in a field holding a secret: only Enter, Tab or Escape there (click elsewhere first)`,
    )
  }
}

/**
 * §3 A5: nothing is dragged out of an element holding a secret: one it was written to, or one
 * containing a field whose value contains a known value (across shadow roots).
 */
export async function assertDragKeepsSecrets(
  ctx: Ctx,
  step: StepRef,
  source: Locator,
): Promise<void> {
  if (ctx.secretValues.size === 0) return
  const written = await writtenHere(ctx)
  const found = await source
    .evaluate(
      (src, elements) => {
        const values: string[] = []
        let holds = false
        const visit = (n: Node) => {
          if (elements.includes(n as Element)) holds = true
          if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement)
            values.push(n.value)
          if (n instanceof Element && n.shadowRoot !== null) n.shadowRoot.childNodes.forEach(visit)
          n.childNodes.forEach(visit)
        }
        visit(src)
        return { holds, values }
      },
      written,
      { timeout: ctx.timeoutMs },
    )
    .catch(() => undefined)
  if (found === undefined || found.holds || found.values.some((v) => containsKnown(ctx, v))) {
    throw new StepError(step, "secret-refused", "this drag would move a field holding a secret")
  }
}

/** Releases a prepared write that won't happen (the step failed before it). */
export async function abandonSecretWrite(write: SecretWrite | undefined): Promise<void> {
  await write?.input.dispose().catch(() => undefined)
}

/** A secret step's target has no fallbacks, no `nth` and no row (§3 A2: the page picks a row). */
export function assertSecretTarget(target: Target, step: StepRef, secret: string): void {
  // Its locator is re-run after the write (to follow the field's blur): always the A8 grammar.
  if (isGrounded(target) && target.by === "css" && !isSafeSelector(target.selector)) {
    throw new StepError(
      step,
      "secret-refused",
      `secret "${secret}": a step typing a secret needs a simple CSS selector (${SAFE_SELECTOR_RULES})`,
    )
  }
  if (
    isGrounded(target) &&
    (target.fallbacks !== undefined || target.nth !== undefined || target.in !== undefined)
  ) {
    throw new StepError(
      step,
      "secret-refused",
      `secret "${secret}": a step typing a secret can't have fallbacks, nth or a row (in)`,
    )
  }
}
