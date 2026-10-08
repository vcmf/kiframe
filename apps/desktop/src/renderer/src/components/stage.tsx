// The stage: Preview / Live app tabs over the well, the scene strip below. A run shows the live
// app (view only: the agent's browser) until the user picks a tab.
import { Browser, FilmStrip, HandGrabbing, HandPointing, Monitor } from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"
import type { ProjectView } from "../../../shared/ipc.ts"
import { useChat } from "../chat-store.ts"
import { LiveControl } from "./live-control.tsx"
import { PreviewPlayer } from "./preview-player.tsx"
import { SceneStrip } from "./scene-strip.tsx"

type Tab = "preview" | "live"

export function Stage({ project }: { project: ProjectView }) {
  const [tab, setTab] = useState<Tab>("preview")
  const [selected, setSelected] = useState<string | null>(null)
  const running = useChat((s) => s.running)
  const frame = useChat((s) => s.frame)
  // A handover open: the live app takes the user's input (and shows).
  const handover = useChat(
    (s) =>
      s.items.find(
        (i) => i.kind === "request" && i.state === "open" && i.request.kind === "handover",
      )?.id,
  )
  useEffect(() => {
    if (handover !== undefined) setTab("live")
  }, [handover])
  // A run starting shows the agent at work (once: the user's tab is theirs after); once it has
  // ended with a scene filmed, that scene's preview. The takes before the run are read when it
  // starts, never again during it (a take saved mid-run is the run's); the scenes it filmed may
  // arrive after its end, watched until the next run. A project switch starts afresh (keyed).
  const scenes = useRef(project.scenes)
  scenes.current = project.scenes
  const wasRunning = useRef(running)
  const run = useRef<{ takes: Map<string, string | undefined>; ended: boolean } | null>(null)
  useEffect(() => {
    if (running && !wasRunning.current) {
      run.current = { takes: new Map(scenes.current.map((s) => [s.id, s.take])), ended: false }
      setTab("live")
    } else if (!running && wasRunning.current && run.current !== null) {
      run.current.ended = true
    }
    wasRunning.current = running
  }, [running])
  useEffect(() => {
    const ran = run.current
    if (ran === null || !ran.ended) return
    const filmed = project.scenes.find(
      (s) => s.take !== undefined && ran.takes.get(s.id) !== s.take,
    )
    if (filmed === undefined) return
    run.current = null
    setSelected(filmed.id)
    setTab("preview")
  }, [running, project.scenes])
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
        {tab === "live" && running && handover === undefined && (
          <span className="chip">
            <HandPointing size={13} />
            Kif is driving
          </span>
        )}
        {tab === "live" && handover !== undefined && (
          <span className="chip chip-you">
            <HandGrabbing size={13} />
            You’re in control
          </span>
        )}
        {tab === "live" && frame !== null && <span className="stage-path mono">{frame.path}</span>}
      </div>
      <section
        className="stage-well"
        role="tabpanel"
        aria-label={tab === "preview" ? "Preview" : "Live app"}
      >
        {/* Kept while the live app shows (a tab switch never loads the take again), paused. */}
        {shown !== undefined && (
          <PreviewPlayer
            key={shown.id}
            sceneId={shown.id}
            take={shown.take}
            version={shown.version}
            active={tab === "preview"}
          />
        )}
        {tab === "live" && frame !== null && handover !== undefined ? (
          <LiveControl frame={frame} handover={handover} />
        ) : tab === "live" && frame !== null ? (
          <img
            className="live-frame"
            alt={`The live app at ${frame.path}`}
            src={`data:image/jpeg;base64,${frame.jpeg}`}
          />
        ) : tab === "preview" && shown !== undefined ? null : (
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
                <h2>Kif’s browser</h2>
                <p>While Kif works on {project.url}, you watch it here.</p>
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
