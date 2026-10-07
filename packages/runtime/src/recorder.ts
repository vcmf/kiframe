import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import {
  CursorSample,
  startAppOf,
  TakeEvent,
  TakeMeta,
  type ProjectConfig,
  type Scenario,
} from "@kiframe/schema"
import type { Page } from "playwright"
import { type StepRef } from "./errors.ts"
import type { Box } from "./motion.ts"
import { Regions } from "./regions.ts"
import type { ReadTimes, RegionReport } from "./run/context.ts"
import { placed as placeBox } from "./run/secrets.ts"
import { firstLine, runScenario, type RunnerEvent, type RunOptions } from "./runner.ts"
import { viewportOf } from "./targets.ts"
import { now } from "./clock.ts"

// The recorder (docs/OBJECT-MODEL.md §3): replays a scenario through the runner while capturing the
// page, and writes a take: frames.webm, events.jsonl, cursor.jsonl, shots/<stepId>.jpg, meta.json.
// Every record is validated against @kiframe/schema before it's written.
//
// Clock: `page.screencast` frame timestamps are epoch milliseconds, the same clock as Date.now()
// (`now()`, Phase 0 finding F1), so frames, runner events, reads and cursor samples share one clock
// (SECRETS-DESIGN T1). t = 0 is the start of the capture.

export interface RecordOptions extends RunOptions {
  /** The take directory to create (must not contain anything worth keeping: it's overwritten). */
  outDir: string
  /** JPEG quality of captured frames, 1–100. Default 85. */
  quality?: number
  /** Keep the individual JPEG frames next to frames.webm (debugging). Default false. */
  keepFrames?: boolean
  /**
   * Encode a failed take's video (debugging: the CLI). Default true. The app's take store drops a
   * failed take's video at once: it passes false (seconds of encoding, and a stop, saved).
   */
  encodeFailed?: boolean
  /** Version string written into meta.json. */
  kiframeVersion?: string
}

export interface Take {
  dir: string
  meta: TakeMeta
  events: TakeEvent[]
  cursor: CursorSample[]
  /** Records that couldn't be written (also saved as warnings.json). */
  warnings: string[]
}

/** Records a scenario into a take directory. Rethrows the runner's error after writing what was captured. */
export async function recordScenario(
  page: Page,
  scenario: Scenario,
  project: ProjectConfig,
  options: RecordOptions,
): Promise<Take> {
  // Record into a fresh hidden SIBLING folder (never inside the take, whatever the trailing slash):
  // it replaces the previous take only once it exists, and is removed if anything goes wrong.
  const finalDir = realTakePath(options.outDir)
  checkReplaceable(finalDir)
  const outDir = join(
    dirname(finalDir),
    `.${basename(finalDir)}.recording-${process.pid}-${Date.now()}`,
  )
  prepareOutDir(outDir)
  let placed = false
  try {
    const framesDir = join(outDir, "frames")
    mkdirSync(framesDir, { recursive: true })
    mkdirSync(join(outDir, "shots"), { recursive: true })

    const viewport = await viewportOf(page)
    // The viewport rects are normalized against: the driven page's (a popup can have its own size).
    let current = viewport
    const recordedAt = new Date()
    // The take's start (T1): frames, reads and events on one clock.
    const t0 = now()
    const at = () => Math.max(0, now() - t0)
    const norm = (x: number, y: number) => ({
      x: clamp01(x / current.width),
      y: clamp01(y / current.height),
    })
    const rect = (b: Box, v: { width: number; height: number } = current) => ({
      x: b.x / v.width,
      y: b.y / v.height,
      w: Math.max(0, b.width / v.width),
      h: Math.max(0, b.height / v.height),
    })

    /** Problems with individual records: kept, never thrown (the runner's callbacks must not throw). */
    const warnings: string[] = []

    // ── frames ──
    const frames: { file: string; t: number }[] = []
    const pendingWrites: Promise<void>[] = []
    // A failed write (disk full…) is recorded and reported after the run, never an unhandled rejection.
    let writeError: Error | undefined
    const track = (p: Promise<void>) =>
      p.catch((error: unknown) => {
        writeError ??= error instanceof Error ? error : new Error(String(error))
      })
    let frameSize: { width: number; height: number } | undefined
    let stopped = false
    let sizeChanged = false
    let lastFrame: Buffer | undefined
    const shotsAwaitingFrame: string[] = []
    const writeShot = (stepId: string, data: Buffer) =>
      pendingWrites.push(track(writeFile(join(outDir, "shots", `${stepId}.jpg`), data)))
    // Device pixels: a headed window on a high-DPI screen gives frames at viewport × DPR (sharp
    // zooms); headless gives CSS resolution whatever is asked (Phase 0 findings F1, F2).
    // Capped at 3, the most a take records (TakeMeta): a 350% display or browser zoom goes above.
    // Without `size`, frames are scaled down to fit a small default box.
    const castSize = async (p: Page, v: { width: number; height: number }) => {
      const dpr = Math.min(3, await p.evaluate(() => window.devicePixelRatio).catch(() => 1))
      return { width: Math.round(v.width * dpr), height: Math.round(v.height * dpr) }
    }
    const castOptions: Parameters<Page["screencast"]["start"]>[0] = {
      size: await castSize(page, viewport),
      quality: options.quality ?? 85,
      onFrame: (frame) => onFrame(frame, 0),
    }
    // Which capture is current (T4): a page's frames arriving after the capture left it are dropped,
    // and the next page's count from the switch.
    let generation = 0
    let switchedAt = 0
    let lastFrameT = 0
    function onFrame({ data, timestamp }: { data: Buffer; timestamp: number }, of: number) {
      // After stop (or a failed stop), late frames are ignored: they'd never be awaited.
      if (stopped || of !== generation) return
      const file = `frame-${String(frames.length).padStart(6, "0")}.jpg`
      // Asynchronous: a synchronous write per frame (~60/s) would stall the cursor and typing loops.
      pendingWrites.push(track(writeFile(join(framesDir, file), data)))
      // Kept in one order (T4): each frame at or after the one before (the video is encoded in this
      // order, and a region's end is found in it), the next page's from the switch.
      lastFrameT = Math.max(0, timestamp - t0, switchedAt, lastFrameT)
      frames.push({ file, t: lastFrameT })
      const size = jpegSize(data)
      if (size !== undefined) {
        if (
          frameSize !== undefined &&
          !sizeChanged &&
          (size.width !== frameSize.width || size.height !== frameSize.height)
        ) {
          sizeChanged = true
          warnings.push(
            `frame size changed mid-take (${frameSize.width}×${frameSize.height} → ${size.width}×${size.height})`,
          )
        }
        frameSize ??= size
      }
      lastFrame = data
      for (const stepId of shotsAwaitingFrame.splice(0)) writeShot(stepId, data)
    }
    // The page being filmed: the runner may follow a tab or popup (and come back), the capture
    // follows it on the same clock (frame timestamps are epoch milliseconds whatever the page).
    let capturing = page
    await capturing.screencast.start(castOptions)
    const onPageSwitch = async (next: Page) => {
      // Frames before now show the previous page: a region of this one starts here at the earliest.
      // After every frame of the page it leaves (one drawn within this millisecond, already kept):
      // the next page's frames come after it, and a left region lasts past it.
      switchedAt = Math.max(at(), lastFrameT + 0.001)
      const of = ++generation
      await capturing.screencast.stop().catch(() => undefined)
      capturing = next
      // The next step's shot must be of this page, not the last frame of the previous one.
      lastFrame = undefined
      // A popup opened at its own size: rects and the capture size follow it (the take warns
      // about the frame-size change).
      current = await viewportOf(next).catch(() => current)
      // A popup that closed right after loading: nothing to film (the runner returns to its
      // opener at the next step boundary).
      await next.screencast
        .start({
          ...castOptions,
          onFrame: (f) => onFrame(f, of),
          size: await castSize(next, current),
        })
        .catch((error: unknown) => {
          if (!next.isClosed()) throw error
        })
    }

    // ── events ──
    const events: TakeEvent[] = []
    const cursor: CursorSample[] = []
    const keyOf = (s: StepRef) => `${s.phase}:${s.index}`
    const base = (s: StepRef) => ({
      t: at(),
      phase: s.phase,
      ...(s.stepId !== undefined && { stepId: s.stepId }),
    })
    const push = (event: unknown) => {
      const parsed = TakeEvent.safeParse(event)
      if (parsed.success) events.push(parsed.data)
      else
        warnings.push(
          `dropped a ${(event as { kind?: string }).kind ?? "?"} event: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        )
    }
    // Secret regions, written once with their spans when the take ends (SECRETS-DESIGN §5).
    const regions = new Regions()
    // A read's report of a region (SECRETS-DESIGN T2–T4), on the take's clock (T1).
    const measured = (
      id: string,
      why: "secret-field" | "secret-text",
      step: StepRef,
      read: ReadTimes & RegionReport,
    ) => {
      const when = {
        start: Math.max(0, read.at - t0),
        end: Math.max(0, read.end - t0),
        floor: Math.max(0, read.shown - t0),
      }
      switch (read.state) {
        case "left":
          // Left with its page (T4): until the next page's first frame, from the capture's own
          // switch time (a leave is sent right after the capture switched).
          regions.leave(id, switchedAt)
          return
        case "gone":
          regions.gone(id, when)
          return
        case "at": {
          const where = {
            phase: step.phase,
            ...(step.stepId !== undefined && { stepId: step.stepId }),
          }
          // T8: padded 4 CSS pixels on each side (glyph edges, sub-pixel moves).
          const { box } = read
          const padded = {
            x: box.x - 4,
            y: box.y - 4,
            width: box.width + 8,
            height: box.height + 8,
          }
          const since = read.since === undefined ? undefined : Math.max(0, read.since - t0)
          regions.seen(id, why, where, when, rect(padded, read.viewport), since)
        }
      }
    }
    const interruptStarts = new Map<string, number>()
    const clickedSteps = new Set<string>()
    const handle = (e: RunnerEvent) => {
      switch (e.kind) {
        case "step_start":
          push({ ...base(e.step), kind: "step_start" })
          // Storyboard / guide shot: the frame at the start of each on-camera step.
          // Before the first frame (first step, no setup) it's the first frame that arrives.
          if (e.step.phase === "steps" && e.step.stepId !== undefined) {
            if (lastFrame !== undefined) writeShot(e.step.stepId, lastFrame)
            else shotsAwaitingFrame.push(e.step.stepId)
          }
          break
        case "step_end":
          if (
            e.step.phase === "steps" &&
            e.step.action === "click" &&
            !clickedSteps.has(keyOf(e.step))
          )
            warnings.push(`no box for the click of ${keyOf(e.step)}: click not logged`)
          push({ ...base(e.step), kind: "step_end" })
          break
        case "navigate":
          push({ ...base(e.step), kind: "navigate", url: e.url })
          break
        case "click":
          clickedSteps.add(keyOf(e.step))
          push({
            ...base(e.step),
            kind: "click",
            point: norm(e.x, e.y),
            rect: rect(e.box),
            button: e.button,
            ...(e.count > 1 && { count: e.count }),
          })
          break
        case "cursor": {
          const sample = CursorSample.safeParse({ t: at(), p: norm(e.x, e.y), pressed: e.pressed })
          if (sample.success) cursor.push(sample.data)
          break
        }
        case "type_start":
        case "type": {
          const kind = e.kind === "type_start" ? "type_start" : "type_end"
          // Only the box measured right now (after focus): a stale one could point at where the field
          // was before a scroll, and the blur would miss the secret.
          const box = e.box
          if (box !== undefined) {
            push({
              ...base(e.step),
              kind,
              rect: rect(box),
              ...(e.secret !== undefined && { secret: e.secret }),
            })
          } else if (e.step.phase === "steps") {
            // Off camera (setup), nothing is filmed: no box there is expected.
            warnings.push(`no box for the ${kind} of ${keyOf(e.step)}: typing not logged`)
          }
          // A field filled from the vault is sensitive: the compositor blurs it. Without a box, the
          // whole frame is marked (fails closed: better a blurred frame than a visible secret).
          if (e.secret !== undefined && e.kind === "type_start") {
            const id = e.sensitiveId ?? `secret:${e.secret}`
            // A box of no size (a field still scaling in) is no box: the whole frame. Read now, on
            // the page the run switched to at `shown` (T3).
            const t = now()
            const read = { at: t, end: t, shown: e.shown ?? t }
            measured(id, "secret-field", e.step, {
              ...read,
              ...placeBox(box, e.viewport),
              since: t,
            })
          }
          break
        }
        case "secret_text":
          // A new region is backdated to the last scan that didn't see it (T3).
          measured(e.id, "secret-text", e.step, e)
          break
        case "secret_field":
          // The blur follows the field (normalized in the viewport it was measured in, before the
          // capture switched).
          measured(e.id, "secret-field", e.step, e)
          break
        case "key":
          push({ ...base(e.step), kind: "key", key: e.keys })
          break
        case "target_fallback":
          break
        case "interrupt_start":
          interruptStarts.set(e.rule, at())
          break
        case "interrupt_end": {
          // The handled span, cut from the video by the clips generator.
          const from = interruptStarts.get(e.rule) ?? at()
          interruptStarts.delete(e.rule)
          push({ ...base(e.step), t: from, kind: "interrupt", rule: e.rule, until: at() })
          break
        }
        case "warning":
          if (!warnings.includes(e.message)) warnings.push(e.message)
          break
      }
    }
    const onEvent = (e: RunnerEvent) => {
      try {
        handle(e)
      } catch (error) {
        warnings.push(`recorder: ${firstLine(error)}`)
      }
      try {
        options.onEvent?.(e)
      } catch (error) {
        // The caller's callback must not break the replay either.
        warnings.push(`onEvent: ${firstLine(error)}`)
      }
    }

    let failure: Error | undefined
    try {
      await runScenario(page, scenario, project, {
        ...options,
        onEvent,
        recording: true,
        onPageSwitch: async (next) => {
          await onPageSwitch(next)
          await options.onPageSwitch?.(next)
        },
      })
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    stopped = true
    await capturing.screencast.stop().catch(() => undefined)
    // Capture time, not disk-flush time.
    const durationMs = Math.max(at(), frames.at(-1)?.t ?? 0)

    // ── files ── (the runner's failure, if any, is the error that's thrown; raw frames never stay)
    let meta: TakeMeta | undefined
    let warningsSaved = 0
    let fileError: Error | undefined
    try {
      await Promise.all(pendingWrites)
      if (writeError !== undefined) throw writeError
      // The secret regions, closed at the end of the scene; in time order (a region starts
      // backdated; stable: same-time events keep their order).
      // The first frame at or after `t` (frames sorted once; they may arrive out of order).
      const times = frames.map((f) => f.t).sort((a, b) => a - b)
      const frameAfter = (t: number) => {
        let lo = 0
        let hi = times.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if ((times[mid] ?? Infinity) < t) lo = mid + 1
          else hi = mid
        }
        return times[lo]
      }
      for (const region of regions.finish(durationMs, frameAfter)) {
        if (TakeEvent.safeParse(region).success) push(region)
        else {
          // Never dropped (the secret would show): the whole frame over its whole span.
          warnings.push(`secret region ${region.id}: invalid box, the whole frame is blurred`)
          const whole = { x: 0, y: 0, w: 1, h: 1 }
          const from = Number.isFinite(region.t) ? region.t : 0
          const until = Number.isFinite(region.until) ? region.until : durationMs
          push({
            t: from,
            phase: "setup",
            kind: "sensitive",
            id: region.id,
            why: region.why,
            until,
            boxes: [{ from, until, rect: whole }],
          })
        }
      }
      events.sort((a, b) => a.t - b.t)
      writeFileSync(join(outDir, "events.jsonl"), jsonl(events))
      writeFileSync(join(outDir, "cursor.jsonl"), jsonl(cursor))
      if (frames.length === 0) throw new Error("no frames were captured (the page never painted?)")
      if (failure === undefined || options.encodeFailed !== false) {
        await encodeFrames(framesDir, frames, durationMs, join(outDir, "frames.webm"))
      }
      if (frameSize === undefined)
        warnings.push("couldn't read the frame size: assuming the CSS viewport")
      const size = frameSize ?? viewport
      const scenarioHash = scenarioHashOf(scenario)
      // The app the take starts in (its URL and viewport in the key: the same as a v1 target's).
      const start = startAppOf(scenario, project)
      meta = TakeMeta.parse({
        version: 1,
        takeKey: `${sha256(`${scenarioHash}|${start.app.url}|${JSON.stringify(start.app.viewport)}|q${options.quality ?? 85}`).slice(0, 16)}-${recordedAt.getTime()}`,
        scenarioHash,
        recordedAt: recordedAt.toISOString(),
        appUrl: start.app.url,
        app: start.name,
        // The capture scale actually obtained (Phase 0 finding F1: screencast frames are at CSS size).
        viewport: {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: size.width / viewport.width,
        },
        frameSize: size,
        // Average capture rate; at least 1 (a static page sends few frames).
        fps: Math.max(
          1,
          frames.length > 1
            ? Math.round((frames.length - 1) / (Math.max(1, durationMs) / 1000))
            : 1,
        ),
        durationMs,
        kiframeVersion: options.kiframeVersion ?? "0.0.0",
        outcome:
          failure === undefined
            ? { status: "complete" }
            : { status: "failed", error: firstLine(failure) },
      })
      writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n")
      if (warnings.length > 0)
        writeFileSync(join(outDir, "warnings.json"), JSON.stringify(warnings, null, 2) + "\n")
      warningsSaved = warnings.length
    } catch (error) {
      fileError = error instanceof Error ? error : new Error(String(error))
    } finally {
      // Individual JPEG frames are temporary (frames.webm has them). Like every take file they're
      // unblurred: the take store is sensitive by design (encrypted at rest from M1-8).
      if (options.keepFrames !== true) rmSync(framesDir, { recursive: true, force: true })
    }
    // A complete take replaces the previous one; a failed take is kept next to it (`<name>.failed`)
    // for debugging and never replaces a good take.
    if (meta !== undefined) {
      const dest = meta.outcome.status === "complete" ? finalDir : `${finalDir}.failed`
      try {
        const leftover = swapInto(outDir, dest)
        placed = true
        // The take is in place: failing to clean up after it doesn't make it fail.
        if (leftover !== undefined)
          warnings.push(`couldn't remove the previous take at ${leftover}`)
        // A newer complete take makes an older failed one obsolete.
        if (dest === finalDir) {
          try {
            removeTake(`${finalDir}.failed`)
          } catch (error) {
            warnings.push(`couldn't remove ${finalDir}.failed: ${firstLine(error)}`)
          }
        }
        // Cleanup warnings come after warnings.json was written: saved with the take too.
        if (warnings.length > warningsSaved) {
          try {
            writeFileSync(join(dest, "warnings.json"), JSON.stringify(warnings, null, 2) + "\n")
          } catch {
            // Best effort: the take is in place, and the warnings are returned with it.
          }
        }
      } catch (error) {
        // Placing a FAILED take is best effort: the replay's own error is the one that matters.
        if (failure === undefined) throw error
        fileError ??= error instanceof Error ? error : new Error(String(error))
      }
    }
    if (failure !== undefined) {
      // Say why no failed take was kept, without replacing the replay's error.
      if (fileError !== undefined) Object.assign(failure, { takeError: firstLine(fileError) })
      throw failure
    }
    if (fileError !== undefined || meta === undefined)
      throw fileError ?? new Error("take metadata missing")
    return {
      dir: finalDir,
      meta,
      events,
      cursor,
      warnings,
    }
  } finally {
    if (!placed) rmSync(outDir, { recursive: true, force: true })
  }
}

/**
 * Whether `name` is something the recorder leaves next to the take folder `take` while recording
 * or when a recording fails or is cut short: its staging folder (`.<take>.recording-…`), its failed
 * take (`<take>.failed`), or a replaced take set aside (`<take>.old-…`, `<take>.failed.old-…`). For a
 * take store sweeping what a crash left: never the take itself. A set-aside take is only a leftover
 * once `take` exists (a crash mid-swap may leave the aside as the only copy of the previous take).
 */
export function isRecorderLeftover(name: string, take: string): boolean {
  return (
    name.startsWith(`.${take}.recording-`) ||
    name === `${take}.failed` ||
    name.startsWith(`${take}.old-`) ||
    name.startsWith(`${take}.failed.old-`)
  )
}

/**
 * Puts the take at `src` in place of `dest`: the old take is moved aside first, the new one renamed
 * in, then the old one deleted; if the rename fails, the old take is put back. `dest` is re-checked
 * (it must still be a take or absent). Returns the old take's path if it couldn't be deleted.
 */

function swapInto(src: string, dest: string): string | undefined {
  checkReplaceable(dest)
  const aside = existsSync(dest) ? `${dest}.old-${process.pid}-${Date.now()}` : undefined
  if (aside !== undefined) renameSync(dest, aside)
  try {
    renameSync(src, dest)
  } catch (error) {
    if (aside !== undefined) {
      try {
        renameSync(aside, dest)
      } catch {
        // The original error is the one reported; say where the previous take was left.
        throw new Error(`${firstLine(error)} (the previous take is at ${aside})`)
      }
    }
    throw error
  }
  if (aside === undefined) return undefined
  try {
    rmSync(aside, { recursive: true, force: true })
    return undefined
  } catch {
    return aside
  }
}

/**
 * Encodes timestamped JPEG frames into a VP9 WebM with ffmpeg (variable frame rate: each frame lasts
 * until the next one; the last one until the end of the take).
 */
async function encodeFrames(
  framesDir: string,
  frames: { file: string; t: number }[],
  durationMs: number,
  out: string,
): Promise<void> {
  // Video time = take time: the first frame is shown from t = 0 (the capture starts slightly
  // before the first frame arrives), so events and frames line up exactly.
  const lines = frames.flatMap((f, i) => {
    const start = i === 0 ? 0 : f.t
    const next = frames[i + 1]?.t ?? Math.max(durationMs, f.t + 1000 / 60)
    return [`file '${f.file}'`, `duration ${((next - start) / 1000).toFixed(6)}`]
  })
  // The concat demuxer needs the last file repeated for its duration to apply.
  lines.push(`file '${frames.at(-1)!.file}'`)
  const list = join(framesDir, "concat.txt")
  writeFileSync(list, lines.join("\n") + "\n")
  await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-fps_mode",
    "vfr",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "30",
    "-b:v",
    "0",
    "-row-mt",
    "1",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-pix_fmt",
    "yuv420p",
    out,
  ])
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${stderr.trim()}`)),
    )
  })
}

/** Width and height of a baseline/progressive JPEG, from its SOF marker. */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  let i = 2
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return undefined
    const marker = data[i + 1] ?? 0
    const length = data.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) }
    }
    i += 2 + length
  }
  return undefined
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/**
 * The hash a take records of the scenario it filmed (`meta.scenarioHash`): a scene's take is its
 * current one only while the scenario hashes the same (one function for the recorder and readers).
 */
export function scenarioHashOf(scenario: Scenario): string {
  return sha256(JSON.stringify(scenario))
}

/**
 * The take folder's real location: symlinks are followed (a take store on an encrypted volume
 * linked into place), so the swap happens there and never replaces the link itself.
 */
function realTakePath(outDir: string): string {
  const absolute = resolve(outDir)
  if (existsSync(absolute)) return realpathSync(absolute)
  // Not there yet: resolve its parent (which may be a link) and keep the name.
  const parent = dirname(absolute)
  return join(existsSync(parent) ? realpathSync(parent) : parent, basename(absolute))
}

/** Written first in every take directory: only a folder with it may be replaced by a new take. */
const TAKE_MARKER = ".kiframe-take"

/**
 * Refuses to replace `dir` unless it's absent, empty or holds the take marker (a previous take,
 * complete or interrupted): never a project folder or a path that resolved to something unexpected.
 */
function checkReplaceable(dir: string) {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir)
  if (entries.length > 0 && !entries.includes(TAKE_MARKER)) {
    throw new Error(
      `refusing to overwrite ${dir}: it isn't empty and isn't a take (no ${TAKE_MARKER})`,
    )
  }
}

/** Deletes a take folder, only if it is one (it has the marker). */
function removeTake(dir: string) {
  if (existsSync(dir) && readdirSync(dir).includes(TAKE_MARKER))
    rmSync(dir, { recursive: true, force: true })
}

function prepareOutDir(outDir: string) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, TAKE_MARKER), "kiframe take\n")
}

/** JSON Lines: one record per line, and an empty file (not a lone newline) when there are none. */
const jsonl = (records: readonly unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("")
