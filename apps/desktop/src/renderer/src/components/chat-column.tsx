// The chat column: the user's messages, the agent's answers and tool steps (grouped, collapsible),
// its requests as cards, and the composer (a status bar with Stop while the agent works).
import {
  Brain,
  CaretDown,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  CircleNotch,
  CursorClick,
  FileText,
  Globe,
  HandPointing,
  Key,
  ListBullets,
  ListChecks,
  LockKey,
  MagnifyingGlass,
  PaperPlaneRight,
  Paperclip,
  ImageSquare,
  X,
  Question,
  Record,
  Stop,
  StopCircle,
  Wrench,
  XCircle,
  HandGrabbing,
  Warning,
} from "@phosphor-icons/react"
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { ATTACHABLE, type ChatItem } from "../../../shared/ipc.ts"
import { pastedFile, useChat } from "../chat-store.ts"
import { KifMark } from "./kif-mark.tsx"
import { AgentText } from "./markdown.tsx"

type ToolItem = Extract<ChatItem, { kind: "tool" }>
type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>
/** A row of a step group: a tool call, or a stretch of thinking. */
type StepItem = ToolItem | ThinkingItem

const TOOL_ICONS: Record<string, ReactNode> = {
  list_scenes: <ListBullets size={15} />,
  snapshot: <MagnifyingGlass size={15} />,
  run_step: <CursorClick size={15} />,
  run_steps: <CursorClick size={15} />,
  list_secrets: <Key size={15} />,
  ask_user: <Question size={15} />,
  save_scene: <ListChecks size={15} />,
  record_scene: <Record size={15} />,
}

/** Items in order, consecutive tool steps and thinking as one group. */
type Block = { kind: "item"; item: ChatItem } | { kind: "steps"; id: string; steps: StepItem[] }

/**
 * The chat as the user sees it: each message of theirs, and between them one agent turn holding
 * all it did (its text, tool steps, a request, how the run ended) under one mark.
 */
export type Turn =
  | { kind: "user"; item: Extract<ChatItem, { kind: "user" }> }
  | { kind: "agent"; id: string; blocks: Block[] }

export function turns(items: ChatItem[]): Turn[] {
  const out: Turn[] = []
  let agent: ChatItem[] = []
  const close = () => {
    const first = agent[0]
    if (first !== undefined) out.push({ kind: "agent", id: first.id, blocks: blocks(agent) })
    agent = []
  }
  for (const item of items) {
    if (item.kind === "user") {
      close()
      out.push({ kind: "user", item })
    } else agent.push(item)
  }
  close()
  return out
}

export function blocks(items: ChatItem[]): Block[] {
  const out: Block[] = []
  for (const item of items) {
    const last = out.at(-1)
    const step = item.kind === "tool" || item.kind === "thinking"
    if (step && last?.kind === "steps") last.steps.push(item)
    else if (step) out.push({ kind: "steps", id: item.id, steps: [item] })
    else out.push({ kind: "item", item })
  }
  return out
}

/**
 * Whether the items not seen before (by id: appended one by one, or a whole list at once) include
 * one that needs the user: their own message, or a request the run waits on. Each new id is noted
 * in `seen`.
 */
export function newNeedUser(items: readonly ChatItem[], seen: Set<string>): boolean {
  let needs = false
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    if (item.kind === "user" || (item.kind === "request" && item.state === "open")) needs = true
  }
  return needs
}

export function ChatColumn() {
  const items = useChat((s) => s.items)
  const running = useChat((s) => s.running)
  const connect = useChat((s) => s.connect)
  const attach = useChat((s) => s.attach)
  const body = useRef<HTMLDivElement>(null)
  const [dropping, setDropping] = useState(false)
  useEffect(() => connect(), [connect])
  // A file dropped anywhere else in the window is never opened by it (nothing happens); a text
  // dragged into a field still drops as text.
  useEffect(() => {
    const ignore = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes("Files") === true) e.preventDefault()
    }
    window.addEventListener("dragover", ignore)
    window.addEventListener("drop", ignore)
    return () => {
      window.removeEventListener("dragover", ignore)
      window.removeEventListener("drop", ignore)
    }
  }, [])
  // Files only (a text dragged into the composer is typed), and never while a run goes (the
  // composer shows no files then).
  const withFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files")
  const dropped = (e: DragEvent) => {
    if (!withFiles(e)) return
    e.preventDefault()
    setDropping(false)
    if (!running && e.dataTransfer.files.length > 0) attach([...e.dataTransfer.files])
  }
  // The log is reversed (CSS): its end is scrollTop 0, so layout keeps it there as the chat grows
  // or the log resizes, and anchoring holds a reader who scrolled up. Code moves it only for a new
  // item that needs the user: their own message, or a request the run waits on.
  const seen = useRef(new Set<string>())
  useLayoutEffect(() => {
    const log = body.current
    if (newNeedUser(items, seen.current) && log !== null) log.scrollTop = 0
  }, [items])
  return (
    <aside
      className={dropping ? "chat dropping" : "chat"}
      aria-label="Chat"
      onDragOver={(e) => {
        if (!withFiles(e)) return
        e.preventDefault()
        if (!running) setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={dropped}
    >
      <div className="pane-head">
        <span className="pane-title">Chat</span>
      </div>
      {/* Focusable: scrolled by keys too (a scrollable region reachable by keyboard). */}
      <div className="chat-body" role="log" aria-label="Messages" tabIndex={0} ref={body}>
        <div className="chat-items">
          {items.length === 0 ? (
            <div className="chat-empty">
              <ChatCircleDots size={28} />
              <h2>Describe your demo</h2>
              <p>
                Say what the video should show. Kif, Kiframe’s agent, splits it into scenes, tries
                each step on your app and films it.
              </p>
            </div>
          ) : (
            turns(items).map((turn, i, all) =>
              turn.kind === "user" ? (
                <Item key={turn.item.id} item={turn.item} />
              ) : (
                <AgentTurn
                  key={turn.id}
                  blocks={turn.blocks}
                  working={running && i === all.length - 1}
                />
              ),
            )
          )}
        </div>
      </div>
      <Composer />
    </aside>
  )
}

/** One agent turn: Kif's mark above (moving while the turn is written), then all it did. */
function AgentTurn({ blocks: parts, working }: { blocks: Block[]; working: boolean }) {
  // A run that ended quietly (done, nothing said): no turn, no lone mark.
  const silent = parts.every(
    (b) =>
      b.kind === "item" &&
      b.item.kind === "end" &&
      b.item.outcome === "done" &&
      b.item.message === undefined,
  )
  if (silent) return null
  return (
    <div className="agent-turn">
      <span className="agent-mark" aria-hidden="true">
        <KifMark working={working} />
      </span>
      {parts.map((block) =>
        block.kind === "steps" ? (
          <ToolGroup key={block.id} steps={block.steps} />
        ) : (
          <Item key={block.item.id} item={block.item} />
        ),
      )}
    </div>
  )
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user">
          {item.text}
          {item.attachments !== undefined && item.attachments.length > 0 && (
            <ul className="msg-files" aria-label="Attached files">
              {item.attachments.map((path) => (
                <li key={path} className="file-chip">
                  <FileIcon name={path} />
                  <span className="file-name">{path.replace(/^inputs\//, "")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    case "assistant":
      return (
        <div className="msg-agent-text">
          <AgentText text={item.text} />
        </div>
      )
    case "request":
      return <RequestCard item={item} />
    case "end":
      return item.outcome === "done" && item.message === undefined ? null : (
        <div className={`run-end run-end-${item.outcome}`} role="status">
          {item.outcome === "stopped" ? <StopCircle size={15} /> : <XCircle size={15} />}
          <span>
            {item.outcome === "stopped"
              ? "Stopped. Nothing more ran."
              : item.outcome === "turn_limit"
                ? `Kif ${item.message ?? "stopped"}: say how to go on.`
                : (item.message ?? "Kif failed.")}
          </span>
        </div>
      )
    case "tool":
    case "thinking":
      return <ToolGroup steps={[item]} />
  }
}

/** How long a thought took, as said: "8s", "1m 35s". */
export function thoughtFor(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 === 0 ? "" : ` ${s % 60}s`}`
}

function ToolGroup({ steps }: { steps: StepItem[] }) {
  const [open, setOpen] = useState(true)
  // Opened or closed by the user: its head stays where it was clicked (the log is anchored at its
  // end, so what grows near the end would otherwise push the head up from under the pointer).
  const head = useRef<HTMLButtonElement>(null)
  const clickedAt = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    const at = clickedAt.current
    const el = head.current
    clickedAt.current = undefined
    const log = el?.closest<HTMLElement>(".chat-body")
    if (at === undefined || el === null || log === null || log === undefined) return
    // Measured after layout, the browser's own anchoring already applied: the rest, corrected.
    log.scrollTop += el.getBoundingClientRect().top - at
  }, [open])
  const tools = steps.filter((t): t is ToolItem => t.kind === "tool")
  const thinking = steps.some((t) => t.kind === "thinking" && t.ms === undefined)
  const running = tools.some((t) => t.status === "running")
  const failed = tools.filter((t) => t.status === "failed").length
  const summary = `${tools.length} ${tools.length === 1 ? "step" : "steps"}${running ? " · running" : thinking ? " · thinking" : ""}${failed > 0 ? ` · ${failed} failed` : ""}`
  // Thinking alone: its row, no head to fold it (it would only repeat the row).
  const lone = tools.length === 0
  return (
    <div className="tool-group">
      {!lone && (
        <button
          type="button"
          className="tool-group-head"
          aria-expanded={open}
          ref={head}
          onClick={() => {
            clickedAt.current = head.current?.getBoundingClientRect().top
            setOpen((v) => !v)
          }}
        >
          {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
          {summary}
        </button>
      )}
      {(open || lone) && (
        <ul className="tool-list">
          {steps.map((step) =>
            step.kind === "thinking" ? (
              <li key={step.id} className="tool-row thinking-row">
                <span className="tool-icon">
                  <Brain size={15} />
                </span>
                {step.ms === undefined ? (
                  <span className="tool-name">
                    Thinking
                    <span className="thinking-dots" aria-hidden="true" />
                  </span>
                ) : (
                  <span className="tool-name">Thought for {thoughtFor(step.ms)}</span>
                )}
              </li>
            ) : (
              <li key={step.id} className={`tool-row tool-${step.status}`} title={step.result}>
                <span className="tool-icon">{TOOL_ICONS[step.name] ?? <Wrench size={15} />}</span>
                <span className="tool-name">{step.name}</span>
                <span className="tool-detail">{step.detail}</span>
                <ToolStatus status={step.status} />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function ToolStatus({ status }: { status: ToolItem["status"] }) {
  switch (status) {
    case "running":
      return (
        <span className="tool-status spin" aria-label="running">
          <CircleNotch size={15} />
        </span>
      )
    case "ok":
      return (
        <span className="tool-status ok" aria-label="done">
          <CheckCircle size={15} />
        </span>
      )
    case "failed":
      return (
        <span className="tool-status failed" aria-label="failed">
          <XCircle size={15} />
        </span>
      )
    case "stopped":
      return (
        <span className="tool-status stopped" aria-label="stopped">
          <StopCircle size={15} />
        </span>
      )
  }
}

function RequestCard({ item }: { item: Extract<ChatItem, { kind: "request" }> }) {
  const answer = useChat((s) => s.answer)
  const [reply, setReply] = useState("")
  const [hide, setHide] = useState(true)
  const { request } = item
  const open = item.state === "open"
  if (request.kind === "handover") {
    const handed = typeof item.answer === "object" ? item.answer : undefined
    return (
      <div className="request-card" aria-label="Take over the browser">
        <div className="request-title">
          <HandGrabbing size={17} />
          Take over the browser
        </div>
        <p>
          Kif asks: <b>{request.task}</b>
          {request.doneWhen !== undefined && <> (done when {request.doneWhen})</>}
        </p>
        <p className="request-origin">
          {request.where === "check" && <>Checking scene {request.scene}: </>}
          {request.where === "record" && (
            <>Recording scene {request.scene} (this part isn’t filmed): </>
          )}
          On <span className="mono">{request.origin || "a blank page"}</span>
          {!request.onApp && (
            <span className="request-warn">
              <Warning size={13} /> not one of this project’s apps
            </span>
          )}
        </p>
        {open ? (
          <>
            <p className="request-hint">
              Act in the Live app: Kif sees nothing until you’re done, and nothing is filmed. For a
              password, use Secrets. Clear anything sensitive you leave on the page before Done: Kif
              reads the page after. Dialogs and file pickers don’t show here yet.
            </p>
            <textarea
              className="request-note"
              aria-label="A note for Kif"
              placeholder="A note for Kif (optional)"
              value={reply}
              maxLength={2000}
              onChange={(e) => setReply(e.target.value)}
            />
            <label className="request-check">
              <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
              Hide what I typed from Kif
            </label>
            <div className="request-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => answer(item.id, { outcome: "declined", note: reply, hide })}
              >
                Can’t do it
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => answer(item.id, { outcome: "done", note: reply, hide })}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <div className="request-state">
            {item.state === "closed"
              ? "Closed: the run stopped."
              : handed?.outcome === "done"
                ? "Done: back to Kif."
                : "Couldn’t do it: back to Kif."}
          </div>
        )}
      </div>
    )
  }
  if (request.kind === "approve-risky") {
    return (
      <div className="request-card" aria-label="Approve a risky step?">
        <div className="request-title">
          <HandPointing size={17} />
          Approve a risky step?
        </div>
        <p>
          Kif wants to run <b>{request.action}</b> in the live app. It may change real data (a
          delete, a send).
        </p>
        <div className="request-meta mono">
          <span>scene {request.scene}</span>
          <span>step {request.step}</span>
        </div>
        {open ? (
          <div className="request-actions">
            <button type="button" className="btn btn-ghost" onClick={() => answer(item.id, false)}>
              Decline
            </button>
            <button type="button" className="btn btn-primary" onClick={() => answer(item.id, true)}>
              Approve this step
            </button>
          </div>
        ) : (
          <div className="request-state">
            {item.state === "closed"
              ? "Closed: the run stopped."
              : item.answer === true
                ? "Approved."
                : "Declined."}
          </div>
        )}
      </div>
    )
  }
  if (request.kind === "approve-secret") {
    // The question itself is the dialog over the window (the field outlined): here, its trace.
    return (
      <div className="request-card" aria-label="A secret to approve">
        <div className="request-title">
          <LockKey size={17} />
          Type <span className="mono">{request.secret}</span> here?
        </div>
        <p>
          {request.step}, on {request.origin}
          {request.path}
        </p>
        <div className="request-state">
          {open
            ? "Waiting for your answer in the dialog."
            : item.state === "closed"
              ? "Closed: the run stopped."
              : item.answer === true
                ? "Allowed: later takes type it without asking."
                : "Declined: the scene can't type it."}
        </div>
      </div>
    )
  }
  if (request.kind === "approve-app") return <AppCardView item={item} request={request} />
  if (request.kind === "approve-file") {
    const deleting = request.action === "delete"
    return (
      <div className="request-card" aria-label={deleting ? "Delete a file?" : "Replace a file?"}>
        <div className="request-title">
          <FileText size={17} />
          {deleting ? "Delete a file?" : "Replace a file?"}
        </div>
        <p>
          Kif wants to {deleting ? "delete" : "replace the whole of"}{" "}
          <span className="mono">{request.path}</span>
          {deleting ? "" : ", which it didn’t write"}. Its current version is kept in Kiframe’s
          data.
        </p>
        {open ? (
          <div className="request-actions">
            <button type="button" className="btn btn-ghost" onClick={() => answer(item.id, false)}>
              Keep it
            </button>
            <button type="button" className="btn btn-primary" onClick={() => answer(item.id, true)}>
              {deleting ? "Delete it" : "Replace it"}
            </button>
          </div>
        ) : (
          <div className="request-state">
            {item.state === "closed"
              ? "Closed: the run stopped."
              : item.answer === true
                ? deleting
                  ? "Allowed to delete it."
                  : "Allowed to replace it."
                : "Kept."}
          </div>
        )}
      </div>
    )
  }
  if (request.kind !== "question") {
    // A request this window doesn't know: never answered by accident, only declined.
    return (
      <div className="request-card" aria-label="A request this version can't show">
        <p>Kif asked for something this version of Kiframe can’t show.</p>
        {open && (
          <div className="request-actions">
            <button type="button" className="btn btn-ghost" onClick={() => answer(item.id, false)}>
              Decline
            </button>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="request-card" aria-label="Kif asks">
      <div className="request-title">
        <Question size={17} />
        Kif asks
      </div>
      <p>{request.question}</p>
      {open ? (
        <form
          className="request-reply"
          onSubmit={(e) => {
            e.preventDefault()
            if (reply.trim() !== "") answer(item.id, reply.trim())
          }}
        >
          <label htmlFor={`reply-${item.id}`} className="sr-only">
            Your answer
          </label>
          <input
            id={`reply-${item.id}`}
            value={reply}
            maxLength={5000}
            placeholder="Your answer"
            onChange={(e) => setReply(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={reply.trim() === ""}>
            Answer
          </button>
        </form>
      ) : (
        <div className="request-state">
          {item.state === "closed"
            ? "Closed: the run stopped."
            : `You answered: ${typeof item.answer === "object" ? "" : String(item.answer)}`}
        </div>
      )}
    </div>
  )
}

/** What the picker offers (main checks every file again, by its content). */
const ACCEPT = ATTACHABLE.map((e) => `.${e}`).join(",")

/** A file's size as said on its chip. */
export function sizeSaid(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * An image or a text file, by its name (never its content: nothing attached is rendered); an SVG
 * is read as text by the agent, so shown as one.
 */
function FileIcon({ name }: { name: string }) {
  return /\.(png|jpe?g|gif|webp)$/i.test(name) ? (
    <ImageSquare size={13} aria-hidden />
  ) : (
    <FileText size={13} aria-hidden />
  )
}

function Composer() {
  const running = useChat((s) => s.running)
  const model = useChat((s) => s.model)
  const refused = useChat((s) => s.refused)
  const send = useChat((s) => s.send)
  const stop = useChat((s) => s.stop)
  const items = useChat((s) => s.items)
  const pending = useChat((s) => s.pending)
  const attach = useChat((s) => s.attach)
  const detach = useChat((s) => s.detach)
  const picker = useRef<HTMLInputElement>(null)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const empty = text.trim() === "" && pending.length === 0
  const submit = async () => {
    const message = text.trim()
    if (empty || sending) return
    setSending(true)
    if (await send(message)) setText("")
    setSending(false)
  }
  // A pasted image (a screenshot, an image copied from a page) is attached; anything with plain
  // text (cells, rich text that also comes as a picture) is typed as usual.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length === 0 || [...event.clipboardData.types].includes("text/plain")) return
    event.preventDefault()
    attach(files.map((f) => pastedFile(f)))
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }
  const waiting = items.some((i) => i.kind === "request" && i.state === "open")
  const current = [...items].reverse().find((i) => i.kind === "tool" && i.status === "running")
  // One box for both states, as tall (nothing in the window moves when a run starts or ends):
  // running, the status where the text goes and Stop where Send is.
  return (
    <div className="composer-wrap">
      <form
        className={running ? "composer working" : "composer"}
        onSubmit={(e) => {
          e.preventDefault()
          if (!running) void submit()
        }}
      >
        {running ? (
          <div className="working-head">
            <span className="spin accent">
              <CircleNotch size={18} />
            </span>
            {/* Only the status is announced (never the chip and Stop with each step). */}
            <div className="working-text" role="status">
              <span className="working-title">Kif is working</span>
              <span className="working-sub">
                {waiting
                  ? "waiting for your answer"
                  : current?.kind === "tool"
                    ? `${current.name} ${current.detail}`
                    : "thinking"}
              </span>
            </div>
          </div>
        ) : (
          <>
            <label htmlFor="ask" className="sr-only">
              Message Kif
            </label>
            <textarea
              id="ask"
              rows={2}
              maxLength={20_000}
              placeholder="Describe a scene, or ask for changes…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              onPaste={onPaste}
            />
            {pending.length > 0 && (
              <ul className="pending-files" aria-label="Files to send">
                {pending.map((file, i) => (
                  <li key={`${file.name}-${i}`} className="file-chip">
                    <FileIcon name={file.name === "" ? "pasted.png" : file.name} />
                    <span className="file-name">
                      {file.name === "" ? "Pasted image" : file.name}
                    </span>
                    <span className="file-size">{sizeSaid(file.size)}</span>
                    <button
                      type="button"
                      className="file-remove"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => detach(i)}
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="composer-row">
          {!running && (
            <>
              <button
                type="button"
                className="attach-btn"
                aria-label="Attach files"
                title="Attach images, text or HTML"
                onClick={() => picker.current?.click()}
              >
                <Paperclip size={17} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                accept={ACCEPT}
                data-testid="attach-input"
                onChange={(e) => {
                  if (e.target.files !== null) attach([...e.target.files])
                  e.target.value = ""
                }}
              />
            </>
          )}
          {model !== "" && <span className="chip mono">{model}</span>}
          <div className="spacer" />
          {running ? (
            <button type="button" className="btn btn-stop" onClick={stop}>
              <Stop size={14} weight="fill" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              aria-label="Send"
              disabled={empty || sending}
            >
              <PaperPlaneRight size={17} weight="fill" />
            </button>
          )}
        </div>
        {!running && refused !== null && (
          <div className="composer-refused" role="alert">
            {refused}
          </div>
        )}
      </form>
    </div>
  )
}

/**
 * Adding a site to the project: the site first, as the browser will reach it (its host, never a
 * name the agent picked), what's notable about it, what allowing grants, then the agent's reason as
 * its words.
 */
function AppCardView({
  item,
  request,
}: {
  item: Extract<ChatItem, { kind: "request" }>
  request: Extract<ChatItem, { kind: "request" }>["request"] & { kind: "approve-app" }
}) {
  const answer = useChat((s) => s.answer)
  const open = item.state === "open"
  return (
    <div className="request-card" aria-label="Add a site to the project?">
      <div className="request-title">
        <Globe size={17} />
        Add a site to this project?
      </div>
      <p className="app-card-host mono">{request.host}</p>
      <ul className="app-card-notes">
        <li>Every page on this site, as the app “{request.name}”.</li>
        {request.plain && <li className="app-card-warn">Not encrypted (http).</li>}
        {request.lookalike && (
          <li className="app-card-warn">
            Its name uses lookalike characters: check it’s the site you mean.
          </li>
        )}
        {request.local && <li>On your computer or local network.</li>}
        <li>
          Scenes may open it from now on.
          {request.secrets === 0 && " No secret is shared with it."}
          {request.secrets === undefined &&
            " (Your secrets couldn’t be read: none are counted here.)"}
          {request.secrets !== undefined &&
            request.secrets > 0 &&
            ` ${request.secrets} saved ${request.secrets === 1 ? "secret" : "secrets"} for this site come with it.`}
        </li>
        {request.usedBy.length > 0 && (
          <li className="app-card-warn">
            {request.usedBy.length}{" "}
            {request.usedBy.length === 1 ? "scene already names" : "scenes already name"} “
            {request.name}”: {request.usedBy.map((t) => `“${t}”`).join(", ")}. They’ll open this
            site.
          </li>
        )}
      </ul>
      {request.why !== "" && (
        <p className="app-card-why">
          <span className="app-card-label">Kif says (pages it read can influence this):</span>{" "}
          {request.why}
        </p>
      )}
      {open ? (
        <div className="request-actions">
          <button type="button" className="btn btn-ghost" onClick={() => answer(item.id, false)}>
            Decline
          </button>
          <button type="button" className="btn btn-primary" onClick={() => answer(item.id, true)}>
            Add {request.host}
          </button>
        </div>
      ) : (
        <div className="request-state">
          {item.state === "closed"
            ? "Closed: the run stopped."
            : item.answer === true
              ? "Added."
              : "Declined."}
        </div>
      )}
    </div>
  )
}
