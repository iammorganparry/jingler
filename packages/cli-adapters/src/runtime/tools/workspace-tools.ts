import { Command, CommandExecutor } from "@effect/platform"
import type { AssetFileEntry } from "@jingler/core"
import { Data, Effect, Schema, Stream } from "effect"
import { AssetService } from "../../asset.js"
import { ToolError, type ToolDefinition, type ToolExecutionContext, type ToolRegistry } from "./tool-registry.js"

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
  readonly executeReadOnly: (
    cwd: string,
    program: "git" | "rg",
    args: ReadonlyArray<string>,
    context: ToolExecutionContext
  ) => Effect.Effect<{
    readonly command: string
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }, ToolError>
}

const inspectFailure = (message: string, cause?: unknown): WorkspaceInspectionError =>
  new WorkspaceInspectionError({ message, cause })

const READ_ONLY_GIT_COMMANDS = new Set([
  "branch", "diff", "grep", "log", "ls-tree", "rev-parse", "show", "status"
])
// Exact spellings only: Git accepts long abbreviations, automatic negation and
// bundled short options. Do not delegate that option grammar to Git.
const GIT_INSPECTION_FLAGS: Record<string, readonly string[]> = {
  branch: ["--list", "--all", "--remotes", "--show-current", "-a", "-r", "-v"],
  diff: ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--numstat", "--check", "--no-ext-diff", "--no-textconv", "-U0"],
  grep: ["-n", "-i", "-l", "-F", "-E", "--cached", "--name-only"],
  log: ["--oneline", "--stat", "--name-only", "--graph", "--all", "--decorate", "--no-ext-diff", "--no-textconv"],
  "ls-tree": ["-r", "-t", "-l", "--name-only", "--long", "-z"],
  "rev-parse": ["--verify", "--short", "--show-toplevel", "--show-prefix", "--is-inside-work-tree", "--abbrev-ref"],
  show: ["--stat", "--name-only", "--oneline", "--no-ext-diff", "--no-textconv"],
  status: ["--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "-s", "-b", "-z"]
}
const RG_FLAGS = new Set(["-i", "-l", "-n"])

const invalidInspectionArgument = (argument: string): boolean =>
  argument.includes("\0") ||
  argument.startsWith("/") ||
  argument.split(/[\\/:]/).includes("..")

export const validateInspectionCommand = (
  program: "git" | "rg",
  args: ReadonlyArray<string>
): void => {
  if (args.length === 0) throw new ToolError("invalid-input", "Inspection command needs arguments")
  validateInspectionArguments(args, program)
}

/** Reuse AssetService's existing containment and size boundary for agent reads. */
export const makeWorkspaceInspectionPort = Effect.gen(function* () {
  const assets = yield* AssetService
  const executor = yield* CommandExecutor.CommandExecutor

  const collect = (
    stream: Stream.Stream<Uint8Array, unknown>,
    context: ToolExecutionContext
  ): Effect.Effect<string, unknown> => stream.pipe(
    Stream.decodeText(),
    Stream.tap((chunk) => Effect.sync(() => context.progress({ message: chunk, completed: null, total: null }))),
    Stream.runFold("", (output, chunk) => output + chunk)
  )

  const executeReadOnly: WorkspaceInspectionPort["executeReadOnly"] = (cwd, program, args, context) => {
    try {
      validateInspectionCommand(program, args)
    } catch (cause) {
      return Effect.fail(cause instanceof ToolError ? cause : new ToolError("forbidden", "Inspection command rejected"))
    }
    return Effect.scoped(Effect.gen(function* () {
      const commandProgram = "git"
      const commandArgs = program === "rg"
        ? ["grep", "--untracked", "--exclude-standard", ...args, "--", "."]
        : [args[0]!, ...(["diff", "show", "log"].includes(args[0]!) ? ["--no-ext-diff", "--no-textconv"] : []), ...args.slice(1)]
      const command = Command.make(commandProgram, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "diff.external=", "--no-pager", ...commandArgs).pipe(
        Command.workingDirectory(cwd),
        Command.env({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" })
      )
      const child = yield* Command.start(command)
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(child.stdout, context), collect(child.stderr, context), child.exitCode],
        { concurrency: 3 }
      )
      if (exitCode !== 0 && !(program === "rg" && exitCode === 1)) {
        return yield* Effect.fail(new ToolError(
          "execution-failed",
          stderr.trim() || stdout.trim() || `Inspection command exited ${exitCode}`
        ))
      }
      return { command: [program, ...args].join(" "), exitCode: Number(exitCode), stdout, stderr }
    })).pipe(
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.mapError((cause) => cause instanceof ToolError
        ? cause
        : new ToolError("execution-failed", "Inspection command failed"))
    )
  }

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
      ),
    executeReadOnly
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
  registry.register(
    inspectionTool({
      id: "command_inspect",
      description:
        "Run one bounded read-only Git or ripgrep command in the workspace using structured arguments. Shell syntax, write-capable Git operations, preprocessors, and paths outside the workspace are rejected.",
      input: Schema.Struct({
        program: Schema.Literal("git", "rg"),
        args: Schema.Array(Schema.String).pipe(Schema.minItems(1))
      }),
      execute: ({ program, args }, context) =>
        Effect.runPromise(workspace.executeReadOnly(cwd, program, args, context), {
          signal: context.signal
        })
    })
  )
}

function validateInspectionArguments(args: readonly string[], program: string) {
  if (args.some(invalidInspectionArgument)) {
    throw new ToolError("forbidden", "Inspection command cannot access paths outside the workspace")
  }
  validateInspectionProgram(program, args)
}

const GIT_COUNT = /^-[1-9][0-9]{0,3}$/
const unsafeGitOperand = (argument: string): boolean =>
  argument.includes(":/") || argument.includes(":\\") || argument.startsWith(":")
const permittedGitFlag = (command: string, argument: string): boolean =>
  GIT_INSPECTION_FLAGS[command]!.includes(argument) ||
  ((command === "log" || command === "show") && GIT_COUNT.test(argument))
const rejectGitArgument = (command: string): never => {
  throw new ToolError("forbidden", command === "branch" ? "git branch is limited to listing branches" : "Git argument can execute code or escape the workspace")
}
function validateGitInspection(command: string, rest: readonly string[]): void {
  let paths = false
  for (const argument of rest) {
    if (argument === "--") { paths = true; continue }
    if (argument.startsWith("-")) {
      if (paths || !permittedGitFlag(command, argument)) rejectGitArgument(command)
      continue
    }
    if (unsafeGitOperand(argument)) rejectGitArgument(command)
    if (command === "branch" && !rest.includes("--list")) rejectGitArgument(command)
  }
}
function validateInspectionProgram(program: string, args: readonly string[]) {
  if (program !== "git") { validateRipgrepArguments(args); return }
  const [subcommand, ...rest] = args
  if (!subcommand || !READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    throw new ToolError("forbidden", "Git subcommand is not read-only")
  }
  validateGitInspection(subcommand, rest)
}

function validateRipgrepArguments(args: readonly string[]) {
  let queryCount = 0
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (RG_FLAGS.has(argument)) continue
    if (argument.startsWith("-")) {
      throw new ToolError("forbidden", `rg flag is unavailable: ${argument}`)
    }
    queryCount += 1
  }
  if (queryCount !== 1) {
    throw new ToolError("forbidden", "rg accepts one pattern and searches only the workspace")
  }
}
