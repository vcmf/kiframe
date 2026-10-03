// The agent's answers as Markdown: no raw HTML (react-markdown escapes it), and a link never
// navigates the window: an https one opens in the user's browser (main checks it again).
import { memo } from "react"
import Markdown, { type Components } from "react-markdown"
import { api } from "../api.ts"

const components: Components = {
  a: ({ href, children }) => {
    const host = hostOf(href)
    return (
      <a
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault()
          if (href !== undefined && href.startsWith("https://")) {
            void api()
              .invoke("external:open", href)
              .catch(() => undefined)
          }
        }}
      >
        {children}
        {/* Where it really goes, always (the agent's words, a link's label, can be steered). */}
        {host !== undefined && <span className="md-host"> ({host})</span>}
      </a>
    )
  },
  // The agent's single line breaks kept (Markdown joins them otherwise).
  p: ({ children }) => <p style={{ whiteSpace: "pre-line" }}>{children}</p>,
  // Images from the agent's text aren't loaded (the CSP refuses them anyway): their alt text shows.
  img: ({ alt }) => <span>{alt}</span>,
}

function hostOf(href: string | undefined): string | undefined {
  if (href === undefined) return undefined
  try {
    return new URL(href).host || undefined
  } catch {
    return undefined
  }
}

/** Parsed once per text (a chat update never re-parses every past answer). */
export const AgentText = memo(function AgentText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown components={components}>{text}</Markdown>
    </div>
  )
})
