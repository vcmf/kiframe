// The project's scenes in story order, each with its status. A scene using an app the project no
// longer lists says so (its recording still plays), with a way to ask the agent to rework it.
import { CheckCircle, FilmSlate, Plus, TextT, WarningCircle } from "@phosphor-icons/react"
import type { SceneView } from "../../../shared/ipc.ts"
import { useChat } from "../chat-store.ts"

const STATUS: Record<SceneView["status"], { label: string; icon: React.ReactNode }> = {
  recorded: { label: "Recorded", icon: <CheckCircle size={13} /> },
  grounded: { label: "Grounded · not filmed", icon: <FilmSlate size={13} /> },
  empty: { label: "No steps yet", icon: <FilmSlate size={13} /> },
  card: { label: "Title card", icon: <TextT size={13} /> },
  unreadable: { label: "Didn’t read", icon: <WarningCircle size={13} /> },
  missing: { label: "Folder missing", icon: <WarningCircle size={13} /> },
}

export function SceneStrip(props: {
  scenes: SceneView[]
  problems: string[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  const { scenes, problems } = props
  const running = useChat((s) => s.running)
  const send = useChat((s) => s.send)
  return (
    <section className="strip" aria-label="Scenes">
      <div className="strip-head">
        <span className="pane-title">Scenes</span>
        <span className="strip-count">{scenes.length}</span>
      </div>
      {problems.length > 0 && (
        <ul className="strip-problems" aria-label="Problems">
          {problems.map((p, i) => (
            <li key={i}>
              <WarningCircle size={13} weight="fill" />
              {p}
            </li>
          ))}
        </ul>
      )}
      {scenes.length === 0 ? (
        <div className="strip-empty">
          <Plus size={16} />
          The agent adds scenes as you describe the demo
        </div>
      ) : (
        <ul className="strip-cards">
          {scenes.map((scene) => {
            const removed = scene.removedApps ?? []
            const status = STATUS[scene.status]
            return (
              <li key={scene.id}>
                <button
                  type="button"
                  className="scene-card"
                  aria-pressed={props.selected === scene.id}
                  title={scene.problem}
                  onClick={() => props.onSelect(scene.id)}
                >
                  <div className={`scene-thumb${scene.status === "card" ? " card" : ""}`}>
                    {scene.status === "card" ? scene.title : <FilmSlate size={22} />}
                  </div>
                  <div className="scene-meta">
                    <span className="scene-title">{scene.title}</span>
                    <span className={`scene-status status-${scene.status}`}>
                      {status.icon}
                      {status.label}
                    </span>
                    {removed.length > 0 && (
                      <span className="scene-status status-removed-app">
                        <WarningCircle size={13} />
                        Uses an app not in the project: {removed.join(", ")}
                      </span>
                    )}
                  </div>
                </button>
                {removed.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost scene-rework"
                    disabled={running}
                    title={running ? "The agent is working" : undefined}
                    onClick={() =>
                      void send(
                        `Rework the scene “${scene.title}” (${scene.id}) without the app${removed.length > 1 ? "s" : ""} ${removed.map((a) => `"${a}"`).join(", ")}: the project no longer lists it. Keep it on the project's apps, or ask to add the site back with add_app if the scene needs it.`,
                      )
                    }
                  >
                    Rework without it
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
