// The window's status, read fresh each time: it never throws, and never changes the last
// action's error (a keychain that can't be read is said for as long as it can't).
import type { AppStatus, ProjectView } from "../shared/ipc.ts"
import { errorMessage as message } from "../shared/util.ts"

export async function readStatus(
  hasKey: () => Promise<boolean>,
  project: ProjectView | null,
  actionError: string | null,
): Promise<AppStatus> {
  try {
    return { hasKey: await hasKey(), project, error: actionError }
  } catch (e) {
    const keychain = `couldn't read the system keychain: ${message(e)}`
    return {
      hasKey: false,
      project,
      error: actionError === null ? keychain : `${actionError}; ${keychain}`,
    }
  }
}
