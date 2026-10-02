// The project's secrets: names and kinds (never values), whether each has its value here, and a
// form to add one. A value typed here goes to main once, to the keychain; it never comes back.
import { Key, Trash, WarningCircle, X } from "@phosphor-icons/react"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import type { SecretView } from "../../../shared/ipc.ts"
import { api } from "../api.ts"

const KINDS: { kind: SecretView["kind"]; label: string }[] = [
  { kind: "password", label: "Password" },
  { kind: "username", label: "Username or email" },
  { kind: "api_key", label: "API key" },
  { kind: "text", label: "Other text" },
]

export function SecretsPanel({ origin, onClose }: { origin: string; onClose: () => void }) {
  const [secrets, setSecrets] = useState<SecretView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [kind, setKind] = useState<SecretView["kind"]>("password")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    api()
      .invoke("secrets:list")
      .then(setSecrets, (e: unknown) => setError(String(e)))
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
      // A secret's approval over the panel takes Escape (it's on top): the panel stays.
      if (event.key === "Escape" && !document.querySelector('[aria-labelledby="secret-title"]')) {
        close.current()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || name.trim() === "" || value === "") return
    setBusy(true)
    const refused = await api()
      .invoke("secrets:add", { name: name.trim(), kind, value })
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

  const remove = async (secret: string) => {
    if (busy) return
    setBusy(true)
    const refused = await api()
      .invoke("secrets:remove", secret)
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
        <p className="dialog-text">
          Logins and keys the agent may type on <span className="mono">{origin}</span>. It only ever
          sees their names: values stay in your system’s keychain, and are blurred in every take.
        </p>
        {secrets === null ? null : secrets.length === 0 ? (
          <p className="dialog-empty">No secrets yet.</p>
        ) : (
          <ul className="secret-list" aria-label="The project's secrets">
            {secrets.map((s) => (
              <li key={s.name}>
                <Key size={15} />
                <span className="mono secret-name">{s.name}</span>
                <span className="secret-kind">{KINDS.find((k) => k.kind === s.kind)?.label}</span>
                {!s.provided && <span className="secret-missing">no value here</span>}
                <div className="spacer" />
                {removing === s.name ? (
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
                      onClick={() => void remove(s.name)}
                    >
                      Remove {s.name}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${s.name}`}
                    onClick={() => setRemoving(s.name)}
                  >
                    <Trash size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
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
            <span className="field-hint">What scenes call it: {"{{secrets.acme.password}}"}</span>
          </div>
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
      </div>
    </div>
  )
}
