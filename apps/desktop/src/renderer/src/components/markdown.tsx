// The agent's answers as Markdown: no raw HTML (react-markdown escapes it), and a link never
// navigates the window: an https one opens in the user's browser (main checks it again).
import Markdown, { type Components } from "react-markdown"
import { api } from "../api.ts"

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
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
    </a>
  ),
  // Images from the agent's text aren't loaded (the CSP refuses them anyway): their alt text shows.
  img: ({ alt }) => <span>{alt}</span>,
}

export function AgentText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown components={components}>{text}</Markdown>
    </div>
  )
}
