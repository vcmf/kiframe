// The project's apps: each with its exact origin (main's) or its bundle id, and a way to remove one
// (never the first: where scenes start). Main asks before removing, naming the scenes that use it.
// On macOS, a desktop app is added here: main shows the picker and inspects it, the card tries it
// confined, then adds it (the window holds a token, never the app's path or a site to allow).
import { AppWindow, Globe, WarningCircle, X } from "@phosphor-icons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  appViewIdentity,
  type DesktopCheck,
  type DesktopPick,
  type DesktopStatusView,
  type ProjectView,
} from "../../../shared/ipc.ts"
import { api } from "../api.ts"
import { useChat } from "../chat-store.ts"

type Card = Extract<DesktopPick, { card: unknown }>["card"]

/** A desktop app's status on this Mac, in words. */
function statusText(entry: DesktopStatusView["apps"][string] | undefined): string {
  if (entry === undefined) return ""
  if (entry.status === "ready") return "Ready on this Mac"
  if (entry.status === "updated") return "Updated: tried confined before its next run"
  return entry.why ?? ""
}

export function AppsPanel({
  project,
  onClose,
}: {
  project: Pick<ProjectView, "session" | "apps">
  onClose: () => void
}) {
  const running = useChat((s) => s.running)
  const mac = api().platform === "darwin"
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [statuses, setStatuses] = useState<DesktopStatusView["apps"]>({})
  const [card, setCard] = useState<Card | null>(null)
  const [outcome, setOutcome] = useState<DesktopCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [picking, setPicking] = useState(false)
  const [adding, setAdding] = useState(false)
  // The card a check's answer belongs to (an answer for a card given up: dropped).
  const current = useRef<string | null>(null)
  current.current = card?.token ?? null
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const hasDesktop = project.apps.some((a) => a.kind === "electron")
  const refresh = useCallback(async () => {
    if (!hasDesktop) return
    const view = await api()
      .invoke("apps:desktop-status", { session: project.session })
      .catch((e: unknown) => {
        setError(`the desktop apps' status couldn't be read: ${String(e)}`)
        return null
      })
    if (view === null) return
    setStatuses(view.apps)
    if (view.problem !== null) setError(view.problem)
  }, [hasDesktop, project.session])
  useEffect(() => {
    void refresh()
  }, [refresh])

  // An add given up when the panel closes (its trial ended in main).
  useEffect(
    () => () =>
      void api()
        .invoke("apps:desktop-cancel")
        .catch(() => undefined),
    [],
  )

  const remove = async (name: string, identity: string) => {
    if (busy) return
    setBusy(true)
    const refused = await api()
      .invoke("apps:remove", { session: project.session, name, identity })
      .catch((e: unknown) => String(e))
    setBusy(false)
    setError(refused)
  }

  // Busy flags read at once (a double click within one frame sees the first).
  const pickingNow = useRef(false)
  const addingNow = useRef(false)
  // The card a check is under way for (another card's Check is its own).
  const checkingNow = useRef<string | null>(null)
  const pick = async () => {
    if (pickingNow.current || addingNow.current) return
    pickingNow.current = true
    setError(null)
    setOutcome(null)
    setPicking(true)
    const picked = await api()
      .invoke("apps:desktop-pick", { session: project.session })
      .catch((e: unknown) => ({ refused: String(e) }))
    pickingNow.current = false
    setPicking(false)
    if (picked === null) return
    if ("refused" in picked) {
      setCard(null)
      setError(picked.refused)
      return
    }
    setCard(picked.card)
  }

  const check = async (allowSite: boolean) => {
    if (card === null || checkingNow.current === card.token) return
    const token = card.token
    checkingNow.current = token
    setChecking(true)
    setOutcome(null)
    const result = await api()
      .invoke("apps:desktop-check", { session: project.session, token, allowSite })
      .catch((e: unknown) => ({ failed: String(e) }))
    if (checkingNow.current === token) checkingNow.current = null
    // Given up meanwhile (cancelled, another app picked): never shown on another card.
    if (current.current !== token) return
    setChecking(false)
    setOutcome(result)
  }

  const add = async () => {
    if (card === null || addingNow.current) return
    const token = card.token
    addingNow.current = true
    setAdding(true)
    const refused = await api()
      .invoke("apps:desktop-add", { session: project.session, token })
      .catch((e: unknown) => String(e))
    addingNow.current = false
    setAdding(false)
    // Given up meanwhile (cancelled, another app picked): never said on another card.
    if (current.current !== token) {
      if (refused === null) await refresh()
      return
    }
    if (refused !== null) {
      setError(refused)
      return
    }
    setCard(null)
    setOutcome(null)
    await refresh()
  }

  const cancel = () => {
    setCard(null)
    setOutcome(null)
    setChecking(false)
    void api()
      .invoke("apps:desktop-cancel")
      .catch(() => undefined)
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="apps-title">
        <div className="dialog-head row">
          <h2 id="apps-title">Apps</h2>
          <div className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-text">
          The sites and desktop apps this project’s scenes may open. Kif asks before adding a site;
          you add desktop apps.
        </p>
        <ul className="app-list" aria-label="The project's apps">
          {project.apps.map((app, i) => (
            <li key={app.name}>
              {app.kind === "electron" ? <AppWindow size={15} /> : <Globe size={15} />}
              <span className="mono">{app.name}</span>
              <span className="mono app-origin">{appViewIdentity(app)}</span>
              {app.kind === "electron" && (
                <span className="app-first">{statusText(statuses[app.name])}</span>
              )}
              <div className="spacer" />
              {i === 0 ? (
                <span className="app-first">Where scenes start</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy || running}
                  title={running ? "Kif is working: stop it first" : undefined}
                  onClick={() => void remove(app.name, appViewIdentity(app))}
                >
                  Remove {app.name}
                </button>
              )}
            </li>
          ))}
        </ul>
        {mac && card === null && (
          <button
            type="button"
            className="btn"
            disabled={running || picking || adding}
            title={running ? "Kif is working: stop it first" : undefined}
            onClick={() => void pick()}
          >
            {picking ? "Looking at the app…" : "Add desktop app…"}
          </button>
        )}
        {card !== null && (
          <section className="app-card" aria-label={`Adding ${card.name}`}>
            <p>
              <strong>{card.name}</strong> {card.version ?? ""} · Electron {card.electron} ·{" "}
              {card.signer.kind === "team"
                ? `signed by developer ${card.signer.team}`
                : "not signed by a developer: pinned to this build"}
            </p>
            {card.existing !== undefined && (
              <p className="app-card-why">
                This project names it already (as {card.existing}): checking it allows it here, with
                what the project opens with it:{" "}
                {card.opens === undefined ||
                (card.opens.args.length === 0 && card.opens.origins.length === 0)
                  ? "nothing more."
                  : [
                      ...card.opens.origins.map((o) => `the site ${o} as its own`),
                      ...card.opens.args.map((a) => `${a} (not opened by the check)`),
                    ].join(", ")}
              </p>
            )}
            <p className="app-card-why">
              Kiframe opens {card.name} confined (it can’t read or change your files, your own{" "}
              {card.name}’s data or its preferences) for a few seconds, to check it works there.
            </p>
            {outcome !== null && <p role="status">{outcomeText(outcome, card.name)}</p>}
            <div className="row">
              {outcome !== null && "ok" in outcome ? (
                <button type="button" className="btn" disabled={adding} onClick={() => void add()}>
                  {card.existing === undefined ? `Add ${card.name}` : `Allow ${card.name} here`}
                </button>
              ) : outcome !== null && "site" in outcome ? (
                <button
                  type="button"
                  className="btn"
                  disabled={checking}
                  onClick={() => void check(true)}
                >
                  Allow {outcome.site} and check again
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={checking || running}
                  onClick={() => void check(false)}
                >
                  {checking ? "Checking…" : "Check"}
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={cancel}>
                Cancel
              </button>
            </div>
          </section>
        )}
        {error !== null && (
          <div className="error" role="alert">
            <WarningCircle size={16} weight="fill" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** A trial's outcome, in words. */
function outcomeText(outcome: DesktopCheck, name: string): string {
  if ("ok" in outcome) return `${name} runs confined: Kiframe can drive it.`
  if ("site" in outcome) {
    return `${name}’s window is the site ${outcome.site}: if that’s ${name}’s own, allow it.`
  }
  if ("quit" in outcome) return `${name} quit at once: it may refuse automation.`
  return outcome.failed
}
