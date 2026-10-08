// First run, step 2 (and after closing one): create a project for an app, or open one.
import { FilmSlate } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import { useApp } from "../store.ts"
import { ErrorNote } from "./error-note.tsx"

export function ProjectStart() {
  const run = useApp((s) => s.run)
  const busy = useApp((s) => s.busy)
  const error = useApp((s) => s.status?.error)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  // The address is checked in main (the project's own rule): its error comes back as the status's.
  const ready = name.trim() !== "" && url.trim() !== ""
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready) void run("project:create", { name: name.trim(), url: url.trim() })
  }
  return (
    <main className="setup">
      <form className="setup-card" onSubmit={submit}>
        <div className="setup-icon">
          <FilmSlate size={21} />
        </div>
        <h1>Start a demo</h1>
        <p>A project films one web app. Name it and give the address Kif should open.</p>
        <div className="field">
          <label htmlFor="name">Project name</label>
          <input
            id="name"
            maxLength={120}
            placeholder="Acme Billing demo"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="url">App address</label>
          <input
            id="url"
            maxLength={2048}
            type="text"
            inputMode="url"
            spellCheck={false}
            placeholder="https://app.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <span className="field-hint">
            Use a staging or demo account: Kif clicks through it for real.
          </span>
        </div>
        <ErrorNote error={error} />
        <div className="setup-actions">
          <button type="submit" className="btn btn-primary" disabled={!ready || busy !== null}>
            {busy === "project:create" ? "Creating…" : "Create project…"}
          </button>
        </div>
        <div className="divider">or</div>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          disabled={busy !== null}
          onClick={() => void run("project:open")}
        >
          {busy === "project:open" ? "Opening…" : "Open a project…"}
        </button>
      </form>
    </main>
  )
}
