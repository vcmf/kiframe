import { WarningCircle } from "@phosphor-icons/react"

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
