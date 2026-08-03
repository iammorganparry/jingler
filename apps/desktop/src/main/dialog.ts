/**
 * The native folder picker, exposed as an Effect service so an RPC handler can
 * call it. Lives in the main process because `dialog.showOpenDialog` is
 * Electron-only; the renderer reaches it through the `Setup.chooseReposDir` RPC.
 */
import { dialog } from "electron"
import { Context, Effect, Layer } from "effect"

/** What to put on the picker. Defaults to the repos-folder wording. */
export interface ChooseDirectoryPrompt {
  readonly title: string
  readonly message: string
  /**
   * Offer a "New Folder" button. Right when picking a destination to create,
   * wrong when picking something that must already exist — a plugin folder the
   * operator makes on the spot is empty, and an empty folder is not a plugin.
   */
  readonly allowCreate?: boolean
}

export interface DialogServiceShape {
  /**
   * Open a directory picker; resolves to the chosen absolute path or null.
   *
   * Parameterised rather than hardcoded to the repos folder: the plugin
   * installer needs the same native picker with different words, and a second
   * copy of `showOpenDialog` would be a second place to get the `properties`
   * flags wrong.
   */
  readonly chooseDirectory: (prompt?: ChooseDirectoryPrompt) => Effect.Effect<string | null>
  /**
   * Open a save picker; resolves to the chosen absolute path or null when
   * cancelled. Required (not optional) so the memory export can never silently
   * no-op against a test double that forgot to provide it.
   */
  readonly saveFile: (prompt: {
    readonly title: string
    readonly defaultPath: string
  }) => Effect.Effect<string | null>
}

export class DialogService extends Context.Tag("@jingler/DialogService")<
  DialogService,
  DialogServiceShape
>() {}

const REPOS_PROMPT: ChooseDirectoryPrompt = {
  title: "Choose your repos folder",
  message: "Select the directory that contains your git repositories.",
  allowCreate: true
}

export const DialogServiceLive = Layer.succeed(DialogService, {
  chooseDirectory: (prompt: ChooseDirectoryPrompt = REPOS_PROMPT) =>
    Effect.promise(() =>
      dialog.showOpenDialog({
        title: prompt.title,
        message: prompt.message,
        properties: prompt.allowCreate ?? false
          ? ["openDirectory", "createDirectory"]
          : ["openDirectory"]
      })
    ).pipe(
      Effect.map((result) =>
        result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null)
      )
    ),
  saveFile: (prompt) =>
    Effect.promise(() =>
      dialog.showSaveDialog({
        title: prompt.title,
        defaultPath: prompt.defaultPath,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }]
      })
    ).pipe(Effect.map((result) => result.canceled ? null : (result.filePath ?? null)))
})
