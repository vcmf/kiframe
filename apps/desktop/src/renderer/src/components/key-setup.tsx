// First run, step 1: the OpenRouter key (kept in the OS keychain, never shown again).
import { Key } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import { api } from "../api.ts"
import { useApp } from "../store.ts"
import { ErrorNote } from "./error-note.tsx"

export function KeySetup() {
  const run = useApp((s) => s.run)
  const busy = useApp((s) => s.busy)
  const error = useApp((s) => s.status?.error)
  const [key, setKey] = useState("")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (key.trim() === "") return
    void run("key:set", key)
  }
  return (
    <main className="setup">
      <form className="setup-card" onSubmit={submit}>
        <div className="setup-icon">
          <Key size={21} />
        </div>
        <h1>Connect a model</h1>
        <p>
          Kiframe’s agent runs on OpenRouter. Paste your API key: it’s kept in your system’s
          keychain and never shown again.
        </p>
        <div className="field">
          <label htmlFor="key">OpenRouter API key</label>
          <input
            id="key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-or-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <span className="field-hint">
            No key yet?{" "}
            <button
              type="button"
              className="link-btn"
              onClick={() => void api().invoke("external:open", "https://openrouter.ai/keys")}
            >
              Create one on OpenRouter
            </button>
          </span>
        </div>
        <ErrorNote error={error} />
        <div className="setup-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={key.trim() === "" || busy !== null}
          >
            {busy === "key:set" ? "Saving…" : "Save key"}
          </button>
        </div>
      </form>
    </main>
  )
}
