// The window's top: the wordmark, the project menu, the app it films.
import { CaretDown, Export, FolderSimple, Globe, Key } from "@phosphor-icons/react"
import { useCallback, useEffect, useState } from "react"
import type { ProjectView } from "../../../shared/ipc.ts"
import { api } from "../api.ts"
import { useApp } from "../store.ts"
import { AppsPanel } from "./apps-panel.tsx"
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
          <AppsButton key={`apps-${project.session}`} project={project} />
          <SecretsButton key={project.session} project={project} />
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

/** The first app's host, as a button opening the apps panel (with how many more there are). */
function AppsButton({ project }: { project: Pick<ProjectView, "session" | "apps" | "url"> }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const more = project.apps.length - 1
  return (
    <>
      <button
        type="button"
        className="chip chip-button"
        title={project.apps.map((a) => `${a.name}: ${a.origin}`).join("\n")}
        onClick={() => setOpen(true)}
      >
        <Globe size={13} />
        {hostOf(project.url)}
        {more > 0 && <span className="chip-more">+{more}</span>}
      </button>
      {open && <AppsPanel project={project} onClose={close} />}
    </>
  )
}

function SecretsButton({ project }: { project: Pick<ProjectView, "session" | "apps"> }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
        <Key size={16} />
        Secrets
      </button>
      {open && <SecretsPanel project={project} onClose={close} />}
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
