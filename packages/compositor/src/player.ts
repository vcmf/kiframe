import type { TakeInput } from "@kiframe/generators"
import type { Composition, Scenario, Style as SchemaStyle } from "@kiframe/schema"
import { ALL_FORMATS, BlobSource, BufferSource, CanvasSink, Input } from "mediabunny"
import { drawScene } from "./draw.ts"
import { prepare, type Prepared, sceneAt, type Style } from "./scene.ts"

// The preview player (docs/OBJECT-MODEL.md §5): the export's own pieces (prepare → sceneAt →
// drawScene over the take's decoded frames) drawn to a canvas at the wall clock, so what plays is
// what exports. Playing decodes in one forward pass (source time only moves forward), each next
// frame picked when the decoder is ready for it, at the wall clock's time: a slow machine shows
// fewer frames, never a slower (or frozen) clock.

export interface PlayerSource {
  /** The take's frames.webm (bytes as they came: read in place, never copied). */
  video: Blob | Uint8Array<ArrayBuffer>
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
  /** The time the next seek shows (the latest asked), and the seeking under way. */
  #target: number | undefined
  #seeking: Promise<void> | undefined
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
    const input = new Input({
      source:
        source.video instanceof Blob
          ? new BlobSource(source.video)
          : new BufferSource(source.video),
      formats: ALL_FORMATS,
    })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (track === null) throw new Error("the take has no video track")
      const first = await track.getFirstTimestamp()
      const player = new Player(ctx, prepared, input, new CanvasSink(track, { poolSize: 2 }), first)
      await player.#show(0)
      return player
    } catch (error) {
      // A take that doesn't load lets go of its decoder.
      input.dispose()
      throw error
    }
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

  /**
   * Shows the frame at an output time (stops playing). Seeks while one is decoding are merged: only
   * the latest is shown next (a scrubber dragged never queues a decode per pixel). A frame that
   * doesn't decode keeps the last one shown.
   */
  async seek(tOut: number): Promise<void> {
    this.#run++
    this.#setPlaying(false)
    this.#target = clamp(tOut, 0, this.duration)
    // The time is the one asked at once (a play right after starts there), its picture follows.
    this.#time = this.#target
    if (this.#seeking !== undefined) return this.#seeking
    this.#seeking = (async () => {
      try {
        while (this.#target !== undefined) {
          const t = this.#target
          this.#target = undefined
          await this.#show(t).catch(() => undefined)
        }
      } finally {
        this.#seeking = undefined
      }
    })()
    return this.#seeking
  }

  async #show(t: number): Promise<void> {
    const run = this.#run
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
    const step = 1000 / this.style.fps
    const start = performance.now() - from
    const duration = this.duration
    const prepared = this.#prepared
    const first = this.#first
    // Each next frame chosen when the decoder asks for it: the frame of the wall clock's time (on
    // the frame grid, always after the last one), so frames the machine can't keep up with are
    // never asked for. The scenes go with them, computed one at a time.
    const scenes: { t: number; scene: ReturnType<typeof sceneAt> }[] = []
    let last = -Infinity
    function* times(): Generator<number> {
      for (;;) {
        const now = Math.max(0, performance.now() - start)
        let t = Math.max(from, Math.floor(now / step) * step)
        if (t <= last) t = last + step
        if (t > duration) {
          if (last >= duration) return
          t = duration
        }
        last = t
        const scene = sceneAt(prepared, t)
        scenes.push({ t, scene })
        yield first + scene.sourceT / 1000
      }
    }
    for await (const wrapped of this.#sink.canvasesAtTimestamps(times())) {
      if (run !== this.#run) return
      const shown = scenes.shift()
      if (shown === undefined) continue
      const wait = start + shown.t - performance.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      if (run !== this.#run) return
      if (wrapped !== null) drawScene(this.#ctx, wrapped.canvas, shown.scene, this.style)
      this.#time = shown.t
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
