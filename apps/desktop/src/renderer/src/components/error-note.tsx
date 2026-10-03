import { WarningCircle, X } from "@phosphor-icons/react"
import { useApp } from "../store.ts"

/** Why the last action failed, as main said it. */
export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (error === null || error === undefined) return null
  return (
    <div className="error" role="alert">
      <WarningCircle size={16} weight="fill" />
      <span>{error}</span>
    </div>
  )
}

/** In the workspace: the last action's failure, under the title bar, until dismissed. */
export function ErrorBar({ error }: { error: string | null }) {
  const dismiss = useApp((s) => s.dismissError)
  const dismissed = useApp((s) => s.dismissed)
  if (error === null || error === dismissed) return null
  return (
    <div className="error-bar" role="alert">
      <WarningCircle size={16} weight="fill" />
      <span>{error}</span>
      <div className="spacer" />
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismiss}>
        <X size={15} />
      </button>
    </div>
  )
}
