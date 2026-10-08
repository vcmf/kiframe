// The files the user attaches in the chat (OBJECT-MODEL §0.12): checked here, in main, before any
// is written (the window is never trusted: its bytes are checked by their content, never only their
// name), then written into the project's inputs/ (the host's own write: no agent tool reaches it).
import { attachmentType, FileRefusal, type ProjectFiles } from "@kiframe/project"
import { imageHeader } from "@kiframe/runtime"
import type { AttachedFile } from "../shared/ipc.ts"

/** A file checked: its safe name, and whether the model is shown it as an image or as text. */
export interface CheckedFile {
  name: string
  kind: "image" | "text"
  bytes: Uint8Array
}

/** A file written into inputs/ (its path there, and its hash: a rollback removes only it). */
export interface WrittenFile {
  path: string
  hash: string
  kind: "image" | "text"
}

/**
 * Every file checked (one refused: none is written, said why): a type the user may attach, within
 * its size; an image whose header says its format (refused when the model takes no images); text
 * that is UTF-8 without NUL.
 */
export async function checkAttachments(
  files: readonly AttachedFile[],
  seesImages: () => Promise<boolean>,
): Promise<CheckedFile[] | string> {
  const checked: CheckedFile[] = []
  for (const file of files) {
    const type = attachmentType(file.name, file.bytes.byteLength)
    if (type instanceof FileRefusal) return type.message
    const { name, ext } = type
    if (type.kind === "image") {
      if (imageHeader(file.bytes)?.format !== (ext === "jpg" ? "jpeg" : ext)) {
        return `${name} isn't the ${ext.toUpperCase()} image its name says`
      }
      if (!(await seesImages())) {
        return `${name}: the agent's model doesn't take images`
      }
      checked.push({ name, kind: "image", bytes: file.bytes })
      continue
    }
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    } catch {
      return `${name} isn't text (UTF-8)`
    }
    if (text.includes("\u0000")) return `${name} isn't text (it holds NUL characters)`
    checked.push({ name, kind: "text", bytes: file.bytes })
  }
  return checked
}

/**
 * The checked files written into inputs/, each under a free name; one that fails removes those this
 * batch wrote (all or none), said why.
 */
export function writeAttachments(
  files: ProjectFiles,
  checked: readonly CheckedFile[],
): WrittenFile[] | string {
  const written: WrittenFile[] = []
  for (const file of checked) {
    try {
      // `attach` copies the view's own bytes (never its buffer: a structured clone may hold more).
      const made = files.attach(file.name, file.bytes)
      written.push({ ...made, kind: file.kind })
    } catch (error) {
      for (const done of written) {
        try {
          files.unattach(done.path, done.hash)
        } catch {
          // left: it's the user's file all the same
        }
      }
      return error instanceof FileRefusal
        ? error.message
        : `couldn't keep ${file.name}: ${String(error)}`
    }
  }
  return written
}

/** What the history keeps of a message with files: its text, and a line naming them. */
export function storedMessage(text: string, written: readonly WrittenFile[]): string {
  if (written.length === 0) return text
  const listed = written.map((w) => `${w.path} (${w.kind})`).join(", ")
  return `${text === "" ? "(files attached)" : text}\n\n[The user attached: ${listed}. They stay in inputs/: read_file to see them again.]`
}
