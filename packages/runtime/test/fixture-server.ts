import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

// A tiny local "target app" for runtime tests: a few pages with forms, a list and a dialog.
const pages: Record<string, string> = {
  "/moving": `<!doctype html><title>Moving</title>
    <button id="b" style="position:absolute; left:400px; top:200px; transition: top 0.2s">Moving target</button>
    <p id="s"></p>
    <script>
      let moved = false
      addEventListener("mousemove", () => {
        if (!moved) { moved = true; setTimeout(() => document.getElementById("b").style.top = "400px", 50) }
      })
      document.getElementById("b").onclick = () => document.getElementById("s").textContent = "Hit"
    </script>`,
  "/tall": `<!doctype html><title>Tall</title>
    <div style="height:300px"></div>
    <div id="board" role="region" aria-label="Board" style="height:1500px; background:#eee"></div>
    <p id="s"></p>
    <script>document.getElementById("board").onclick = (e) => document.getElementById("s").textContent = "Board " + e.clientY</script>`,
  "/labels": `<!doctype html><title>Labels</title>
    <ul role="menu"><li role="menuitem"><a href="#">Delete</a></li></ul>
    <button id="trash"><svg width="10" height="10"><title>trash</title></svg>Delete</button>
    <button id="save">Save<span hidden>Delete draft</span></button>
    <button id="split"><u>D</u>elete</button>
    <button id="contents"><span style="display:contents">Remove</span></button>
    <button id="vis">Save<span style="visibility:hidden">Delete draft</span></button>
    <a href="#thumb" id="thumbcard"><img alt="Q4 plan" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button onclick="event.preventDefault()">Delete</button></a>
    <button id="bordered" style="border:6px solid #000; padding:4px">Bordered</button>
    <p id="s"></p>
    <script>document.getElementById("save").onclick = () => document.getElementById("s").textContent = "Saved it"
      document.getElementById("vis").onclick = () => document.getElementById("s").textContent = "Saved vis"
      document.getElementById("bordered").onclick = (e) => document.getElementById("s").textContent = "B " + e.clientX + "," + e.clientY</script>`,
  "/cards": `<!doctype html><title>Cards</title>
    <a href="#opened" class="card"><span>Acme project</span> <button onclick="event.preventDefault()">Delete</button></a>`,
  "/wc-form": `<!doctype html><title>WC form</title>
    <my-field></my-field>
    <form onsubmit="event.preventDefault(); document.getElementById('s').textContent='Removed'">
      <input type="submit" value="Remove member"></form>
    <table><tr role="row"><td>Acme project</td><td><button>Delete</button></td></tr></table>
    <button onclick="document.getElementById('s').textContent='Archived'"><span>Delete</span> draft</button>
    <p id="s"></p>
    <script>
      customElements.define("my-field", class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML = "<label>Nickname <input></label>"
        }
      })
    </script>`,
  "/login-form": `<!doctype html><title>Login form</title>
    <label>Email <input type="email"></label>
    <label>Age <input type="number"></label>
    <div class="password-field"><span>Password</span><input type="password" aria-label="Password input"></div>
    <button onclick="document.getElementById('s').textContent='Deleted'">Delete project</button><p id="s"></p>`,
  "/shadow-render": `<!doctype html><title>Shadow render</title>
    <x-panel></x-panel><button id="go">Load panel</button>
    <script>
      customElements.define("x-panel", class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: "open" }) }
        render() {
          let i = 0
          const tick = () => {
            this.shadowRoot.innerHTML = "<p>Rendering " + i + "</p>"
            if (++i < 5) setTimeout(tick, 100)
            else this.shadowRoot.innerHTML = "<p>Panel ready</p>"
          }
          tick()
        }
      })
      document.getElementById("go").onclick = () => document.querySelector("x-panel").render()
    </script>`,
  "/covered-mid": `<!doctype html><title>Covered mid</title>
    <div style="position:fixed; top:0; left:0; right:0; height:760px; background:#000; z-index:9">Sticky header</div>
    <div style="height:1000px"></div><p>Behind header</p><div style="height:4000px"></div>`,
  "/ambiguous": `<!doctype html><title>Ambiguous</title>
    <button>Delete</button><button>Delete</button><span>Delete</span>`,
  "/shadow": `<!doctype html><title>Shadow</title>
    <div style="height:2500px"></div><x-card></x-card>
    <script>
      customElements.define("x-card", class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<button>Inside shadow</button>" }
      })
    </script>`,
  "/pane": `<!doctype html><title>Pane</title>
    <div style="height:300px">Header</div>
    <div id="pane" style="height:200px; overflow:auto"><p>Pane top</p><div style="height:1500px"></div><p>Pane bottom</p></div>`,
  "/feed": `<!doctype html><title>Feed</title>
    <div id="feed"></div>
    <script>
      let pages = 0
      const feed = document.getElementById("feed")
      function more() {
        pages++
        for (let i = 0; i < 20; i++) feed.insertAdjacentHTML("beforeend", "<p style='height:60px'>Item " + pages + "-" + i + "</p>")
        if (pages === 3) feed.insertAdjacentHTML("beforeend", "<p>Target item</p>")
      }
      more()
      addEventListener("scroll", () => {
        if (pages < 3 && innerHeight + scrollY >= document.body.scrollHeight - 5) setTimeout(more, 400)
      })
    </script>`,
  "/prefilled": `<!doctype html><title>Prefilled</title>
    <label>Company <input value="Acme"></label>
    <label>Notes <textarea>line1
line2</textarea></label>`,
  "/late-redirect": `<!doctype html><title>Late redirect</title>
    <script>addEventListener("load", () => setTimeout(() => location.replace("/login"), 300))</script>`,
  "/login": `<!doctype html><title>Login</title><button>Sign in</button>`,
  "/covered": `<!doctype html><title>Covered</title>
    <div style="height:1500px"></div><p id="t">Under the banner</p>
    <div style="position:fixed; left:0; right:0; bottom:0; height:200px; background:#000">Cookie banner</div>`,
  "/redirect": `<!doctype html><title>Redirect</title>
    <script>addEventListener("load", () => location.replace("/projects"))</script>`,
  "/shell": `<!doctype html><title>Shell</title>
    <style>html, body { height: 100%; margin: 0; overflow: hidden }
      aside { position: fixed; left: 0; top: 0; width: 200px; height: 100%; overflow: auto }
      main { margin-left: 200px; height: 100%; overflow: auto }</style>
    <aside><div style="height:900px"><button>Menu</button></div></aside>
    <main><h1>Top of main</h1><div style="height:3000px"></div><p>Bottom of main</p></main>`,
  "/report": `<!doctype html><title>Report</title>
    <button id="gen">Generate report</button><p id="r"></p>
    <button id="refresh">Refresh</button><p id="u"></p>
    <script>
      document.getElementById("gen").onclick = async () => {
        await fetch("/api/slow5"); document.getElementById("r").textContent = "Report ready"
      }
      document.getElementById("refresh").onclick = async () => {
        await fetch("/api/slow"); document.getElementById("u").textContent = "Updated"
      }
    </script>`,
  "/live": `<!doctype html><title>Live</title>
    <button id="save">Save</button><p id="s"></p>
    <script>
      new EventSource("/api/stream")
      document.getElementById("save").onclick = async () => {
        await fetch("/api/slow"); document.getElementById("s").textContent = "Saved"
      }
    </script>`,
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
    if (path === "/api/stream") {
      // Server-sent events that never end (notifications): must not block "network idle".
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write("data: hello\n\n")
      return
    }
    if (path === "/api/slow5") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      }, 5000)
      return
    }
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
