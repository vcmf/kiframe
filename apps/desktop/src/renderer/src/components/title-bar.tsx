// The window's top: the wordmark, the project menu, the app it films.
import { CaretDown, Export, FolderSimple, Globe, Key } from "@phosphor-icons/react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api.ts"
import { useApp } from "../store.ts"
import { SecretsPanel } from "./secrets-panel.tsx"

export function TitleBar() {
  const status = useApp((s) => s.status)
  const project = status?.project ?? null
  return (
    <header className={`titlebar ${api().platform === "darwin" ? "mac" : "overlay"}`}>
      <div className="wordmark" aria-label="Kiframe">
        kiframe
        <span className="wordmark-dot" />
      </div>
      {project !== null && (
        <>
          <div className="titlebar-sep" />
          <ProjectMenu name={project.name} />
          <div className="spacer" />
          {project.url !== null && (
            <span className="chip" title={project.url}>
              <Globe size={13} />
              {hostOf(project.url)}
            </span>
          )}
          {project.url !== null && (
            <SecretsButton key={project.session} origin={new URL(project.url).origin} />
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled
            title="Export comes with the preview"
          >
            <Export size={16} />
            Export
          </button>
        </>
      )}
    </header>
  )
}

function SecretsButton({ origin }: { origin: string }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
        <Key size={16} />
        Secrets
      </button>
      {open && <SecretsPanel origin={origin} onClose={close} />}
    </>
  )
}

function ProjectMenu({ name }: { name: string }) {
  const run = useApp((s) => s.run)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    // The window losing focus closes it too.
    const blur = () => setOpen(false)
    document.addEventListener("keydown", close)
    window.addEventListener("blur", blur)
    return () => {
      document.removeEventListener("keydown", close)
      window.removeEventListener("blur", blur)
    }
  }, [open])
  const pick = (action: () => Promise<void>) => () => {
    setOpen(false)
    void action()
  }
  return (
    <div className="menu-anchor">
      <button
        type="button"
        className="project-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <FolderSimple size={16} />
        {name}
        <CaretDown size={13} />
      </button>
      {open && (
        <div
          className="menu-backdrop"
          data-testid="menu-backdrop"
          onMouseDown={() => setOpen(false)}
        />
      )}
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={pick(() => run("project:open"))}>
            Open another project…
          </button>
          <button type="button" role="menuitem" onClick={pick(() => run("project:close"))}>
            Close project
          </button>
          <div className="menu-sep" />
          <button type="button" role="menuitem" onClick={pick(() => run("key:clear"))}>
            Change OpenRouter key…
          </button>
        </div>
      )}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
