// The screens: first run (the key, then a project), then the workspace.
import { useEffect } from "react"
import { ChatColumn } from "./components/chat-column.tsx"
import { ErrorBar } from "./components/error-note.tsx"
import { KeySetup } from "./components/key-setup.tsx"
import { ProjectStart } from "./components/project-start.tsx"
import { Stage } from "./components/stage.tsx"
import { TitleBar } from "./components/title-bar.tsx"
import { useApp } from "./store.ts"

export function App() {
  const status = useApp((s) => s.status)
  const connect = useApp((s) => s.connect)
  useEffect(() => connect(), [connect])
  return (
    <div className="app">
      <TitleBar />
      {status === null ? null : !status.hasKey ? (
        <KeySetup />
      ) : status.project === null ? (
        <ProjectStart />
      ) : (
        <>
          <ErrorBar error={status.error} />
          <div className="workspace">
            <ChatColumn />
            <Stage key={status.project.dir} project={status.project} />
          </div>
        </>
      )}
    </div>
  )
}
