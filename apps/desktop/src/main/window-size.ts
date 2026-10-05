// The main window's size limits and first size (Electron-free).

/**
 * The window's first size: 1440×900, or the screen's work area where that's smaller (the space
 * between the menu bar and the Dock: macOS lets a window run on under the Dock, its bottom then
 * hidden, the composer and the scene strip cut). The app's minimum where the screen has room.
 */
export function initialSize(workArea: { width: number; height: number }): {
  width: number
  height: number
  minWidth: number
  minHeight: number
} {
  // On a work area smaller than the app's minimum, the minimum gives way: the window fits.
  const minWidth = Math.min(MIN_WIDTH, workArea.width)
  const minHeight = Math.min(MIN_HEIGHT, workArea.height)
  return {
    width: Math.max(minWidth, Math.min(1440, workArea.width)),
    height: Math.max(minHeight, Math.min(900, workArea.height)),
    minWidth,
    minHeight,
  }
}

export const MIN_WIDTH = 1024
export const MIN_HEIGHT = 680
