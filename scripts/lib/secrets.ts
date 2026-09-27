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

/** A resolver for the runner: throws (never returns "") when a secret isn't provided. */
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
