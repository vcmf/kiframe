// The shipped background images, bundled with the renderer (served from its own origin: the
// page's CSP allows images from 'self' only).
import type { BuiltinBackground } from "@kiframe/schema"
import autumnRoad from "@kiframe/compositor/backgrounds/autumn-road.jpg?url"
import forestLake from "@kiframe/compositor/backgrounds/forest-lake.jpg?url"
import mountainLake from "@kiframe/compositor/backgrounds/mountain-lake.jpg?url"

export const BACKGROUND_URLS: Record<BuiltinBackground, string> = {
  "autumn-road": autumnRoad,
  "forest-lake": forestLake,
  "mountain-lake": mountainLake,
}

const loaded = new Map<BuiltinBackground, Promise<HTMLImageElement>>()

/**
 * A builtin background, decoded and ready to draw: once per id (a 4K photo, every preview load
 * would decode it again); a failed load is tried again next time.
 */
export function loadBackground(id: BuiltinBackground): Promise<HTMLImageElement> {
  let image = loaded.get(id)
  if (image === undefined) {
    const element = new Image()
    element.src = BACKGROUND_URLS[id]
    image = element.decode().then(() => element)
    image.catch(() => loaded.delete(id))
    loaded.set(id, image)
  }
  return image
}
