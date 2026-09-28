/** Whether the element, or an element inside it, has keyboard focus (runs in the page). */
export function hasFocus(el: Element): boolean {
  // In shadow DOM, document.activeElement is the host: ask the element's own root.
  const root = el.getRootNode()
  const active = root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null
  return active !== null && (el === active || el.contains(active))
}

// Keyboard helpers: shortcut names, focus and caret checks (the in-page parts run in the page).

/**
 * Puts the caret at the end of the field (runs in the page). Not the End key: on macOS it scrolls
 * instead of moving the caret, and in a textarea it only goes to the end of the current line. Some
 * input types (email, number, date…) don't support selection: typing there appends anyway.
 */
export function moveCaretToEnd(el: Element) {
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.selectionStart !== null
  ) {
    const end = el.value.length
    el.setSelectionRange(end, end)
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
}

/** `Mod` = ⌘ on Mac, Ctrl elsewhere (Playwright's ControlOrMeta). */
export function modKey(key: string): string {
  return key === "Mod" ? "ControlOrMeta" : key
}

export function toPlaywrightModifier(m: "Alt" | "Control" | "Meta" | "Shift" | "Mod") {
  return modKey(m) as "Alt" | "Control" | "Meta" | "Shift" | "ControlOrMeta"
}

export function toPlaywrightKeys(keys: string): string {
  return keys.split("+").map(modKey).join("+")
}
