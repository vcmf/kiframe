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
  TakeEvent,
  TakeMeta,
  type ProjectConfig,
  type Scenario,
} from "@kiframe/schema"
import type { Page } from "playwright"
import type { StepRef } from "./errors.ts"
import type { Box } from "./motion.ts"
import { firstLine, runScenario, type RunnerEvent, type RunOptions } from "./runner.ts"
import { viewportOf } from "./targets.ts"

// The recorder (docs/OBJECT-MODEL.md §3): replays a scenario through the runner while capturing the
// page, and writes a take: frames.webm, events.jsonl, cursor.jsonl, shots/<stepId>.jpg, meta.json.
// Every record is validated against @kiframe/schema before it's written.
//
// Clock: `page.screencast` frame timestamps are epoch milliseconds, the same clock as Date.now()
// (Phase 0 finding F1), so frames, runner events and cursor samples share one clock. t = 0 is the
// start of the capture.

export interface RecordOptions extends RunOptions {
  /** The take directory to create (must not contain anything worth keeping: it's overwritten). */
  outDir: string
  /** JPEG quality of captured frames, 1–100. Default 85. */
  quality?: number
  /** Keep the individual JPEG frames next to frames.webm (debugging). Default false. */
  keepFrames?: boolean
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
    const recordedAt = new Date()
    const t0 = Date.now()
    const at = () => Math.max(0, Date.now() - t0)
    const norm = (x: number, y: number) => ({
      x: clamp01(x / viewport.width),
      y: clamp01(y / viewport.height),
    })
    const rect = (b: Box) => ({
      x: b.x / viewport.width,
      y: b.y / viewport.height,
      w: Math.max(0, b.width / viewport.width),
      h: Math.max(0, b.height / viewport.height),
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
    let lastSize: { width: number; height: number } | undefined
    let stopped = false
    let sizeChanged = false
    let lastFrame: Buffer | undefined
    await page.screencast.start({
      // Without `size`, frames are scaled down to fit a small default box. Frames come out at CSS
      // resolution at most anyway (Phase 0 finding F1).
      size: { width: viewport.width, height: viewport.height },
      quality: options.quality ?? 85,
      onFrame: ({ data, timestamp }) => {
        // After stop (or a failed stop), late frames are ignored: they'd never be awaited.
        if (stopped) return
        const file = `frame-${String(frames.length).padStart(6, "0")}.jpg`
        // Asynchronous: a synchronous write per frame (~60/s) would stall the cursor and typing loops.
        pendingWrites.push(track(writeFile(join(framesDir, file), data)))
        frames.push({ file, t: Math.max(0, timestamp - t0) })
        const size = jpegSize(data)
        if (size !== undefined) {
          if (
            lastSize !== undefined &&
            (size.width !== lastSize.width || size.height !== lastSize.height) &&
            !sizeChanged
          ) {
            sizeChanged = true
            warnings.push(
              `frame size changed mid-take (${lastSize.width}×${lastSize.height} → ${size.width}×${size.height})`,
            )
          }
          lastSize = size
          frameSize ??= size
        }
        lastFrame = data
      },
    })

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
    const fullFrame = { x: 0, y: 0, w: 1, h: 1 }
    const handle = (e: RunnerEvent) => {
      switch (e.kind) {
        case "step_start":
          push({ ...base(e.step), kind: "step_start" })
          // Storyboard / guide shot: the frame at the start of each on-camera step.
          if (e.step.phase === "steps" && e.step.stepId !== undefined && lastFrame !== undefined) {
            pendingWrites.push(
              track(writeFile(join(outDir, "shots", `${e.step.stepId}.jpg`), lastFrame)),
            )
          }
          break
        case "step_end":
          push({ ...base(e.step), kind: "step_end" })
          break
        case "navigate":
          push({ ...base(e.step), kind: "navigate", url: e.url })
          break
        case "click":
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
          } else {
            warnings.push(`no box for the ${kind} of ${keyOf(e.step)}: typing not logged`)
          }
          // A field filled from the vault is sensitive: the compositor blurs it. Without a box, the
          // whole frame is marked (fails closed: better a blurred frame than a visible secret).
          if (e.secret !== undefined && e.kind === "type_start") {
            push({
              ...base(e.step),
              kind: "sensitive",
              id: `secret:${e.secret}:${e.step.phase}:${e.step.index}`,
              rect: box === undefined ? fullFrame : rect(box),
              why: "secret-field",
            })
          }
          break
        }
        case "secret_field":
          // The blur follows the field: a new rect where it is now. A field that's gone (no box)
          // shows nothing, so there's nothing to blur.
          if (e.box !== undefined) {
            push({
              ...base(e.step),
              kind: "sensitive",
              id: e.id,
              rect: rect(e.box),
              why: "secret-field",
            })
          }
          break
        case "key":
          push({ ...base(e.step), kind: "key", key: e.keys })
          break
        case "target_fallback":
        case "teardown_failed":
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
      await runScenario(page, scenario, project, { ...options, onEvent, recording: true })
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    stopped = true
    await page.screencast.stop().catch(() => undefined)
    // Capture time, not disk-flush time.
    const durationMs = Math.max(at(), frames.at(-1)?.t ?? 0)

    // ── files ── (the runner's failure, if any, is the error that's thrown; raw frames never stay)
    let meta: TakeMeta | undefined
    let fileError: Error | undefined
    try {
      await Promise.all(pendingWrites)
      if (writeError !== undefined) throw writeError
      writeFileSync(join(outDir, "events.jsonl"), jsonl(events))
      writeFileSync(join(outDir, "cursor.jsonl"), jsonl(cursor))
      if (frames.length === 0) throw new Error("no frames were captured (the page never painted?)")
      await encodeFrames(framesDir, frames, durationMs, join(outDir, "frames.webm"))
      if (frameSize === undefined)
        warnings.push("couldn't read the frame size: assuming the CSS viewport")
      const size = frameSize ?? viewport
      const scenarioHash = sha256(JSON.stringify(scenario))
      meta = TakeMeta.parse({
        version: 1,
        takeKey: `${sha256(`${scenarioHash}|${project.target.url}|${JSON.stringify(project.target.viewport)}|q${options.quality ?? 85}`).slice(0, 16)}-${recordedAt.getTime()}`,
        scenarioHash,
        recordedAt: recordedAt.toISOString(),
        appUrl: project.target.url,
        ...(project.environment !== undefined && { environment: project.environment }),
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
        swapInto(outDir, dest)
        placed = true
        // A newer complete take makes an older failed one obsolete.
        if (dest === finalDir) removeTake(`${finalDir}.failed`)
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
    return { dir: finalDir, meta, events, cursor, warnings }
  } finally {
    if (!placed) rmSync(outDir, { recursive: true, force: true })
  }
}

/**
 * Puts the take at `src` in place of `dest`: the old take is moved aside first, the new one renamed
 * in, then the old one deleted; if the rename fails, the old take is put back. `dest` is re-checked
 * (it must still be a take or absent).
 */
function swapInto(src: string, dest: string) {
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
  if (aside !== undefined) rmSync(aside, { recursive: true, force: true })
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
 * Makes `outDir` an empty take directory. An existing directory is only replaced if it's empty or
 * holds the take marker (a previous take, complete or interrupted): never a project folder or a path
 * that resolved to something unexpected.
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
