// A secret typed where no approval covers it yet (§3 A3): the page as it is with the field
// outlined, what it is, where, for which step. Built from what main says of the live page, never
// from the agent's words. Allowing grants it for this step, field and page (main does it).
import { LockKey, ShieldCheck } from "@phosphor-icons/react"
import { useEffect, useRef } from "react"
import type { ChatItem } from "../../../shared/ipc.ts"
import { useChat } from "../chat-store.ts"

type SecretItem = Extract<ChatItem, { kind: "request" }> & {
  request: { kind: "approve-secret" }
}

/** The open secret approval, if any (one at a time: the run waits on it). */
export function useOpenSecretApproval(): SecretItem | undefined {
  return useChat((s) =>
    s.items.find(
      (i): i is SecretItem =>
        i.kind === "request" && i.state === "open" && i.request.kind === "approve-secret",
    ),
  )
}

export function SecretDialog() {
  const item = useOpenSecretApproval()
  const answer = useChat((s) => s.answer)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (item === undefined) return
    // The dialog itself takes focus (never a button: a key the user was pressing elsewhere, a
    // space while typing, never answers it). Escape declines, for the top dialog only.
    dialog.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      answer(item.id, false)
    }
    document.addEventListener("keydown", onKey, { capture: true })
    return () => document.removeEventListener("keydown", onKey, { capture: true })
  }, [item, answer])
  if (item === undefined) return null
  const { request } = item
  const { shot, box } = request
  const what =
    request.element.tag === "textarea" ? "a text area" : `an input of type ${request.element.type}`
  return (
    <div className="dialog-backdrop">
      <div
        ref={dialog}
        tabIndex={-1}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secret-title"
      >
        <div className="dialog-head">
          <div className="setup-icon">
            <LockKey size={21} />
          </div>
          <h2 id="secret-title">Type a secret here?</h2>
          <p>
            The scene types <span className="mono">{request.secret}</span> into the field outlined
            below. Kiframe fills it in: the agent never sees the value, and it’s blurred in every
            take.
          </p>
        </div>
        {shot !== undefined && (
          <div className="shot">
            <img
              src={`data:image/jpeg;base64,${shot.jpeg}`}
              alt={`The page at ${request.path}, with the field outlined`}
            />
            {box !== undefined && (
              <span
                className="shot-outline"
                data-testid="secret-outline"
                style={{
                  left: `${(box.x / shot.width) * 100}%`,
                  top: `${(box.y / shot.height) * 100}%`,
                  width: `${(box.width / shot.width) * 100}%`,
                  height: `${(box.height / shot.height) * 100}%`,
                }}
              />
            )}
          </div>
        )}
        <dl className="facts">
          <dt>Field</dt>
          <dd>
            {request.element.label ?? "(no label)"} · {what}
          </dd>
          <dt>Page</dt>
          <dd className="mono">
            {request.origin}
            {request.path}
          </dd>
          <dt>Step</dt>
          <dd>
            {request.step} <span className="facts-note">(as the scene names it)</span>
          </dd>
        </dl>
        <div className="dialog-foot">
          <span className="dialog-note">
            <ShieldCheck size={14} />
            Asked once: later takes type it without asking
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => answer(item.id, false)}>
            Decline
          </button>
          <button type="button" className="btn btn-primary" onClick={() => answer(item.id, true)}>
            Allow here
          </button>
        </div>
      </div>
    </div>
  )
}
