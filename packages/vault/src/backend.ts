// Where secret values live: the OS keychain (macOS Keychain, Windows Credential Manager, libsecret),
// through keyring-rs. Tests use the in-memory backend.

export interface SecretBackend {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

/** The OS keychain, one entry per secret under `service`. */
export function keychainBackend(service = "Kiframe"): SecretBackend {
  // Loaded on first use: importing the vault (types, the refusal error) never loads native code.
  const entry = async (name: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring")
    return new AsyncEntry(service, name)
  }
  return {
    get: async (name) => (await (await entry(name)).getPassword()) ?? undefined,
    set: async (name, value) => (await entry(name)).setPassword(value),
    delete: async (name) => {
      await (await entry(name)).deleteCredential()
    },
  }
}

/** For tests: values in memory only. */
export function memoryBackend(): SecretBackend & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: (name) => Promise.resolve(values.get(name)),
    set: (name, value) => Promise.resolve(void values.set(name, value)),
    delete: (name) => Promise.resolve(void values.delete(name)),
  }
}
