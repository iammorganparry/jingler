import type { ProjectConfig, Project, ProjectRunCommand } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface WorkflowInput {
  projectId: string
  setup?: string
  cleanup?: string
  runs: ReadonlyArray<ProjectRunCommand>
  copyFiles: ReadonlyArray<string>
  approve: boolean
}
export interface WorkflowDraft {
  setup: string
  cleanup: string
  runs: ProjectRunCommand[]
  copyFiles: string
}
interface Input {
  project: Project
  onReadConfig?(projectId: string): Promise<ProjectConfig>
  onConfigLoaded?(projectId: string, templates: NonNullable<ProjectConfig["routines"]>): void
  onSave(input: WorkflowInput): Promise<void> | void
}
interface Context extends Input {
  draft: WorkflowDraft
  approved: boolean
  message: string | null
  error: boolean
}
type Event =
  | { type: "EDIT"; draft: WorkflowDraft }
  | { type: "APPROVE"; approved: boolean }
  | { type: "SAVE" }
  | { type: "LOAD_CONFIG" }
export const workflowDraft = (project: Project): WorkflowDraft => ({
  setup: project.workflow?.setup ?? "",
  cleanup: project.workflow?.cleanup ?? "",
  runs: (project.workflow?.runs ?? []).map((run) => ({ ...run })),
  copyFiles: (project.workflow?.copyFiles ?? []).join("\n"),
})
const DRIVE = /^[A-Za-z]:/
export function workflowPayload(projectId: string, draft: WorkflowDraft, approved: boolean): WorkflowInput {
  const runs = draft.runs.map((run, index) => {
    if (!run.label.trim() || !run.command.trim())
      throw new Error(`Run command row ${index + 1} needs a name and command.`)
    return { ...run, label: run.label.trim(), command: run.command.trim() }
  })
  const copyFiles = draft.copyFiles
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    copyFiles.some(
      (path) =>
        path.includes("\0") ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path
          .split("/")
          .some((part) => part === ".." || part === "." || part.toLowerCase() === ".git" || !part) ||
        DRIVE.test(path),
    )
  )
    throw new Error("Copied files must use safe relative paths without traversal or .git.")
  return {
    projectId,
    ...(draft.setup.trim() ? { setup: draft.setup.trim() } : {}),
    ...(draft.cleanup.trim() ? { cleanup: draft.cleanup.trim() } : {}),
    runs,
    copyFiles,
    approve: approved,
  }
}
export const projectWorkflowMachine = setup({
  types: {
    context: {} as Context,
    input: {} as Input,
    events: {} as Event,
  },
  actors: {
    readConfig: fromPromise(async ({ input }: { input: Context }) => {
      if (!input.onReadConfig) throw new Error("Project configuration loading is unavailable.")
      return input.onReadConfig(input.project.id)
    }),
    save: fromPromise(async ({ input }: { input: Context }) => {
      await input.onSave(workflowPayload(input.project.id, input.draft, input.approved))
    }),
  },
}).createMachine({
  initial: "editing",
  context: ({ input }) => ({
    ...input,
    draft: workflowDraft(input.project),
    approved: input.project.workflow?.approvedDigest !== undefined,
    message: null,
    error: false,
  }),
  states: {
    editing: {
      on: {
        EDIT: {
          actions: assign(({ context, event }) =>
            JSON.stringify(context.draft) === JSON.stringify(event.draft)
              ? {}
              : { draft: event.draft, approved: false, message: null, error: false },
          ),
        },
        APPROVE: { actions: assign({ approved: ({ event }) => event.approved, message: null }) },
        SAVE: { target: "saving" },
        LOAD_CONFIG: { target: "readingConfig", actions: assign({ message: null, error: false }) },
      },
    },
    readingConfig: {
      invoke: {
        src: "readConfig", input: ({ context }) => context,
        onDone: { target: "editing", actions: [({ context, event }) => context.onConfigLoaded?.(context.project.id, event.output.routines ?? []), assign(({ context, event }) => ({
          draft: event.output.workflow ? workflowDraft({ ...context.project, workflow: event.output.workflow }) : context.draft,
          approved: event.output.workflow ? false : context.approved,
          message: "Loaded review drafts. Nothing has been saved or approved.", error: false,
        }))] },
        onError: { target: "editing", actions: assign({
          message: ({ event }) => event.error instanceof Error ? event.error.message : "Could not load project configuration.",
          error: true,
        }) },
      },
    },
    saving: {
      invoke: {
        src: "save",
        input: ({ context }) => context,
        onDone: {
          target: "editing",
          actions: assign({
            message: ({ context }) => context.approved
              ? "Saved and approved for this exact content."
              : "Saved without approval. Commands will not run.",
            error: false,
          }),
        },
        onError: {
          target: "editing",
          actions: assign({
            message: ({ event }) =>
              event.error instanceof Error ? event.error.message : "Could not save project workflow.",
            error: true,
          }),
        },
      },
    },
  },
})
