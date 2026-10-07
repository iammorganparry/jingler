import type { Project, ProjectRunCommand, WorkspacePortConfig } from "@jingler/core"
import { assign, fromPromise, setup } from "xstate"

export interface WorkflowInput {
  projectId: string
  setup?: string
  cleanup?: string
  runs: ReadonlyArray<ProjectRunCommand>
  ports?: WorkspacePortConfig
  copyFiles: ReadonlyArray<string>
  approve: boolean
}
export interface WorkflowDraft {
  setup: string
  cleanup: string
  runs: ProjectRunCommand[]
  primary: string
  previewUrl: string
  extras: { id: string; name: string; start: string }[]
  copyFiles: string
}
interface Input {
  project: Project
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
const emptyProject: Project = {
  id: "",
  name: "",
  path: "",
  imported: true,
  availability: "available",
  createdAt: "",
  updatedAt: "",
}
export const workflowDraft = (project: Project): WorkflowDraft => ({
  setup: project.workflow?.setup ?? "",
  cleanup: project.workflow?.cleanup ?? "",
  runs: (project.workflow?.runs ?? []).map((run) => ({ ...run })),
  primary: String(project.workflow?.ports?.primary ?? 3100),
  previewUrl: project.workflow?.ports?.previewUrl ?? "http://localhost:{port}",
  extras: (project.workflow?.ports?.extras ?? []).map((extra) => ({
    id: crypto.randomUUID(),
    name: extra.name,
    start: String(extra.start),
  })),
  copyFiles: (project.workflow?.copyFiles ?? []).join("\n"),
})
const PORT = /^\d+$/
const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const DRIVE = /^[A-Za-z]:/
const port = (value: string) => {
  const number = Number(value)
  if (!PORT.test(value) || !Number.isInteger(number) || number < 1024 || number > 65535)
    throw new Error("Ports must be whole numbers from 1024 to 65535.")
  return number
}
export function workflowPayload(projectId: string, draft: WorkflowDraft, approved: boolean): WorkflowInput {
  const runs = draft.runs.map((run, index) => {
    if (!run.label.trim() || !run.command.trim())
      throw new Error(`Run command row ${index + 1} needs a name and command.`)
    return { ...run, label: run.label.trim(), command: run.command.trim() }
  })
  const extras = draft.extras.map((extra) => {
    const name = extra.name.trim()
    if (!SERVICE_NAME.test(name))
      throw new Error("Service names must start with a letter and use letters, numbers or underscores.")
    return { name, start: port(extra.start) }
  })
  if (new Set(extras.map((extra) => extra.name.toUpperCase())).size !== extras.length)
    throw new Error("Additional port names must be unique.")
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
    ports: {
      primary: port(draft.primary),
      extras,
      ...(draft.previewUrl.trim() ? { previewUrl: draft.previewUrl.trim() } : {}),
    },
    copyFiles,
    approve: approved,
  }
}
const types: { context: Context; input: Input; events: Event } = {
  context: {
    project: emptyProject,
    onSave: () => {},
    draft: workflowDraft(emptyProject),
    approved: false,
    message: null,
    error: false,
  },
  input: { project: emptyProject, onSave: () => {} },
  events: { type: "SAVE" },
}
export const projectWorkflowMachine = setup({
  types,
  actors: {
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
