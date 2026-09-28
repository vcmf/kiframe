import type { ElementHandle, Locator } from "playwright"
import { isSecretRefusal, type SecretUse, StepError, type StepRef } from "../errors.ts"
import type { Box } from "../motion.ts"
import { escapeRegExp, scanSecretTextPartly } from "../scanner.ts"
import { viewportOf } from "../targets.ts"
import { type Ctx, firstLine } from "./context.ts"

// Everything about secret values: resolution, origin checks, the scrubber, field tracking and the text scan.

/**
 * Re-measures every field a secret was typed into and reports when it moved (the blur follows it)
 * or is gone (navigated away, removed: nothing left to blur). Only changes are reported. Bounded,
 * never fails a step.
 */
export async function followSecretFields(
  ctx: Ctx,
  step: StepRef,
  which: "all" | "here" | "elsewhere" = "all",
): Promise<void> {
  const fields = ctx.secretFields.filter(
    (f) => which === "all" || (which === "here") === (f.page === ctx.page),
  )
  if (fields.length === 0) return
  // In parallel: every field costs a round trip or two after each step.
  // A field on another page (the run followed a tab or popup) isn't on screen: its blur ends,
  // and comes back if the run returns to that page.
  const measured = await Promise.all(
    fields.map((field) =>
      field.page === ctx.page ? measureField(field.locator) : Promise.resolve(null),
    ),
  )
  const viewport = await viewportOf(ctx.page).catch(() => undefined)
  for (const [i, field] of fields.entries()) {
    let box = measured[i]
    const elsewhere = field.page !== ctx.page
    // Unsure, just back on its page: the last real rect comes back (fails closed). Otherwise an
    // unsure measurement keeps the current rect; only a field known to be gone ends its blur.
    if (box === "unknown" && field.away === true && !elsewhere) box = field.lastBox ?? "unknown"
    if (box === undefined || box === "unknown") continue
    field.away = elsewhere
    if (box !== null) field.lastBox = box
    const key = box === null ? "gone" : `${box.x},${box.y},${box.width},${box.height}`
    if (key === field.last) continue
    field.last = key
    ctx.options.onEvent?.({
      kind: "secret_field",
      step,
      id: field.id,
      box: box ?? undefined,
      viewport,
    })
  }
}

/** How often the page is scanned for secret text while recording, and how long a scan may take. */
export const TEXT_SCAN_MS = 300
const SCAN_TIMEOUT_MS = 2000

/**
 * Secret values shown as text on the driven page (DOM-text scan, `scanner.ts`). A region is one
 * exact box: it keeps its id while the box stays, and ends when the box is gone. A new box is a new
 * region (ids are never reused), blurred from the previous scan (it may have appeared right after
 * it). An unsure occurrence (re-rendered mid-scan) ends nothing that scan; a failed scan changes
 * nothing. `fresh`: a scan that starts now (a running one read the page earlier). Never fails.
 */
export async function followSecretText(ctx: Ctx, step: StepRef, fresh = false): Promise<void> {
  const state = ctx.secretText
  if (state.inflight !== undefined) {
    await state.inflight
    if (!fresh) return
  }
  const run = async () => {
    const started = Date.now()
    // A value new to the scan (resolved just now) may have been on screen all along: its first
    // regions are blurred from the run's start (over-blurring that box is safe).
    if (ctx.secretValues.size !== state.values) {
      state.values = ctx.secretValues.size
      state.lastScan = state.runStart
    }
    if (ctx.secretValues.size === 0 || ctx.page.isClosed()) return
    const page = ctx.page
    // Bounded: a frozen page never hangs the step (or the end of the run) waiting for a scan.
    let timer: ReturnType<typeof setTimeout> | undefined
    const boxes = await Promise.race([
      scanSecretTextPartly(page, ctx.secretValues),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SCAN_TIMEOUT_MS)
      }),
    ])
      .catch(() => undefined)
      .finally(() => clearTimeout(timer))
    if (boxes === undefined || page !== ctx.page) return
    const viewport = await viewportOf(page).catch(() => undefined)
    const current = new Map<string, Box>()
    for (const b of boxes) if (b !== null) current.set(`${b.x},${b.y},${b.width},${b.height}`, b)
    for (const [key, box] of current) {
      if (state.shown.has(key)) continue
      const id = `text:${state.next++}`
      state.shown.set(key, id)
      ctx.options.onEvent?.({ kind: "secret_text", step, id, box, viewport, since: state.lastScan })
    }
    // Unsure about one: the others' boxes may be it, re-rendered. End nothing this time, and the
    // next scan's new regions are still blurred from before this one.
    if (boxes.some((b) => b === null)) return
    for (const [key, id] of state.shown) {
      if (current.has(key)) continue
      state.shown.delete(key)
      ctx.options.onEvent?.({ kind: "secret_text", step, id, viewport })
    }
    state.lastScan = started
  }
  state.inflight = run()
    .catch(() => undefined)
    .finally(() => (state.inflight = undefined))
  await state.inflight
}

/**
 * Where a secret field is now: its box, null when it's known to be gone (detached or not rendered),
 * "unknown" when measuring failed (timeout, several matches): the blur stays where it was.
 */
async function measureField(locator: Locator): Promise<Box | null | "unknown"> {
  try {
    // count() doesn't wait: a field that's gone (after a login submit) costs one round trip, not
    // boundingBox's attach timeout on every later step.
    if ((await locator.count()) === 0) return null
    return await locator.boundingBox({ timeout: 300 })
  } catch {
    return "unknown"
  }
}

async function resolveSecret(
  ctx: Ctx,
  name: string,
  step: StepRef,
  use: SecretUse,
): Promise<string> {
  if (ctx.options.resolveSecret === undefined) {
    throw new StepError(
      step,
      "secret-unavailable",
      `secret "${name}" needed but no secret resolver given`,
    )
  }
  try {
    const value = await ctx.options.resolveSecret(name, use)
    if (value !== "") ctx.secretValues.add(value)
    return value
  } catch (error) {
    // The vault's refusals say why (origin, field) and never hold a value; any other error's
    // message could contain one: never included.
    if (isSecretRefusal(error)) {
      throw new StepError(step, "secret-refused", firstLine(error.message))
    }
    throw new StepError(step, "secret-unavailable", `secret "${name}" is unavailable`)
  }
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
  if (variants.size === 0) return text
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
  return text.replace(new RegExp(alternation, "giu"), "[secret]")
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

/** A secret is never typed outside the target app (a redirect may have left it, e.g. SSO). */
export function assertSecretOrigin(ctx: Ctx, secret: string | undefined, step: StepRef) {
  if (secret === undefined) return
  const origin = new URL(ctx.page.url()).origin
  // Always the project's origin, whatever the resolver: the vault then checks the secret's own
  // origins (a secret for another origin, an SSO page, is refused here; BACKLOG).
  if (origin !== ctx.base.origin) {
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

/** A secret about to be written: the approved element (a handle) and the value. */
export interface SecretWrite {
  input: ElementHandle<HTMLInputElement | HTMLTextAreaElement>
  value: string
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
): string {
  const id = `secret:${secret}:${step.phase}:${step.index}${step.interrupt === undefined ? "" : `:${step.interrupt}`}`
  if (ctx.options.recording === true) {
    ctx.secretFields.push({ id, locator: target, page: ctx.page })
  }
  return id
}

/**
 * The element a secret goes into and its value, resolved now (the field is focused). The target
 * itself (or the input in its shadow root), never another field inside it: the one focused before
 * could be a visible text box. Only an input or a textarea (a value written as a whole). A handle is
 * bound to its document, so a navigation (another origin, another page) can't swap it between the
 * checks and the write.
 */
export async function prepareSecretWrite(
  ctx: Ctx,
  target: Locator,
  step: StepRef,
  secret: string,
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
    const inputType = await input.evaluate((el) =>
      el instanceof HTMLInputElement ? el.type : "textarea",
    )
    const value = await resolveSecret(ctx, secret, step, {
      origin: new URL(ctx.page.url()).origin,
      field: { inputType },
    })
    return { input, value }
  } catch (error) {
    await input.dispose().catch(() => undefined)
    throw error
  }
}

/**
 * Writes the secret into the approved element itself, not to whatever has focus now (focus may
 * have moved while the vault resolved it: a keychain prompt, an autofocus script). A handle whose
 * document was replaced throws: nothing is written anywhere. Appended to what the field holds, like
 * typing.
 */
export async function writeSecret(write: SecretWrite, timeout: number): Promise<void> {
  try {
    const before = await write.input.inputValue({ timeout })
    await write.input.fill(before + write.value, { timeout })
  } finally {
    await write.input.dispose().catch(() => undefined)
  }
}
