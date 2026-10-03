import type { TakeInput } from "@kiframe/generators"
import type { Composition, Scenario, Style as SchemaStyle } from "@kiframe/schema"
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny"
import { drawScene } from "./draw.ts"
import { prepare, type Prepared, sceneAt, type Style } from "./scene.ts"

// The preview player (docs/OBJECT-MODEL.md §5): the export's own pieces (prepare → sceneAt →
// drawScene over the take's decoded frames) drawn to a canvas at the wall clock, so what plays is
// what exports. Playing decodes in one forward pass (source time only moves forward); a frame due
// before the last one drawn is skipped, so a slow machine drops frames, never time.

export interface PlayerSource {
  /** The take's frames.webm. */
  video: Blob
  composition: Composition
  scenario: Scenario
  take: TakeInput
  /** The output layer (size, its overrides), on top of the scene's style. */
  style?: Partial<Style>
  /** Org + project style, below the scene's. Default: product defaults. */
  baseStyle?: SchemaStyle
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export class Player {
  readonly duration: number
  readonly style: Style
  readonly #prepared: Prepared
  readonly #sink: CanvasSink
  readonly #first: number
  readonly #ctx: Ctx
  readonly #input: Input
  #time = 0
  /** Bumped by every play, pause or seek: a run that sees another one stops. */
  #run = 0
  #playing = false
  #listeners = new Set<() => void>()

  private constructor(ctx: Ctx, prepared: Prepared, input: Input, sink: CanvasSink, first: number) {
    this.#ctx = ctx
    this.#prepared = prepared
    this.#input = input
    this.#sink = sink
    this.#first = first
    this.duration = prepared.duration
    this.style = prepared.style
  }

  /** Loads a take for a canvas (sized to the output) and draws its first frame. */
  static async load(canvas: HTMLCanvasElement, source: PlayerSource): Promise<Player> {
    const prepared = prepare(
      source.composition,
      source.scenario,
      source.take,
      source.style,
      source.baseStyle,
    )
    canvas.width = prepared.style.width
    canvas.height = prepared.style.height
    const ctx = canvas.getContext("2d")
    if (ctx === null) throw new Error("no 2D canvas context")
    const input = new Input({ source: new BlobSource(source.video), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (track === null) throw new Error("the take has no video track")
    const first = await track.getFirstTimestamp()
    const player = new Player(ctx, prepared, input, new CanvasSink(track, { poolSize: 2 }), first)
    await player.seek(0)
    return player
  }

  /** Output time shown, in ms. */
  get time(): number {
    return this.#time
  }

  get playing(): boolean {
    return this.#playing
  }

  /** Called on every frame drawn and on play, pause and end. Returns its removal. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Shows the frame at an output time (stops playing). */
  async seek(tOut: number): Promise<void> {
    const run = ++this.#run
    this.#setPlaying(false)
    const t = clamp(tOut, 0, this.duration)
    const scene = sceneAt(this.#prepared, t)
    const frame = await this.#sink.getCanvas(this.#first + scene.sourceT / 1000)
    if (run !== this.#run) return
    if (frame !== null) drawScene(this.#ctx, frame.canvas, scene, this.style)
    this.#time = t
    this.#emit()
  }

  /** Plays from the current time (from the start once it ended), until the end or a pause. */
  play(): void {
    if (this.#playing) return
    const from = this.#time >= this.duration ? 0 : this.#time
    const run = ++this.#run
    this.#setPlaying(true)
    void this.#play(run, from).catch(() => {
      if (run === this.#run) this.#setPlaying(false)
    })
  }

  pause(): void {
    if (!this.#playing) return
    this.#run++
    this.#setPlaying(false)
  }

  /** Stops and lets go of the decoder. */
  dispose(): void {
    this.#run++
    this.#playing = false
    this.#listeners.clear()
    this.#input.dispose()
  }

  async #play(run: number, from: number): Promise<void> {
    const { fps } = this.style
    const step = 1000 / fps
    const count = Math.max(1, Math.floor((this.duration - from) / step) + 1)
    const outs = Array.from({ length: count }, (_, i) => Math.min(this.duration, from + i * step))
    const scenes = outs.map((t) => sceneAt(this.#prepared, t))
    const start = performance.now() - from
    let i = 0
    for await (const wrapped of this.#sink.canvasesAtTimestamps(
      scenes.map((s) => this.#first + s.sourceT / 1000),
    )) {
      if (run !== this.#run) return
      const tOut = outs[i] ?? this.duration
      const scene = scenes[i]
      i++
      // Late (the next frame is already due): skipped, the clock never waits for the decoder.
      const next = outs[i]
      if (next !== undefined && performance.now() - start >= next) continue
      const wait = start + tOut - performance.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      if (run !== this.#run) return
      if (wrapped !== null && scene !== undefined) {
        drawScene(this.#ctx, wrapped.canvas, scene, this.style)
      }
      this.#time = tOut
      this.#emit()
    }
    if (run === this.#run) {
      this.#time = this.duration
      this.#setPlaying(false)
    }
  }

  #setPlaying(playing: boolean): void {
    if (this.#playing === playing) return
    this.#playing = playing
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
