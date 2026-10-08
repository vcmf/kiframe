// The live app during a handover: the user's hands on the agent's browser. Points go as fractions of
// the frame (main maps them onto the page); keys that aren't text go by name, text as text (typed,
// composed, pasted) through a hidden field that keeps the focus. Only while a handover is open:
// main drops anything else.
import { useEffect, useRef } from "react"
import {
  LIVE_KEYS,
  type LIVE_MODIFIERS,
  type LiveFrame,
  type LiveInput,
} from "../../../shared/ipc.ts"
import { api } from "../api.ts"

const KEYS = new Set<string>(LIVE_KEYS)
/** Keys that are never text (pressed by name, with their modifiers). */
const COMMAND_KEYS = new Set<string>(LIVE_KEYS.filter((k) => k.length > 1))
/** A mouse move sent at most this often. */
const MOVE_MS = 30

const BUTTONS = ["left", "middle", "right"] as const

/**
 * Where a point on a contained image falls on its picture, as fractions (the image box may be
 * larger than the picture it shows: `object-fit: contain`).
 */
export function pointOn(
  box: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
  client: { x: number; y: number },
): { x: number; y: number } | undefined {
  if (natural.width === 0 || natural.height === 0 || box.width === 0 || box.height === 0) {
    return undefined
  }
  const scale = Math.min(box.width / natural.width, box.height / natural.height)
  const shown = { width: natural.width * scale, height: natural.height * scale }
  const left = box.left + (box.width - shown.width) / 2
  const top = box.top + (box.height - shown.height) / 2
  const x = (client.x - left) / shown.width
  const y = (client.y - top) / shown.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined
  return { x, y }
}

export function LiveControl({ frame, handover }: { frame: LiveFrame; handover: string }) {
  const image = useRef<HTMLImageElement>(null)
  const typing = useRef<HTMLTextAreaElement>(null)
  const lastMove = useRef(0)
  const composing = useRef(false)
  const pressed = useRef(new Set<(typeof BUTTONS)[number]>())
  const last = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 })
  const send = (event: LiveInput) => {
    void api()
      .invoke("live:input", handover, frame.gen, event)
      .catch(() => undefined)
  }
  // The keyboard goes to the live app from the start (and back after a click on it).
  useEffect(() => typing.current?.focus(), [handover])
  // A button released outside the frame (a drag past its edge): released there too, at the last
  // point on it (else it would stay held, every move a drag).
  useEffect(() => {
    const up = (e: MouseEvent) => {
      const button = BUTTONS[e.button]
      if (button === undefined || !pressed.current.has(button)) return
      pressed.current.delete(button)
      send({ kind: "mouse", type: "up", ...last.current, button, clickCount: 1 })
    }
    window.addEventListener("mouseup", up)
    return () => window.removeEventListener("mouseup", up)
  }, [handover, frame.gen])
  const point = (e: { clientX: number; clientY: number }) => {
    const img = image.current
    if (img === null) return undefined
    return pointOn(
      img.getBoundingClientRect(),
      { width: img.naturalWidth, height: img.naturalHeight },
      { x: e.clientX, y: e.clientY },
    )
  }
  return (
    <div className="live-control" aria-label="The live app: you're in control">
      <img
        ref={image}
        className="live-frame live-frame-control"
        alt={`The live app at ${frame.path}, taking your input`}
        src={`data:image/jpeg;base64,${frame.jpeg}`}
        draggable={false}
        onContextMenu={(e) => e.preventDefault()}
        onMouseMove={(e) => {
          const now = Date.now()
          if (now - lastMove.current < MOVE_MS) return
          const at = point(e)
          if (at === undefined) return
          last.current = at
          lastMove.current = now
          send({ kind: "mouse", type: "move", ...at, button: "left", clickCount: 0 })
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          typing.current?.focus()
          const at = point(e)
          const button = BUTTONS[e.button]
          if (at === undefined || button === undefined) return
          last.current = at
          pressed.current.add(button)
          send({ kind: "mouse", type: "down", ...at, button, clickCount: Math.min(3, e.detail) })
        }}
        onMouseUp={(e) => {
          const button = BUTTONS[e.button]
          if (button === undefined || !pressed.current.has(button)) return
          // Released here (the window's listener then finds nothing held).
          pressed.current.delete(button)
          const at = point(e) ?? last.current
          send({ kind: "mouse", type: "up", ...at, button, clickCount: Math.min(3, e.detail) })
        }}
        onWheel={(e) => {
          const at = point(e)
          if (at === undefined) return
          const clamp = (n: number) => Math.max(-5000, Math.min(5000, n))
          send({ kind: "wheel", ...at, dx: clamp(e.deltaX), dy: clamp(e.deltaY) })
        }}
      />
      <textarea
        ref={typing}
        className="live-typing"
        aria-label="Type into the live app"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(e) => {
          if (composing.current) return
          // A shortcut is Command or Control (never Alt alone: AltGr and Option make text).
          const command = e.metaKey || (e.ctrlKey && !e.altKey)
          const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
          // Text goes as text (onInput); keys by name: those that are never text, and shortcuts.
          if (!(COMMAND_KEYS.has(key) || (command && KEYS.has(key)))) return
          // Paste comes from the paste itself (the user's own clipboard), never Meta+V.
          if (command && ["v", "c", "x"].includes(key)) return
          e.preventDefault()
          const modifiers: (typeof LIVE_MODIFIERS)[number][] = []
          if (e.shiftKey) modifiers.push("Shift")
          if (e.ctrlKey) modifiers.push("Control")
          if (e.altKey) modifiers.push("Alt")
          if (e.metaKey) modifiers.push("Meta")
          // Pressed once (never held: macOS sends no key-up for a key pressed with Command).
          send({ kind: "key", key: key, modifiers })
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(e) => {
          composing.current = false
          if (e.data !== "") send({ kind: "text", text: e.data.slice(0, 2000) })
          e.currentTarget.value = ""
        }}
        onInput={(e) => {
          if (composing.current) return
          const text = e.currentTarget.value
          e.currentTarget.value = ""
          if (text !== "") send({ kind: "text", text: text.slice(0, 2000) })
        }}
        onPaste={(e) => {
          e.preventDefault()
          const text = e.clipboardData.getData("text/plain")
          if (text !== "") send({ kind: "text", text: text.slice(0, 2000) })
        }}
      />
    </div>
  )
}
