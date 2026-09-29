// Phase 0 scripts: secrets from the environment (a git-ignored `.env` at the repo root, see
// .env.example). Secret `a.b` is read from `A_B`. Only the names given are resolvable.
import { existsSync } from "node:fs"
import { join } from "node:path"

/** The repo root's `.env`, whatever the current directory. */
export function loadDotEnv(): void {
  const file = join(import.meta.dirname, "..", "..", ".env")
  if (existsSync(file)) process.loadEnvFile(file)
}

export const envName = (secret: string) => secret.toUpperCase().replace(/[^A-Z0-9]/g, "_")

/**
 * A resolver for the runner: throws (never returns "") when a secret isn't provided. It ignores the
 * use: no grants (SECRETS-DESIGN §3) here, the user's own `.env` for throwaway harnesses only.
 */
export function envSecretResolver(names: readonly string[]): (name: string) => string {
  return (name) => {
    const value = process.env[envName(name)]
    if (!names.includes(name) || value === undefined || value === "") throw new Error("unavailable")
    return value
  }
}

/** The names that are actually provided, and their values (for scrubbing tool output). */
export function providedSecrets(names: readonly string[]): { name: string; value: string }[] {
  return names.flatMap((name) => {
    const value = process.env[envName(name)]
    return value === undefined || value === "" ? [] : [{ name, value }]
  })
}

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
