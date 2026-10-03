// The stage: Preview / Live app tabs over the well, the scene strip below. A run shows the live
// app (view only: the agent's browser) until the user picks a tab.
import { Browser, FilmStrip, HandPointing, Monitor } from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"
import type { ProjectView } from "../../../shared/ipc.ts"
import { useChat } from "../chat-store.ts"
import { PreviewPlayer } from "./preview-player.tsx"
import { SceneStrip } from "./scene-strip.tsx"

type Tab = "preview" | "live"

export function Stage({ project }: { project: ProjectView }) {
  const [tab, setTab] = useState<Tab>("preview")
  const [selected, setSelected] = useState<string | null>(null)
  const running = useChat((s) => s.running)
  const frame = useChat((s) => s.frame)
  // A run starting shows the agent at work; ending with a scene filmed, that scene's preview.
  const takesAtStart = useRef<Map<string, string | undefined>>(new Map())
  useEffect(() => {
    if (running) {
      takesAtStart.current = new Map(project.scenes.map((s) => [s.id, s.take]))
      setTab("live")
      return
    }
    const filmed = project.scenes.find(
      (s) => s.take !== undefined && takesAtStart.current.get(s.id) !== s.take,
    )
    takesAtStart.current = new Map(project.scenes.map((s) => [s.id, s.take]))
    if (filmed !== undefined) {
      setSelected(filmed.id)
      setTab("preview")
    }
    // Only a run's start or end (the scenes it filmed are read then).
  }, [running])
  // The scene the preview shows: the one picked, else the first filmed one.
  const shown =
    project.scenes.find((s) => s.id === selected) ??
    project.scenes.find((s) => s.status === "recorded")
  return (
    <main className="stage">
      <div className="stage-head" role="tablist" aria-label="Stage">
        <TabButton
          tab="preview"
          current={tab}
          onPick={setTab}
          icon={<FilmStrip size={15} />}
          label="Preview"
        />
        <TabButton
          tab="live"
          current={tab}
          onPick={setTab}
          icon={<Browser size={15} />}
          label="Live app"
          live={running}
        />
        <div className="spacer" />
        {tab === "live" && running && (
          <span className="chip">
            <HandPointing size={13} />
            Agent driving
          </span>
        )}
        {tab === "live" && frame !== null && <span className="stage-path mono">{frame.path}</span>}
      </div>
      <section
        className="stage-well"
        role="tabpanel"
        aria-label={tab === "preview" ? "Preview" : "Live app"}
      >
        {tab === "live" && frame !== null ? (
          <img
            className="live-frame"
            alt={`The live app at ${frame.path}`}
            src={`data:image/jpeg;base64,${frame.jpeg}`}
          />
        ) : tab === "preview" && shown !== undefined ? (
          <PreviewPlayer key={shown.id} sceneId={shown.id} take={shown.take} />
        ) : (
          <>
            <div className="empty-icon">
              {tab === "preview" ? <FilmStrip size={24} /> : <Monitor size={24} />}
            </div>
            {tab === "preview" ? (
              <>
                <h2>Nothing filmed yet</h2>
                <p>Filmed scenes play here, with their captions, cursor and blurred secrets.</p>
              </>
            ) : (
              <>
                <h2>The agent’s browser</h2>
                <p>While the agent works on {project.url ?? "your app"}, you watch it here.</p>
              </>
            )}
          </>
        )}
      </section>
      <SceneStrip
        scenes={project.scenes}
        problems={project.problems}
        selected={shown?.id ?? null}
        onSelect={setSelected}
      />
    </main>
  )
}

function TabButton(props: {
  tab: Tab
  current: Tab
  onPick: (tab: Tab) => void
  icon: React.ReactNode
  label: string
  live?: boolean
}) {
  return (
    <button
      type="button"
      role="tab"
      className="tab"
      aria-selected={props.tab === props.current}
      onClick={() => props.onPick(props.tab)}
    >
      {props.icon}
      {props.label}
      {props.live === true && <span className="live-dot" aria-label="live" />}
    </button>
  )
}
