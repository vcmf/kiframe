// The project's apps: each with its exact origin (main's), and a way to remove one (never the
// first: where scenes start). Main asks before removing, naming the scenes that use it.
import { Globe, WarningCircle, X } from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"
import type { ProjectView } from "../../../shared/ipc.ts"
import { api } from "../api.ts"
import { useChat } from "../chat-store.ts"

export function AppsPanel({
  project,
  onClose,
}: {
  project: Pick<ProjectView, "session" | "apps">
  onClose: () => void
}) {
  const running = useChat((s) => s.running)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const remove = async (name: string, origin: string) => {
    if (busy) return
    setBusy(true)
    const refused = await api()
      .invoke("apps:remove", { session: project.session, name, origin })
      .catch((e: unknown) => String(e))
    setBusy(false)
    setError(refused)
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
          The sites this project’s scenes may open. Kif asks before adding one.
        </p>
        <ul className="app-list" aria-label="The project's apps">
          {project.apps.map((app, i) => (
            <li key={app.name}>
              <Globe size={15} />
              <span className="mono">{app.name}</span>
              <span className="mono app-origin">{app.origin}</span>
              <div className="spacer" />
              {i === 0 ? (
                <span className="app-first">Where scenes start</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy || running}
                  title={running ? "Kif is working: stop it first" : undefined}
                  onClick={() => void remove(app.name, app.origin)}
                >
                  Remove {app.name}
                </button>
              )}
            </li>
          ))}
        </ul>
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
