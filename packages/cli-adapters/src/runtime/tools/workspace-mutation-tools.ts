import {
  Command,
  CommandExecutor,
  FileSystem,
  Path
} from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { AssetService } from "../../asset.js"
import type { OffloadCommandRouterPort } from "../../offload-command-router.js"
import {
  ToolError,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolRegistry
} from "./tool-registry.js"

const roles = ["conversation", "plan-execution", "background"] as const
const modes = ["ask", "accept-edits", "auto"] as const
const PathInput = Schema.String.pipe(Schema.minLength(1))

interface ResolvedWorkspacePath {
  readonly absolute: string
  readonly relative: string
}

export interface WorkspaceMutationPort {
  readonly write: (
    cwd: string,
    path: string,
    content: string
  ) => Effect.Effect<{ readonly path: string }, ToolError>
  readonly edit: (
    cwd: string,
    path: string,
    oldText: string,
    newText: string,
    replaceAll: boolean
  ) => Effect.Effect<{ readonly path: string; readonly replacements: number }, ToolError>
  readonly remove: (
    cwd: string,
    path: string
  ) => Effect.Effect<{ readonly path: string }, ToolError>
  readonly rename: (
    cwd: string,
    from: string,
    to: string
  ) => Effect.Effect<{ readonly from: string; readonly to: string }, ToolError>
  readonly execute: (
    cwd: string,
    command: string,
    context: ToolExecutionContext
  ) => Effect.Effect<{
    readonly command: string
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }, ToolError>
}

const failure = (message: string): ToolError =>
  new ToolError("execution-failed", message)

const mapFailure = (message: string) =>
  Effect.mapError((cause: unknown) =>
    cause instanceof ToolError ? cause : failure(message)
  )

const isContained = (path: Path.Path, root: string, target: string): boolean =>
  target === root || target.startsWith(`${root}${path.sep}`)

/** Capture platform services once; individual tool calls remain typed Effects. */
export const makeWorkspaceMutationPort = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const assets = yield* AssetService
  const executor = yield* CommandExecutor.CommandExecutor

  const workspacePath = (
    cwd: string,
    requested: string,
    requireExisting: boolean
  ): Effect.Effect<ResolvedWorkspacePath, ToolError> =>
    Effect.gen(function* () {
      if (path.isAbsolute(requested)) {
        return yield* Effect.fail(failure("Workspace paths must be relative"))
      }
      return yield* resolveRelativeWorkspacePath(path, requested, fs, cwd, requireExisting)
    }).pipe(mapFailure("Could not resolve workspace path"))

  const write: WorkspaceMutationPort["write"] = (cwd, requested, content) =>
    Effect.gen(function* () {
      const target = yield* workspacePath(cwd, requested, false)
      if (yield* fs.exists(target.absolute)) {
        const current = yield* assets.read(cwd, target.relative).pipe(
          Effect.mapError(() => failure(`Could not read workspace file: ${target.relative}`))
        )
        if (current.kind === "image" || current.kind === "pdf") {
          return yield* Effect.fail(failure("Binary workspace files cannot be overwritten"))
        }
        yield* assets.write(cwd, target.relative, content, current.revision).pipe(
          Effect.mapError(() => failure(`Could not write workspace file: ${target.relative}`))
        )
      } else {
        yield* fs.makeDirectory(path.dirname(target.absolute), { recursive: true }).pipe(
          Effect.mapError(() => failure(`Could not create parent directory: ${target.relative}`))
        )
        yield* fs.writeFileString(target.absolute, content).pipe(
          Effect.mapError(() => failure(`Could not create workspace file: ${target.relative}`))
        )
      }
      return { path: target.relative }
    }).pipe(mapFailure("Could not write workspace file"))

  const edit: WorkspaceMutationPort["edit"] = (
    cwd,
    requested,
    oldText,
    newText,
    replaceAll
  ) =>
    Effect.gen(function* () {
      if (oldText.length === 0) {
        return yield* Effect.fail(failure("Edit oldText must not be empty"))
      }
      return yield* editWorkspaceText(
        workspacePath,
        cwd, requested,
        assets,
        oldText,
        replaceAll, newText)
    })

  const remove: WorkspaceMutationPort["remove"] = (cwd, requested) =>
    Effect.gen(function* () {
      const target = yield* workspacePath(cwd, requested, true)
      const info = yield* fs.stat(target.absolute).pipe(
        Effect.mapError(() => failure(`Could not inspect workspace file: ${target.relative}`))
      )
      if (info.type !== "File") {
        return yield* Effect.fail(failure("Only workspace files can be deleted"))
      }
      yield* fs.remove(target.absolute).pipe(
        Effect.mapError(() => failure(`Could not delete workspace file: ${target.relative}`))
      )
      return { path: target.relative }
    })

  const rename: WorkspaceMutationPort["rename"] = (cwd, from, to) =>
    Effect.gen(function* () {
      const source = yield* workspacePath(cwd, from, true)
      const destination = yield* workspacePath(cwd, to, false)
      if (yield* fs.exists(destination.absolute)) {
        return yield* Effect.fail(failure(`Rename destination already exists: ${destination.relative}`))
      }
      yield* fs.makeDirectory(path.dirname(destination.absolute), { recursive: true }).pipe(
        Effect.mapError(() => failure(`Could not create rename destination: ${destination.relative}`))
      )
      yield* fs.rename(source.absolute, destination.absolute).pipe(
        Effect.mapError(() => failure(`Could not rename workspace file: ${source.relative}`))
      )
      return { from: source.relative, to: destination.relative }
    }).pipe(mapFailure("Could not rename workspace file"))

  const maxCommandOutput = 32_000
  const collect = (
    stream: Stream.Stream<Uint8Array, unknown>,
    context: ToolExecutionContext
  ): Effect.Effect<string, unknown> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.tap((chunk) =>
        Effect.sync(() => context.progress({
          message: chunk.slice(-maxCommandOutput),
          completed: null,
          total: null
        }))
      ),
      Stream.runFold("", (output, chunk) =>
        `${output}${chunk}`.slice(-maxCommandOutput)
      )
    )

  const execute: WorkspaceMutationPort["execute"] = (cwd, source, context) => {
    const shell = process.platform === "win32"
      ? Command.make("cmd.exe", "/d", "/s", "/c", source)
      : Command.make("/bin/sh", "-lc", source)
    const program = Effect.scoped(
      Effect.gen(function* () {
        const process = yield* shell.pipe(
          Command.workingDirectory(cwd),
          Command.start
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collect(process.stdout, context), collect(process.stderr, context), process.exitCode],
          { concurrency: 3 }
        )
        if (exitCode !== 0) {
          return yield* Effect.fail(
            failure(stderr.trim() || stdout.trim() || `Command exited ${exitCode}`)
          )
        }
        return { command: source, exitCode: Number(exitCode), stdout, stderr }
      })
    ).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.mapError((cause) =>
        cause instanceof ToolError ? cause : failure("Command execution failed")
      )
    )
    return program
  }

  return { write, edit, remove, rename, execute } satisfies WorkspaceMutationPort
})

const fileTool = <Input, Encoded>(
  definition: Pick<
    ToolDefinition<Input, Encoded>,
    "id" | "description" | "input" | "execute"
  >
): ToolDefinition<Input, Encoded> => ({
  ...definition,
  version: "1",
  risk: "mutate",
  roles,
  modes,
  timeoutMs: 30_000,
  outputBudget: 8_000,
  cancellable: false,
  idempotency: "keyed"
})

export interface WorkspaceCommandRouting {
  readonly sessionId: string
  readonly offload: OffloadCommandRouterPort
}

export const registerWorkspaceMutationTools = (
  registry: ToolRegistry,
  cwd: string,
  workspace: WorkspaceMutationPort,
  routing?: WorkspaceCommandRouting
): void => {
  registry.register(
    fileTool({
      id: "workspace_write",
      description: "Create or replace a UTF-8 text file inside the workspace.",
      input: Schema.Struct({ path: PathInput, content: Schema.String }),
      execute: ({ path, content }) => Effect.runPromise(workspace.write(cwd, path, content))
    })
  )
  registry.register(
    fileTool({
      id: "workspace_edit",
      description: "Replace exact text in an existing UTF-8 workspace file.",
      input: Schema.Struct({
        path: PathInput,
        oldText: Schema.String,
        newText: Schema.String,
        replaceAll: Schema.optionalWith(Schema.Boolean, { default: () => false })
      }),
      execute: ({ path, oldText, newText, replaceAll }) =>
        Effect.runPromise(workspace.edit(cwd, path, oldText, newText, replaceAll))
    })
  )
  registry.register(
    fileTool({
      id: "workspace_delete",
      description: "Delete one existing file inside the workspace.",
      input: Schema.Struct({ path: PathInput }),
      execute: ({ path }) => Effect.runPromise(workspace.remove(cwd, path))
    })
  )
  registry.register(
    fileTool({
      id: "workspace_rename",
      description: "Rename one workspace file without overwriting the destination.",
      input: Schema.Struct({ from: PathInput, to: PathInput }),
      execute: ({ from, to }) => Effect.runPromise(workspace.rename(cwd, from, to))
    })
  )
  registry.register({
    id: "command_execute",
    version: "1",
    description: "Run a shell command in the workspace and stream its output. Commands are killed after 10 minutes — run servers/watchers detached and split longer work into smaller commands. Eligible commands offload automatically; only the operator can force local execution by disabling Offload Compute.",
    input: Schema.Struct({
      command: Schema.String.pipe(Schema.minLength(1))
    }),
    risk: "execute",
    roles,
    modes,
    // 24h before: a command blocked on stdin or a foreground dev server hung
    // the whole turn for the rest of the day.
    timeoutMs: 10 * 60 * 1_000,
    outputBudget: 32_000,
    cancellable: true,
    idempotency: "unsafe",
    execute: ({ command }, context) =>
      Effect.runPromise(
        (routing
          ? routing.offload.executeIfEligible(
              cwd,
              routing.sessionId,
              command,
              context
            ).pipe(
              Effect.flatMap((remote) =>
                remote === null
                  ? workspace.execute(cwd, command, context)
                  : Effect.succeed(remote)
              )
            )
          : workspace.execute(cwd, command, context)),
        { signal: context.signal }
      )
  })
}

function* editWorkspaceText(
  workspacePath: (
    cwd: string,
    requested: string,
    requireExisting: boolean
  ) => Effect.Effect<ResolvedWorkspacePath, ToolError>,
  cwd: string,
  requested: string,
  assets: AssetService,
  oldText: string,
  replaceAll: boolean,
  newText: string
) {
  const target = yield* workspacePath(cwd, requested, true)
  const current = yield* assets
    .read(cwd, target.relative)
    .pipe(Effect.mapError(() => failure(`Could not read workspace file: ${target.relative}`)))
  if (current.kind === "image" || current.kind === "pdf") {
    return yield* Effect.fail(failure("Binary workspace files cannot be edited"))
  }
  const occurrences = current.text.split(oldText).length - 1
  if (occurrences === 0) {
    return yield* Effect.fail(failure("Edit oldText was not found"))
  }
  if (!replaceAll && occurrences > 1) {
    return yield* Effect.fail(
      failure("Edit oldText is ambiguous; provide more context or set replaceAll")
    )
  }
  const next = replaceAll
    ? current.text.replaceAll(oldText, () => newText)
    : current.text.replace(oldText, () => newText)
  yield* assets
    .write(cwd, target.relative, next, current.revision)
    .pipe(Effect.mapError(() => failure(`Could not edit workspace file: ${target.relative}`)))
  return { path: target.relative, replacements: replaceAll ? occurrences : 1 }
}

function* resolveRelativeWorkspacePath(
  path: Path.Path,
  requested: string,
  fs: FileSystem.FileSystem,
  cwd: string,
  requireExisting: boolean
) {
  const relative = path.normalize(requested)
  const segments = relative.split(path.sep)
  if (relative === "." || segments.includes("..") || segments.includes(".git")) {
    return yield* Effect.fail(failure("Workspace path is outside the editable tree"))
  }

  const root = yield* fs
    .realPath(cwd)
    .pipe(Effect.mapError(() => failure("Workspace root is unavailable")))
  const absolute = path.resolve(root, relative)
  if (!isContained(path, root, absolute)) {
    return yield* Effect.fail(failure("Workspace path escapes the editable tree"))
  }

  const exists = yield* fs.exists(absolute)
  if (requireExisting && !exists) {
    return yield* Effect.fail(failure(`Workspace path does not exist: ${relative}`))
  }

  let ancestor = exists ? absolute : path.dirname(absolute)
  while (!(yield* fs.exists(ancestor))) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) {
      return yield* Effect.fail(failure("Workspace path has no readable ancestor"))
    }
    ancestor = parent
  }
  const realAncestor = yield* fs
    .realPath(ancestor)
    .pipe(Effect.mapError(() => failure("Workspace path is unreadable")))
  if (!isContained(path, root, realAncestor)) {
    return yield* Effect.fail(failure("Workspace path crosses an escaping symlink"))
  }
  return { absolute, relative }
}
