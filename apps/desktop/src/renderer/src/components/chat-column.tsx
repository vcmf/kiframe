// The chat column: the user's messages, the agent's answers and tool steps (grouped, collapsible),
// its requests as cards, and the composer (a status bar with Stop while the agent works).
import {
  CaretDown,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  CircleNotch,
  CursorClick,
  HandPointing,
  Key,
  ListBullets,
  ListChecks,
  LockKey,
  MagnifyingGlass,
  PaperPlaneRight,
  Question,
  Record,
  Sparkle,
  Stop,
  StopCircle,
  Wrench,
  XCircle,
} from "@phosphor-icons/react"
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { ChatItem } from "../../../shared/ipc.ts"
import { useChat } from "../chat-store.ts"
import { AgentText } from "./markdown.tsx"

type ToolItem = Extract<ChatItem, { kind: "tool" }>

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

/** Items in order, consecutive tool steps as one group. */
type Block = { kind: "item"; item: ChatItem } | { kind: "tools"; id: string; tools: ToolItem[] }

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
    if (item.kind === "tool" && last?.kind === "tools") last.tools.push(item)
    else if (item.kind === "tool") out.push({ kind: "tools", id: item.id, tools: [item] })
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
  const connect = useChat((s) => s.connect)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => connect(), [connect])
  // The log is reversed (CSS): its end is scrollTop 0, so layout keeps it there as the chat grows
  // or the log resizes, and anchoring holds a reader who scrolled up. Code moves it only for a new
  // item that needs the user: their own message, or a request the run waits on.
  const seen = useRef(new Set<string>())
  useLayoutEffect(() => {
    const log = body.current
    if (newNeedUser(items, seen.current) && log !== null) log.scrollTop = 0
  }, [items])
  return (
    <aside className="chat" aria-label="Chat">
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
                Say what the video should show, and the agent splits it into scenes, tries each step
                on your app and films it.
              </p>
            </div>
          ) : (
            turns(items).map((turn) =>
              turn.kind === "user" ? (
                <Item key={turn.item.id} item={turn.item} />
              ) : (
                <AgentTurn key={turn.id} blocks={turn.blocks} />
              ),
            )
          )}
        </div>
      </div>
      <Composer />
    </aside>
  )
}

/** One agent turn: its mark above, then all it did at the column's full width. */
function AgentTurn({ blocks: parts }: { blocks: Block[] }) {
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
        <Sparkle size={20} weight="fill" />
      </span>
      {parts.map((block) =>
        block.kind === "tools" ? (
          <ToolGroup key={block.id} tools={block.tools} />
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
      return <div className="msg-user">{item.text}</div>
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
                ? `The agent ${item.message ?? "stopped"}: say how to go on.`
                : (item.message ?? "The agent failed.")}
          </span>
        </div>
      )
    case "tool":
      return <ToolGroup tools={[item]} />
  }
}

function ToolGroup({ tools }: { tools: ToolItem[] }) {
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
  const running = tools.some((t) => t.status === "running")
  const failed = tools.filter((t) => t.status === "failed").length
  const summary = `${tools.length} ${tools.length === 1 ? "step" : "steps"}${running ? " · running" : ""}${failed > 0 ? ` · ${failed} failed` : ""}`
  return (
    <div className="tool-group">
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
      {open && (
        <ul className="tool-list">
          {tools.map((tool) => (
            <li key={tool.id} className={`tool-row tool-${tool.status}`} title={tool.result}>
              <span className="tool-icon">{TOOL_ICONS[tool.name] ?? <Wrench size={15} />}</span>
              <span className="tool-name">{tool.name}</span>
              <span className="tool-detail">{tool.detail}</span>
              <ToolStatus status={tool.status} />
            </li>
          ))}
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
  const { request } = item
  const open = item.state === "open"
  if (request.kind === "approve-risky") {
    return (
      <div className="request-card" aria-label="Approve a risky step?">
        <div className="request-title">
          <HandPointing size={17} />
          Approve a risky step?
        </div>
        <p>
          The agent wants to run <b>{request.action}</b> in the live app. It may change real data (a
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
  return (
    <div className="request-card" aria-label="The agent asks">
      <div className="request-title">
        <Question size={17} />
        The agent asks
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
            : `You answered: ${String(item.answer)}`}
        </div>
      )}
    </div>
  )
}

function Composer() {
  const running = useChat((s) => s.running)
  const model = useChat((s) => s.model)
  const refused = useChat((s) => s.refused)
  const send = useChat((s) => s.send)
  const stop = useChat((s) => s.stop)
  const items = useChat((s) => s.items)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const submit = async () => {
    const message = text.trim()
    if (message === "" || sending) return
    setSending(true)
    if (await send(message)) setText("")
    setSending(false)
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
              <span className="working-title">The agent is working</span>
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
              Message the agent
            </label>
            <textarea
              id="ask"
              rows={2}
              maxLength={20_000}
              placeholder="Describe a scene, or ask for changes…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
          </>
        )}
        <div className="composer-row">
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
              disabled={text.trim() === "" || sending}
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
