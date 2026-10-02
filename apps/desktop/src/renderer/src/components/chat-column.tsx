// The chat column. The agent itself comes with S3b: until then, the composer is shown but off.
import { ChatCircleDots, PaperPlaneRight } from "@phosphor-icons/react"

export function ChatColumn() {
  return (
    <aside className="chat" aria-label="Chat">
      <div className="pane-head">
        <span className="pane-title">Chat</span>
      </div>
      <div className="chat-body">
        <div className="chat-empty">
          <ChatCircleDots size={28} />
          <h2>Describe your demo</h2>
          <p>
            Say what the video should show, and the agent splits it into scenes, tries each step on
            your app and films it.
          </p>
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <label htmlFor="ask" className="sr-only">
            Message the agent
          </label>
          <textarea id="ask" rows={2} placeholder="The agent arrives in the next build" disabled />
          <div className="composer-row">
            <div className="spacer" />
            <button type="button" className="send-btn" aria-label="Send" disabled>
              <PaperPlaneRight size={17} weight="fill" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
