import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  CursorSample,
  TakeEvent,
  TakeMeta,
  type ProjectConfig,
  type Scenario,
} from "@kiframe/schema"
import type { Page } from "playwright"
import type { StepRef } from "./errors.ts"
import { runScenario, type RunnerEvent, type RunOptions } from "./runner.ts"
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
}

/** Records a scenario into a take directory. Rethrows the runner's error after writing what was captured. */
export async function recordScenario(
  page: Page,
  scenario: Scenario,
  project: ProjectConfig,
  options: RecordOptions,
): Promise<Take> {
  const { outDir } = options
  rmSync(outDir, { recursive: true, force: true })
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
  const rect = (b: { x: number; y: number; width: number; height: number }) => ({
    x: b.x / viewport.width,
    y: b.y / viewport.height,
    w: Math.max(0, b.width / viewport.width),
    h: Math.max(0, b.height / viewport.height),
  })

  // ── frames ──
  const frames: { file: string; t: number }[] = []
  let frameSize: { width: number; height: number } | undefined
  let lastFrame: Buffer | undefined
  await page.screencast.start({
    // Without `size`, frames are scaled down to fit a small default box. Frames come out at CSS
    // resolution at most anyway (Phase 0 finding F1).
    size: { width: viewport.width, height: viewport.height },
    quality: options.quality ?? 85,
    onFrame: ({ data, timestamp }) => {
      const file = `frame-${String(frames.length).padStart(6, "0")}.jpg`
      writeFileSync(join(framesDir, file), data)
      frames.push({ file, t: Math.max(0, timestamp - t0) })
      frameSize ??= jpegSize(data)
      lastFrame = data
    },
  })

  // ── events ──
  const events: TakeEvent[] = []
  const cursor: CursorSample[] = []
  const lastTarget = new Map<string, { x: number; y: number; width: number; height: number }>()
  const keyOf = (s: StepRef) => `${s.phase}:${s.index}`
  const base = (s: StepRef) => ({
    t: at(),
    phase: s.phase,
    ...(s.stepId !== undefined && { stepId: s.stepId }),
  })
  const push = (event: unknown) => events.push(TakeEvent.parse(event))
  const onEvent = (e: RunnerEvent) => {
    switch (e.kind) {
      case "step_start":
        push({ ...base(e.step), kind: "step_start" })
        // Storyboard / guide shot: the frame at the start of each on-camera step.
        if (e.step.phase === "steps" && e.step.stepId !== undefined && lastFrame !== undefined) {
          writeFileSync(join(outDir, "shots", `${e.step.stepId}.jpg`), lastFrame)
        }
        break
      case "step_end":
        push({ ...base(e.step), kind: "step_end" })
        break
      case "navigate":
        push({ ...base(e.step), kind: "navigate", url: e.url })
        break
      case "target":
        lastTarget.set(keyOf(e.step), e.box)
        break
      case "cursor": {
        const sample = CursorSample.parse({ t: at(), p: norm(e.x, e.y), pressed: e.pressed })
        cursor.push(sample)
        const box = lastTarget.get(keyOf(e.step))
        if (e.pressed && box !== undefined) {
          push({ ...base(e.step), kind: "click", point: sample.p, rect: rect(box), button: "left" })
        }
        break
      }
      case "type_start":
      case "type": {
        const box = lastTarget.get(keyOf(e.step))
        if (box === undefined) break
        const kind = e.kind === "type_start" ? "type_start" : "type_end"
        push({
          ...base(e.step),
          kind,
          rect: rect(box),
          ...(e.secret !== undefined && { secret: e.secret }),
        })
        // A field filled from the vault is sensitive: the compositor blurs it.
        if (e.secret !== undefined && e.kind === "type_start") {
          push({
            ...base(e.step),
            kind: "sensitive",
            id: `secret:${e.secret}:${keyOf(e.step)}`,
            rect: rect(box),
            why: "secret-field",
          })
        }
        break
      }
      case "key":
        push({ ...base(e.step), kind: "key", key: e.keys })
        break
      case "target_fallback":
      case "teardown_failed":
        break
    }
    options.onEvent?.(e)
  }

  let failure: Error | undefined
  try {
    await runScenario(page, scenario, project, { ...options, onEvent })
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  }
  await page.screencast.stop().catch(() => undefined)

  // ── files ──
  const durationMs = Math.max(at(), frames.at(-1)?.t ?? 0)
  writeFileSync(
    join(outDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  )
  writeFileSync(
    join(outDir, "cursor.jsonl"),
    cursor.map((c) => JSON.stringify(c)).join("\n") + "\n",
  )
  writeFileSync(
    join(framesDir, "frames.jsonl"),
    frames.map((f) => JSON.stringify(f)).join("\n") + "\n",
  )
  if (frames.length > 0)
    await encodeFrames(framesDir, frames, durationMs, join(outDir, "frames.webm"))
  if (options.keepFrames !== true) rmSync(framesDir, { recursive: true, force: true })

  const size = frameSize ?? viewport
  const scenarioHash = sha256(JSON.stringify(scenario))
  const meta = TakeMeta.parse({
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
    fps: frames.length > 1 ? Math.round((frames.length - 1) / (Math.max(1, durationMs) / 1000)) : 0,
    durationMs,
    kiframeVersion: options.kiframeVersion ?? "0.0.0",
  })
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n")

  if (failure !== undefined) throw failure
  return { dir: outDir, meta, events, cursor }
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
  const lines = frames.flatMap((f, i) => {
    const next = frames[i + 1]?.t ?? Math.max(durationMs, f.t + 1000 / 60)
    return [`file '${f.file}'`, `duration ${((next - f.t) / 1000).toFixed(6)}`]
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
