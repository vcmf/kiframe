import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

// A tiny local "target app" for runtime tests: a few pages with forms, a list and a dialog.
const pages: Record<string, string> = {
  // M1-3: a chat widget to hide, a cookie dialog that shows up late, one that shows on first move.
  // M1-7: hostile pages trying to get a typed secret out.
  // Mirrors the password into visible text, and puts it in the URL (same origin, query and path).
  "/evil-mirror": `<!doctype html><title>Evil mirror</title>
    <label>Password <input id="pw" type="password"></label><p id="echo"></p>
    <script>
      document.getElementById("pw").addEventListener("input", (e) => {
        document.getElementById("echo").textContent = "You typed " + e.target.value
        history.replaceState(null, "", "/evil-mirror/" + encodeURIComponent(e.target.value) + "?pw=" + encodeURIComponent(e.target.value))
      })
    </script>`,
  // Moves focus to a visible text box the moment the password field is focused.
  "/evil-focus": `<!doctype html><title>Evil focus</title>
    <label>Password <input id="pw" type="password"></label><label>Comment <input id="c"></label>
    <script>document.getElementById("pw").addEventListener("focus", () => document.getElementById("c").focus())</script>`,
  // Leaves for another origin (localhost vs 127.0.0.1) as soon as the password field is focused.
  "/evil-leave": `<!doctype html><title>Evil leave</title>
    <label>Password <input id="pw" type="password"></label>
    <script>document.getElementById("pw").addEventListener("focus", () => { location.href = location.href.replace("127.0.0.1", "localhost") })</script>`,
  // Spies on every DOM API the runtime's in-page code could pass a value to.
  "/evil-spy": `<!doctype html><title>Evil spy</title>
    <label>Password <input id="pw" type="password"></label><p>Hello bob@acme.com</p>
    <script>
      window.__seen = []
      const spy = (obj, name) => {
        const orig = obj[name]
        obj[name] = function (...args) {
          for (const a of args) if (typeof a === "string") window.__seen.push(a)
          return orig.apply(this, args)
        }
      }
      spy(Document.prototype, "createTreeWalker"); spy(Document.prototype, "querySelector")
      spy(Document.prototype, "querySelectorAll"); spy(Element.prototype, "querySelectorAll")
      spy(Element.prototype, "getAttribute"); spy(Element.prototype, "setAttribute")
      spy(window, "getComputedStyle"); spy(String.prototype, "includes"); spy(String.prototype, "indexOf")
      spy(RegExp.prototype, "exec"); spy(RegExp.prototype, "test")
      spy(Element.prototype, "matches"); spy(Element.prototype, "closest"); spy(Node.prototype, "contains")
      spy(Document.prototype, "createRange"); spy(Range.prototype, "setStart"); spy(Range.prototype, "setEnd")
      spy(String.prototype, "startsWith"); spy(String.prototype, "endsWith"); spy(Array.prototype, "includes")
      spy(Array.prototype, "indexOf"); spy(String.prototype, "replace"); spy(String.prototype, "split")
      spy(JSON, "parse"); spy(window, "atob"); spy(window, "btoa")
      const OrigRegExp = RegExp
      window.RegExp = function (...args) { for (const a of args) if (typeof a === "string") window.__seen.push(a); return new OrigRegExp(...args) }
    </script>`,
  // M1-6: a secret shown as text: split across nodes, in a field, hidden, late, in a password input.
  "/whoami": `<!doctype html><title>Who am I</title>
    <p id="a">Logged in as <b>bob@</b>acme.com</p>
    <input id="f" value="bob@acme.com"><input type="password" value="bob@acme.com">
    <p style="display:none">bob@acme.com</p><p id="late"></p>
    <script>setTimeout(() => document.getElementById("late").textContent = "Hi BOB@ACME.COM", 400)</script>`,
  // A name rendered like JSX `{first} {last}` (a space node), with collapsed source whitespace, and
  // an email split across flex items.
  "/names": `<!doctype html><title>Names</title>
    <p id="jsx"></p><p id="ws">Bob
         Smith</p>
    <div id="chip" style="display:flex"><span>bob@</span><span>acme.com</span></div>
    <div id="lit"></div>
    <script>
      // Text directly in a shadow root, like a Lit template.
      document.getElementById("lit").attachShadow({ mode: "open" }).append("Signed in as bob@acme.com")
      const p = document.getElementById("jsx")
      p.append(document.createTextNode("Bob"), document.createTextNode(" "), document.createTextNode("Smith"))
    </script>`,
  // The secret re-rendered (removed, then back) twice, and a new occurrence above it.
  "/flicker": `<!doctype html><title>Flicker</title><div id="top"></div><p id="p">Hi bob@acme.com</p>
    <script>
      const p = document.getElementById("p")
      setTimeout(() => p.remove(), 350)
      setTimeout(() => document.body.append(p), 700)
      setTimeout(() => document.getElementById("top").textContent = "bob@acme.com", 1000)
    </script>`,
  // M1-4: a cookie session. "Sign in" sets it, "Sign out" clears it.
  "/session": `<!doctype html><title>Session</title>
    <p id="who"></p><button id="in">Sign in</button><button id="out">Sign out</button>
    <script>
      const show = () => document.getElementById("who").textContent = document.cookie.includes("session=1") ? "Signed in" : "Signed out"
      document.getElementById("in").onclick = () => { document.cookie = "session=1; path=/"; show() }
      document.getElementById("out").onclick = () => { document.cookie = "session=; path=/; max-age=0"; show() }
      show()
    </script>`,
  "/banner": `<!doctype html><title>Banner</title>
    <div id="chat" style="position:fixed; right:10px; bottom:10px">Chat with us</div>
    <button id="go">Continue</button><p id="s"></p>
    <script>
      document.getElementById("go").onclick = () => document.getElementById("s").textContent = "continued"
      const dialog = () => {
        if (document.getElementById("cookies")) return
        const d = document.createElement("div")
        d.id = "cookies"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Cookie preferences")
        d.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,.5)"
        d.innerHTML = "<button>Accept all</button>"
        d.querySelector("button").onclick = () => {
          // ?fade: the dialog fades out for 400 ms, still in the page (no clicks through it).
          if (!location.search.includes("fade")) return d.remove()
          d.style.transition = "opacity 0.4s"; d.style.opacity = "0"
          // ?fadeblock: it still catches clicks while fading.
          if (!location.search.includes("fadeblock")) d.style.pointerEvents = "none"
          setTimeout(() => d.remove(), 400)
        }
        document.body.append(d)
      }
      if (location.search.includes("late")) setTimeout(dialog, 300)
      // ?stacked: a "What's new" modal over the cookie dialog, both at load.
      if (location.search.includes("stacked")) {
        dialog()
        const m = document.createElement("div")
        m.setAttribute("role", "dialog"); m.setAttribute("aria-label", "What's new")
        m.style.cssText = "position:fixed; inset:0; background:#fff"
        m.innerHTML = "<button>Close</button>"
        m.querySelector("button").onclick = () => m.remove()
        document.body.append(m)
      }
      if (location.search.includes("onmove")) addEventListener("mousemove", dialog, { once: true })
    </script>`,
  // The same list, but the drag starts only after 8 px of movement (dnd-kit's distance constraint).
  "/sortable-8": `<!doctype html><title>Sortable 8</title>
    <style>li { height: 40px; list-style: none; border-bottom: 1px solid #ccc }</style>
    <ul id="l" style="width:300px"><li>A</li><li>B</li><li>C</li><li>D</li><li>E</li></ul><p id="s"></p>
    <script>
      const list = document.getElementById("l"); let held, from, started = false
      list.addEventListener("pointerdown", (e) => { held = e.target.closest("li"); from = { x: e.clientX, y: e.clientY }; started = false; list.setPointerCapture(e.pointerId) })
      list.addEventListener("pointermove", (e) => {
        if (!held || started) return
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) >= 8) { started = true; held.style.display = "none" }
      })
      list.addEventListener("pointerup", (e) => {
        if (!held) return
        list.releasePointerCapture(e.pointerId)
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("li")
        held.style.display = ""
        if (started && under && under !== held) list.insertBefore(held, under)
        held = undefined
        document.getElementById("s").textContent = [...list.children].map((li) => li.textContent).join(" ")
      })
    </script>`,
  // A sortable list: pressing an item takes it out of the flow (the rows below shift up); it's
  // dropped before the row under the pointer.
  "/sortable": `<!doctype html><title>Sortable</title>
    <style>li { height: 40px; list-style: none; border-bottom: 1px solid #ccc }</style>
    <ul id="l" style="width:300px"><li>A</li><li>B</li><li>C</li><li>D</li><li>E</li></ul><p id="s"></p>
    <script>
      const list = document.getElementById("l"); let held
      list.addEventListener("pointerdown", (e) => { held = e.target.closest("li"); held.style.display = "none"; list.setPointerCapture(e.pointerId) })
      list.addEventListener("pointerup", (e) => {
        if (!held) return
        list.releasePointerCapture(e.pointerId)
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("li")
        held.style.display = ""
        if (under && under !== held) list.insertBefore(held, under)
        held = undefined
        document.getElementById("s").textContent = [...list.children].map((li) => li.textContent).join(" ")
      })
    </script>`,
  // Like dnd-kit: the move that activates a drag doesn't move the element.
  "/pointer-lib": `<!doctype html><title>Pointer lib</title>
    <div id="k" role="slider" aria-label="Level" style="position:absolute; left:100px; top:100px; width:40px; height:40px; background:#888"></div>
    <div id="trash" style="position:absolute; left:500px; top:100px; width:120px; height:80px; background:#fcc">Drop files here</div>
    <label>Plan <select id="plan2"><option>Keep</option><option value="c">Cancel subscription</option></select></label>
    <p id="s" style="position:absolute; top:400px"></p>
    <script>
      const k = document.getElementById("k"); let down, active = false
      k.addEventListener("pointerdown", (e) => { down = { x: e.clientX, left: k.offsetLeft }; active = false; k.setPointerCapture(e.pointerId) })
      k.addEventListener("pointermove", (e) => {
        if (!down) return
        if (!active) { active = true; return }
        k.style.left = (down.left + e.clientX - down.x) + "px"
      })
      k.addEventListener("pointerup", () => { down = undefined; document.getElementById("s").textContent = "at " + k.offsetLeft })
    </script>`,
  // M1-2: native select, drags (pointer and HTML5), uploads, tabs and popups.
  "/controls": `<!doctype html><title>Controls</title>
    <label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select></label>
    <p id="s"></p>
    <script>document.getElementById("plan").onchange = (e) => document.getElementById("s").textContent = "plan " + e.target.value</script>`,
  "/drag": `<!doctype html><title>Drag</title>
    <div id="knob" role="slider" aria-label="Volume" style="position:absolute; left:100px; top:100px; width:40px; height:40px; background:#888"></div>
    <div id="card" draggable="true" style="position:absolute; left:100px; top:300px; width:120px; height:40px; background:#ccf">Card</div>
    <div id="zone" style="position:absolute; left:500px; top:300px; width:200px; height:120px; background:#cfc">Done</div>
    <p id="s" style="position:absolute; top:500px"></p>
    <script>
      const knob = document.getElementById("knob"); let grab
      knob.addEventListener("pointerdown", (e) => { grab = { x: e.clientX - knob.offsetLeft }; knob.setPointerCapture(e.pointerId) })
      knob.addEventListener("pointermove", (e) => { if (grab) knob.style.left = (e.clientX - grab.x) + "px" })
      knob.addEventListener("pointerup", () => { grab = undefined; document.getElementById("s").textContent = "knob " + knob.offsetLeft })
      const zone = document.getElementById("zone")
      document.getElementById("card").addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", "card"))
      zone.addEventListener("dragover", (e) => e.preventDefault())
      zone.addEventListener("drop", (e) => { e.preventDefault(); document.getElementById("s").textContent = "dropped " + e.dataTransfer.getData("text/plain") })
    </script>`,
  "/upload": `<!doctype html><title>Upload</title>
    <label>Attachment <input type="file" id="f"></label>
    <button id="b">Choose avatar</button><input type="file" id="hidden" style="display:none">
    <div id="zone" role="button" tabindex="0" style="padding:20px; border:2px dashed #999">Drag &amp; drop files here, or click to browse</div>
    <label for="hid2">Avatar file</label><input type="file" id="hid2" style="display:none">
    <p id="s"></p>
    <script>
      const show = (e) => document.getElementById("s").textContent = e.target.id + ": " + [...e.target.files].map((f) => f.name).join(",")
      document.getElementById("f").onchange = show
      document.getElementById("hidden").onchange = show
      document.getElementById("hid2").onchange = show
      document.getElementById("b").onclick = () => document.getElementById("hidden").click()
      document.getElementById("zone").onclick = () => document.getElementById("hidden").click()
    </script>`,
  "/opener": `<!doctype html><title>Opener</title>
    <label>API key <input id="key"></label>
    <a href="/popup-report" target="_blank">Open report</a>
    <button onclick="window.open('/popup-report', 'report', 'width=800,height=600')">Open popup</button>
    <button onclick="window.open('/quick-close')">Sign in with provider</button>
    <button onclick="setTimeout(() => window.open('/popup-report'), 800)">Open later</button>
    <button onclick="window.open('/popup-report'); window.open('/quick-close')">Open two</button>
    <button onclick="document.getElementById('reset').textContent = 'reset done'">Reset</button><p id="reset"></p>`,
  // An OAuth popup with a session already: closes itself at once.
  "/quick-close": `<!doctype html><title>Provider</title><script>window.close()</script>`,
  // Animated: screencast frames only come on repaint, so frames can only come from here once followed.
  "/popup-report": `<!doctype html><title>Report</title><h1>Report</h1><button onclick="window.close()">Done</button>
    <button onclick="fetch('/').then(() => setTimeout(() => window.close(), 200))">Authorize</button>
    <label>Code <input id="code" style="position:absolute; left:300px; top:285px; width:200px; height:30px; box-sizing:border-box"></label>
    <style>@keyframes spin { to { transform: rotate(360deg) } } #spin { width: 40px; height: 40px; background: #888; animation: spin 0.5s linear infinite }</style><div id="spin"></div>`,
  // A drawer that slides in (400 ms) after a click; another "Delete" exists elsewhere on the page.
  "/drawer": `<!doctype html><title>Drawer</title>
    <style>#d { position: fixed; top: 0; right: 0; width: 240px; transform: translateX(100%); transition: transform 400ms }
      #d.open { transform: none }</style>
    <button id="open">Open drawer</button><button id="other">Delete elsewhere</button><p id="s"></p>
    <div id="d"><button id="del">Delete</button></div>
    <script>
      document.getElementById("open").onclick = () => document.getElementById("d").classList.add("open")
      document.getElementById("del").onclick = () => document.getElementById("s").textContent = "drawer"
      document.getElementById("other").onclick = () => document.getElementById("s").textContent = "elsewhere"
    </script>`,
  // App shell: the body doesn't scroll, <main> does.
  "/shell-scroll": `<!doctype html><title>Shell scroll</title>
    <style>html, body { margin: 0; height: 100%; overflow: hidden } main { height: 100%; overflow: auto }</style>
    <main id="m"><button id="top">Top action</button><div style="height:4000px"></div><p id="s"></p></main>
    <script>document.getElementById("top").onclick = () => document.getElementById("s").textContent = "Top clicked"</script>`,
  // A collapsed sidebar: translated off screen, still "visible" to Playwright.
  "/collapsed": `<!doctype html><title>Collapsed</title>
    <nav style="position:fixed; left:0; top:0; width:200px; transform:translateX(-100%)"><button>New board</button></nav>
    <main style="margin-left:40px"><div role="button" tabindex="0">New Board card</div>
      <label>Hidden field <input id="sr" style="position:absolute; left:-9999px"></label><p id="v"></p>
      <script>document.getElementById("sr").oninput = (e) => document.getElementById("v").textContent = e.target.value</script></main>`,
  // Boards kept in localStorage (they survive a reload, like app data); Delete shows on hover only.
  "/boards": `<!doctype html><title>Boards</title>
    <style>.card button { display: none } .card:hover button { display: inline }</style>
    <button id="new">New board</button><div id="list"></div>
    <script>
      const load = () => JSON.parse(localStorage.getItem("boards") || "[]")
      const save = (b) => { localStorage.setItem("boards", JSON.stringify(b)); render() }
      function render() {
        const list = document.getElementById("list"); list.innerHTML = ""
        for (const name of load()) {
          const card = document.createElement("div"); card.className = "card"
          card.innerHTML = "<h4></h4><button>Delete board</button>"
          card.querySelector("h4").textContent = name
          card.querySelector("button").onclick = () => save(load().filter((n) => n !== name))
          list.append(card)
        }
      }
      document.getElementById("new").onclick = () => save([...load(), "Q4 roadmap"])
      render()
    </script>`,
  "/get-login": `<!doctype html><title>GET login</title>
    <form method="get" action="/get-login"><label>Password <input name="pw" type="password"></label></form>
    <button oncontextmenu="event.preventDefault(); document.body.dataset.menu='1'">Options</button>`,
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
  // A field whose aria-labelledby and aria-label disagree (the accessible name is the labelledby).
  "/labelled": `<!doctype html><title>Labelled</title>
    <span id="cc">Card number</span><input type="text" aria-labelledby="cc" aria-label="Password">`,
  // A field holding a secret's value, and one holding a longer word that merely contains it.
  "/words": `<!doctype html><title>Words</title>
    <label>Search <input id="search" value="administrators"></label><label>User <input id="user" value="admin"></label>`,
  // Re-mounts the password input (a framework re-render): the new node keeps the value and focus.
  "/remount": `<!doctype html><title>Remount</title>
    <label>Password <input id="pw" type="password"></label><label>Email <input id="email"></label>
    <script>
      document.getElementById("pw").addEventListener("input", (e) => setTimeout(() => {
        const old = e.target, n = old.cloneNode()
        n.value = old.value; n.removeAttribute("id"); old.replaceWith(n); n.focus()
      }, 50), { once: true })
    </script>`,
  // A password field inside a web component's shadow root.
  "/shadow-login": `<!doctype html><title>Shadow login</title>
    <pw-field id="host"></pw-field><label>Email <input id="email"></label>
    <script>
      customElements.define("pw-field", class extends HTMLElement {
        constructor() {
          super()
          this.attachShadow({ mode: "open", delegatesFocus: true }).innerHTML = '<input type="password" aria-label="Password">'
        }
      })
    </script>`,
  // The same form on another path (an approved step moved elsewhere).
  "/other/login-form": `<!doctype html><title>Login form</title>
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
