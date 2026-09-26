import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

// A tiny local "target app" for runtime tests: a few pages with forms, a list and a dialog.
const pages: Record<string, string> = {
  "/": `<!doctype html><title>Home</title>
    <nav><a href="/projects">Projects</a></nav>
    <h1>Welcome</h1>`,
  "/projects": `<!doctype html><title>Projects</title>
    <nav style="display:none"><a href="/settings">Settings</a></nav>
    <nav><a href="/settings">Settings</a></nav>
    <template id="toast-template"><p>Saved!</p></template>
    <p style="display:none">Saved!</p>
    <aside id="sidebar" style="height:80px; overflow:auto"><div style="height:600px">
      <button id="side-item">Sidebar item</button></div></aside>
    <button id="save-remote">Save remotely</button>
    <h1>Projects</h1>
    <button id="new">New project</button>
    <button class="dup">Save</button><button class="dup">Save</button>
    <form id="create" hidden onsubmit="event.preventDefault(); done()">
      <label>Project name <input name="name"></label>
      <label>Password <input name="pw" type="password"></label>
      <button type="submit">Create</button>
    </form>
    <p id="status"></p>
    <div id="list" style="height:120px; overflow:auto"><div style="height:2000px">
      <p style="margin-top:1800px">Deep item</p></div></div>
    <div style="height:3000px"></div>
    <footer>Footer text</footer>
    <script>
      document.getElementById("save-remote").onclick = async () => {
        await fetch("/api/slow")
        document.getElementById("status").textContent = "Saved remotely"
      }
      document.getElementById("new").onclick = () => { document.getElementById("create").hidden = false }
      function done() {
        const name = document.querySelector("[name=name]").value
        document.getElementById("status").textContent = "Project created: " + name
        setTimeout(() => history.pushState({}, "", "/projects/1"), 50)
      }
      document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "k") document.getElementById("status").textContent = "Palette open"
      })
    </script>`,
}

export async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname
    if (path === "/api/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      }, 700)
      return
    }
    const body = pages[path] ?? (path.startsWith("/projects/") ? pages["/projects"] : undefined)
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html" })
    res.end(body ?? "not found")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
