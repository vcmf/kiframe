// The application menu: what each platform needs to edit text (macOS routes Copy / Paste through
// the menu), never Reload or the developer tools in a packaged app.
import { Menu, type MenuItemConstructorOptions } from "electron"

export function setAppMenu(dev: boolean): void {
  const view: MenuItemConstructorOptions[] = dev
    ? [{ label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] }]
    : []
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        ...view,
        { role: "windowMenu" },
      ]),
    )
    return
  }
  // Windows and Linux: no menu bar (the app draws its title bar; text editing needs no menu).
  Menu.setApplicationMenu(view.length > 0 ? Menu.buildFromTemplate(view) : null)
}
