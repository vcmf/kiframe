// The stage: Preview / Live app tabs over the well, the scene strip below.
import { Browser, FilmStrip, Monitor } from "@phosphor-icons/react"
import { useState } from "react"
import type { ProjectView } from "../../../shared/ipc.ts"
import { SceneStrip } from "./scene-strip.tsx"

type Tab = "preview" | "live"

export function Stage({ project }: { project: ProjectView }) {
  const [tab, setTab] = useState<Tab>("preview")
  const [selected, setSelected] = useState<string | null>(null)
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
        />
      </div>
      <section
        className="stage-well"
        role="tabpanel"
        aria-label={tab === "preview" ? "Preview" : "Live app"}
      >
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
      </section>
      <SceneStrip
        scenes={project.scenes}
        problems={project.problems}
        selected={selected}
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
    </button>
  )
}
