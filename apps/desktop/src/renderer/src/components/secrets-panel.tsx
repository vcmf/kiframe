// The project's secrets, app by app: names and kinds (never values), whether each has its value
// here, and a form to add one for an app. A value typed here goes to main once, to the keychain; it
// never comes back. The window names an app, never an origin (main finds it in the project).
import { Key, Trash, WarningCircle, X } from "@phosphor-icons/react"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import type { ProjectView, SecretGroup, SecretView } from "../../../shared/ipc.ts"
import { api } from "../api.ts"

const KINDS: { kind: SecretView["kind"]; label: string }[] = [
  { kind: "password", label: "Password" },
  { kind: "username", label: "Username or email" },
  { kind: "api_key", label: "API key" },
  { kind: "text", label: "Other text" },
]

export function SecretsPanel({
  project,
  onClose,
}: {
  project: Pick<ProjectView, "session" | "apps">
  onClose: () => void
}) {
  const { session } = project
  // Web apps only: a desktop app takes no secrets (the user signs in by hand there).
  const apps = project.apps.filter((a) => a.kind === "web")
  const several = apps.length > 1
  const [groups, setGroups] = useState<SecretGroup[] | null>(null)
  const [app, setApp] = useState(apps[0]?.name ?? "")
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [kind, setKind] = useState<SecretView["kind"]>("password")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)

  // Answers in order: a late answer to an older request never overwrites a newer one.
  const asked = useRef(0)
  const load = useCallback(() => {
    const at = (asked.current += 1)
    api()
      .invoke("secrets:list")
      .then(
        (list) => {
          if (at === asked.current) setGroups(list)
        },
        (e: unknown) => {
          if (at === asked.current) setError(String(e))
        },
      )
  }, [])
  // Loaded and focused once, when it opens: a re-render (a status update while a value is being
  // typed) never moves focus, so a value never lands in the plain-text Name field.
  useEffect(() => {
    load()
    first.current?.focus()
  }, [load])
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A dialog over the panel (a secret's approval) took Escape first: the panel stays.
      if (event.key === "Escape" && !event.defaultPrevented) close.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || name.trim() === "" || value === "") return
    setBusy(true)
    const refused = await api()
      .invoke("secrets:add", { session, app, name: name.trim(), kind, value })
      .catch((e: unknown) => String(e))
    setBusy(false)
    if (refused !== null) {
      setError(refused)
      return
    }
    // The value is gone from the window once main has it.
    setValue("")
    setName("")
    setError(null)
    load()
  }

  const remove = async (from: string, secret: string) => {
    if (busy) return
    setBusy(true)
    const refused = await api()
      .invoke("secrets:remove", { session, app: from, name: secret })
      .catch((e: unknown) => String(e))
    setBusy(false)
    setRemoving(null)
    setError(refused)
    load()
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="secrets-title">
        <div className="dialog-head row">
          <h2 id="secrets-title">Secrets</h2>
          <div className="spacer" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {apps.length === 0 ? (
          <p className="dialog-text">
            None of this project’s apps takes secrets: in a desktop app, you sign in yourself when
            Kif asks.
          </p>
        ) : (
          <>
            <p className="dialog-text">
              Logins and keys Kif may type
              {several ? (
                ", app by app"
              ) : (
                <>
                  {" "}
                  on <span className="mono">{apps[0]?.origin}</span>
                </>
              )}
              . It only ever sees their names: values stay in your system’s keychain, and are
              blurred in every take.
            </p>
            <p className="dialog-text dialog-note">
              Use a throwaway demo account. Kif sees the page as text and screenshots, with your
              secrets hidden where the page shows them as text; a value drawn in an image or a
              canvas can’t be hidden.
            </p>
            {groups === null ? null : groups.every((g) => g.secrets.length === 0) ? (
              <p className="dialog-empty">No secrets yet.</p>
            ) : (
              groups.map((group) =>
                group.secrets.length === 0 ? null : (
                  <section key={group.app} className="secret-group">
                    {several && (
                      <h3 className="secret-app">
                        {group.app} <span className="mono">{group.origin}</span>
                      </h3>
                    )}
                    <ul
                      className="secret-list"
                      aria-label={several ? `Secrets of ${group.app}` : "The project's secrets"}
                    >
                      {group.secrets.map((s) => (
                        <li key={s.name}>
                          <Key size={15} />
                          <span className="mono secret-name">{s.name}</span>
                          <span className="secret-kind">
                            {KINDS.find((k) => k.kind === s.kind)?.label}
                          </span>
                          {!s.provided && <span className="secret-missing">no value here</span>}
                          <div className="spacer" />
                          {removing === `${group.app}/${s.name}` ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => setRemoving(null)}
                              >
                                Keep
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger"
                                onClick={() => void remove(group.app, s.name)}
                              >
                                Remove {s.name}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={`Remove ${s.name}`}
                              onClick={() => setRemoving(`${group.app}/${s.name}`)}
                            >
                              <Trash size={15} />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ),
              )
            )}
            <form className="secret-form" onSubmit={(e) => void add(e)}>
              <div className="field">
                <label htmlFor="secret-name">Name</label>
                <input
                  id="secret-name"
                  ref={first}
                  className="mono"
                  placeholder="acme.password"
                  maxLength={120}
                  spellCheck={false}
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <span className="field-hint">
                  What scenes call it: {"{{secrets.acme.password}}"}
                </span>
              </div>
              {several && (
                <div className="field">
                  <label htmlFor="secret-app">App</label>
                  <select id="secret-app" value={app} onChange={(e) => setApp(e.target.value)}>
                    {apps.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name} ({a.origin})
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">Typed on that app only.</span>
                </div>
              )}
              <div className="field">
                <label htmlFor="secret-kind">Kind</label>
                <select
                  id="secret-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as SecretView["kind"])}
                >
                  {KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="secret-value">Value</label>
                <input
                  id="secret-value"
                  type="password"
                  maxLength={4096}
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
              {error !== null && (
                <div className="error" role="alert">
                  <WarningCircle size={16} weight="fill" />
                  <span>{error}</span>
                </div>
              )}
              <div className="setup-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || name.trim() === "" || value === ""}
                >
                  {busy ? "Saving…" : "Add secret"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
