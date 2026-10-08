import "@fontsource/hanken-grotesk/400.css"
import "@fontsource/hanken-grotesk/500.css"
import "@fontsource/hanken-grotesk/600.css"
import "@fontsource/hanken-grotesk/700.css"
import "@fontsource/jetbrains-mono/400.css"
import "@fontsource/jetbrains-mono/500.css"
import "@fontsource/jetbrains-mono/600.css"
import "./styles.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app.tsx"

const root = document.getElementById("root")
if (root === null) throw new Error("no #root")
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
