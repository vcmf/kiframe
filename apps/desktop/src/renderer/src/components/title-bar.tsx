// The window's top: the wordmark, the project menu, the app it films.
import { CaretDown, Export, FolderSimple, Globe } from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"
import { api } from "../api.ts"
import { useApp } from "../store.ts"

export function TitleBar() {
  const status = useApp((s) => s.status)
  const project = status?.project ?? null
  return (
    <header className={`titlebar${api().platform === "darwin" ? " mac" : ""}`}>
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

function ProjectMenu({ name }: { name: string }) {
  const run = useApp((s) => s.run)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !ref.current?.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", close)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", close)
    }
  }, [open])
  const pick = (action: () => Promise<void>) => () => {
    setOpen(false)
    void action()
  }
  return (
    <div className="menu-anchor" ref={ref}>
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
