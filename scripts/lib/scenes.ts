// Scene helpers shared by the scripts.

/**
 * A scene id for a scenario file (the host's scene id in the app): its folder and name, kebab-case
 * (`examples/calcom/grounded-dsflash.yaml` → `calcom-grounded-dsflash`), never empty.
 */
export function sceneIdOf(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/")
  const name = (parts.at(-1) ?? "").replace(/\.[^.]*$/, "")
  const id = [parts.at(-2) ?? "", name]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return id === "" ? "scene" : id
}
