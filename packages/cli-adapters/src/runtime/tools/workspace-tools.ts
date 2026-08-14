import type { AssetFileEntry } from "@jingler/core"
import { Data, Effect, Schema } from "effect"
import { AssetService } from "../../asset.js"
import type { ToolDefinition, ToolRegistry } from "./tool-registry.js"

const roles = [
  "conversation",
  "plan",
  "plan-execution",
  "review",
  "context-digest",
  "background"
] as const
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const
const EmptyInput = Schema.Struct({})
const EMPTY_PROVIDER_INPUT = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false
} as const

export class WorkspaceInspectionError extends Data.TaggedError(
  "WorkspaceInspectionError"
)<{ readonly message: string; readonly cause?: unknown }> {}

export interface WorkspaceTextFile {
  readonly path: string
  readonly text: string
  readonly language: string | null
  readonly revision: string
}

export interface WorkspaceInspectionPort {
  readonly listFiles: (
    cwd: string
  ) => Effect.Effect<ReadonlyArray<AssetFileEntry>, WorkspaceInspectionError>
  readonly readTextFile: (
    cwd: string,
    path: string
  ) => Effect.Effect<WorkspaceTextFile, WorkspaceInspectionError>
}

const inspectFailure = (message: string, cause?: unknown): WorkspaceInspectionError =>
  new WorkspaceInspectionError({ message, cause })

/** Reuse AssetService's existing containment and size boundary for agent reads. */
export const makeWorkspaceInspectionPort = Effect.gen(function* () {
  const assets = yield* AssetService
  return {
    listFiles: (cwd: string) =>
      assets.list(cwd).pipe(
        Effect.mapError((cause) =>
          inspectFailure("Could not list workspace files", cause)
        )
      ),
    readTextFile: (cwd: string, path: string) =>
      assets.read(cwd, path).pipe(
        Effect.flatMap((asset) =>
          asset.kind === "image" || asset.kind === "pdf"
            ? Effect.fail(
                inspectFailure(`Workspace file is not readable text: ${path}`)
              )
            : Effect.succeed({
                path: asset.path,
                text: asset.text,
                language: asset.language,
                revision: asset.revision
              })
        ),
        Effect.mapError((cause) =>
          cause instanceof WorkspaceInspectionError
            ? cause
            : inspectFailure(`Could not read workspace file: ${path}`, cause)
        )
      )
  } satisfies WorkspaceInspectionPort
})

const inspectionTool = <Input, Encoded>(
  definition: Pick<
    ToolDefinition<Input, Encoded>,
    "id" | "description" | "input" | "providerInputSchema" | "execute"
  >
): ToolDefinition<Input, Encoded> => ({
  ...definition,
  version: "1",
  risk: "read",
  roles,
  modes,
  timeoutMs: 30_000,
  outputBudget: 32_000,
  cancellable: true,
  idempotency: "safe"
})

export const registerWorkspaceInspectionTools = (
  registry: ToolRegistry,
  cwd: string,
  workspace: WorkspaceInspectionPort
): void => {
  registry.register(
    inspectionTool({
      id: "workspace_list_files",
      description:
        "List tracked and untracked non-ignored files in the current workspace.",
      input: EmptyInput,
      providerInputSchema: EMPTY_PROVIDER_INPUT,
      execute: () => Effect.runPromise(workspace.listFiles(cwd))
    })
  )
  registry.register(
    inspectionTool({
      id: "workspace_read_file",
      description:
        "Read one bounded text file inside the current workspace. Paths outside the workspace and escaping symlinks are rejected.",
      input: Schema.Struct({ path: Schema.String.pipe(Schema.minLength(1)) }),
      execute: ({ path }) =>
        Effect.runPromise(workspace.readTextFile(cwd, path))
    })
  )
}
