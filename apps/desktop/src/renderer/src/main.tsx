import "@fontsource/instrument-sans/400.css"
import "@fontsource/instrument-sans/500.css"
import "@fontsource/instrument-sans/600.css"
import "@fontsource/instrument-sans/700.css"
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
