import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { GitError, ProjectConfig } from "@jingler/core"
import type { Project } from "@jingler/core"
import { Effect, Schema } from "effect"
import { anchoredFs } from "./anchored-fs.js"

export const PROJECT_CONFIG_MAX_BYTES = 1024 * 1024
const decodeConfig = (raw: string) => {
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new Error("Project configuration is not valid JSON.") }
  try { return Schema.decodeUnknownSync(ProjectConfig)(value) }
  catch { throw new Error("Project configuration does not match the v1 schema. Check fields, paths and version.") }
}
/** Canonicalize only the trusted registration root; descend without following symlinks. */
export const readProjectConfig = (project: Project) => Effect.tryPromise({
  try: async () => {
    if (project.environmentId !== undefined || project.imported !== true)
      throw new Error("Choose a registered local project to load configuration.")
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Shared project configuration is supported only on macOS and Linux. Windows is unsupported.")
    const root = await realpath(project.path)
    let bytes: Buffer
    try {
      bytes = (await anchoredFs.read(join(root, ".jingler", "project.json"), PROJECT_CONFIG_MAX_BYTES)).bytes
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new Error(code === "ENOENT"
        ? "No .jingler/project.json found in this local project."
        : "Could not safely read .jingler/project.json (regular files only, maximum 1 MiB).")
    }
    return decodeConfig(bytes.toString("utf8"))
  },
  catch: (error) => new GitError({ message:
    typeof error === "object" && error !== null && "code" in error
      ? "Could not read .jingler/project.json in this local project."
      : error instanceof Error ? error.message : "Could not read project configuration." }),
})
