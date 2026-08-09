import type { Meta, StoryObj } from "@storybook/react-vite"
import type {
  CreateSessionInput,
  Environment,
  GitHubCloneRepository,
  HarnessCapability,
  Project,
  Session,
  SessionActivity
} from "@jingler/core"
import { useRef, useState } from "react"
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test"
import { SessionConversation } from "../screens/session-conversation.js"
import { AddProjectDialog } from "./add-project-dialog.js"
import { NewWorkspaceView, type NewWorkspaceViewProps } from "./new-workspace-view.js"

const FIRST_MESSAGE = /Message the agent/
const SEARCH_FOR_DIRECTORY = /Search for directory/
const STORYBOOK_PROJECT = /storybook-project/
const PREVIEW_PROJECT_PATH = "/Users/morgan/Code/storybook-project"
const PREVIEW_CLONE_PATH = "/Users/morgan/Code/widget"

const GITHUB_REPOSITORIES: ReadonlyArray<GitHubCloneRepository> = [
  { installationId: "101", repositoryId: "301", fullName: "acme/widget" },
  { installationId: "101", repositoryId: "302", fullName: "acme/design-system" },
  { installationId: "205", repositoryId: "401", fullName: "morgan/notes" }
]

const PROJECTS: ReadonlyArray<Project> = [
  {
    id: "project-jingler",
    name: "jingler",
    path: "/Users/morgan/Code/jingler",
    availability: "available",
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z"
  },
  {
    id: "project-relay",
    name: "device-relay",
    path: "/Users/morgan/Code/device-relay",
    availability: "available",
    createdAt: "2026-08-09T09:10:00.000Z",
    updatedAt: "2026-08-09T09:10:00.000Z"
  }
]

const sidebarSession = (
  input: Partial<Session> & Pick<Session, "id" | "title">
): Session => ({
  repo: "jingler",
  branch: `chore/${input.id}`,
  status: "idle",
  cli: "codex",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-09T10:00:00.000Z",
  chats: [{
    id: `chat-${input.id}`,
    title: null,
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z"
  }],
  activeChatId: `chat-${input.id}`,
  archived: false,
  ...input
})

const SIDEBAR_SESSIONS: ReadonlyArray<Session> = [
  sidebarSession({ id: "auth-flow", title: "Refactor auth flow", diff: { added: 42, removed: 8 } }),
  sidebarSession({ id: "token-refresh", title: "Fix token refresh", prNumber: 47 }),
  sidebarSession({ id: "storybook-polish", title: "Polish Storybook flows", repo: "device-relay", branch: "feat/storybook-flows" }),
  sidebarSession({ id: "release-check", title: "Check release readiness", repo: "device-relay", branch: "chore/release-check", status: "done" })
]

const SIDEBAR_ACTIVITY: Record<string, SessionActivity> = {
  "auth-flow": { kind: "thinking", verb: "Thinking", target: null },
  "token-refresh": { kind: "running", verb: "Running", target: "pnpm test -- auth" },
  "storybook-polish": { kind: "needs-approval", verb: "Needs approval", target: null }
}

const BUILDBOX: Environment = {
  id: "buildbox",
  name: "Buildbox",
  platform: { os: "linux", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    harnesses: ["claude", "codex"],
    maxConcurrentSessions: 4
  },
  state: "online",
  agentVersion: "2.0.3",
  lastSeenAt: Date.now()
}

const clis = [
  {
    kind: "claude" as const,
    label: "Claude Code",
    binPath: "/usr/local/bin/claude",
    version: "2.1.0",
    available: true
  },
  {
    kind: "codex" as const,
    label: "Codex CLI",
    binPath: "/usr/local/bin/codex",
    version: "0.144.1",
    available: true
  }
]

const CAPABILITIES: ReadonlyArray<HarnessCapability> = [
  {
    cli: "claude",
    label: "Claude Code",
    modes: [{ id: "ask", label: "Ask", kind: "execute" }],
    models: [
      { id: "opus", label: "Opus 5", description: "Deep reasoning" },
      { id: "haiku", label: "Haiku 4.5", description: "Fast tasks" }
    ]
  },
  {
    cli: "codex",
    label: "Codex CLI",
    modes: [{ id: "auto", label: "Auto", kind: "execute" }],
    models: [
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol", description: "Frontier coding" },
      { id: "gpt-5.6-luna", label: "gpt-5.6-luna", description: "Fast coding" }
    ]
  }
]

const projectForHost = (
  projects: ReadonlyArray<Project>,
  projectId: string,
  environmentId?: string
): Promise<Project> => {
  const project = projects.find((candidate) => candidate.id === projectId)
  if (!project) return Promise.reject(new Error("Project not found."))
  return Promise.resolve(
    environmentId === undefined ? project : { ...project, environmentId }
  )
}

const previewProject = (path: string, name?: string): Project => ({
  id: "project-storybook-preview",
  name: name?.trim() || path.split("/").filter(Boolean).at(-1) || "storybook-project",
  path,
  availability: "available",
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-09T10:00:00.000Z"
})

function PreviewAddProjectDialog(props: {
  open: boolean
  onClose: () => void
  onAdded: (project: Project) => void
}) {
  const [picker, setPicker] = useState<{
    title: string
    description: string
    value: string
    label: string
  } | null>(null)
  const pickerResolution = useRef<((value: string | null) => void) | null>(null)
  const openPicker = (input: NonNullable<typeof picker>): Promise<string | null> =>
    new Promise((resolve) => {
      pickerResolution.current = resolve
      setPicker(input)
    })
  const finishPicker = (value: string | null) => {
    pickerResolution.current?.(value)
    pickerResolution.current = null
    setPicker(null)
  }

  return (
    <>
      <AddProjectDialog
        open={props.open}
        onClose={props.onClose}
        browse={() => openPicker({
          title: "Choose a Git repository",
          description: "This preview stands in for Electron's native Finder dialog.",
          value: PREVIEW_PROJECT_PATH,
          label: "storybook-project"
        })}
        browseCloneDestination={(repositoryName) => openPicker({
          title: `Choose where to clone ${repositoryName}`,
          description: "The repository folder will be created inside this location.",
          value: PREVIEW_CLONE_PATH,
          label: "Code"
        })}
        listDirectories={async (path) => {
          const currentPath = path ?? "/Users/morgan/Code"
          return {
            path: currentPath,
            parentPath: currentPath === "/Users/morgan/Code" ? "/Users/morgan" : "/Users/morgan/Code",
            directories: currentPath === "/Users/morgan/Code"
              ? [{ name: "storybook-project", path: PREVIEW_PROJECT_PATH, isGitRepository: true }]
              : []
          }
        }}
        listGitHubRepositories={async () => GITHUB_REPOSITORIES}
        register={async ({ path, name }) => previewProject(path, name)}
        createDirectory={async ({ path, name }) => previewProject(path, name)}
        cloneFromGitHub={async ({ destination, name }) => previewProject(destination, name)}
        onAdded={props.onAdded}
      />
      {picker && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay p-8">
          <div role="dialog" aria-modal="true" aria-label="Native file browser preview" className="w-full max-w-[620px] overflow-hidden rounded-xl bg-panel shadow-2xl">
            <div className="px-5 py-4">
              <h2 className="text-[15px] font-semibold text-text-bright">{picker.title}</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">{picker.description}</p>
            </div>
            <div className="bg-hover px-3 py-2">
              <button type="button" className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-selected" onClick={() => finishPicker(picker.value)}>
                <span className="text-lg" aria-hidden="true">📁</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-text-bright">{picker.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{picker.value}</span>
                </span>
              </button>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3">
              <button type="button" className="min-h-10 rounded-md px-3 text-[12px] text-muted-foreground hover:bg-hover" onClick={() => finishPicker(null)}>Cancel</button>
              <button type="button" className="min-h-10 rounded-md bg-brand px-4 text-[12px] font-medium text-white hover:bg-brand-hover" onClick={() => finishPicker(picker.value)}>Choose {picker.label}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function NewSessionStory({
  sidebarSessions = [],
  sidebarActivity,
  ...args
}: NewWorkspaceViewProps & {
  sidebarSessions?: ReadonlyArray<Session>
  sidebarActivity?: Record<string, SessionActivity>
}) {
  const [open, setOpen] = useState(true)
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [projects, setProjects] = useState<ReadonlyArray<Project>>(args.projects)
  const [created, setCreated] = useState<CreateSessionInput | null>(null)

  const close = () => {
    setOpen(false)
    args.onClose()
  }

  return (
    <div className="flex h-screen w-full bg-panel">
      <SessionConversation
        sessions={sidebarSessions}
        environments={args.environments}
        clis={args.clis}
        activeSessionId={null}
        onSelectSession={() => {}}
        liveActivity={sidebarActivity}
        onNewSession={() => {
          setCreated(null)
          setOpen(true)
        }}
        showEmpty
        version="2.0.3"
        newSessionView={
          open ? (
            <NewWorkspaceView
              {...args}
              open
              projects={projects}
              onClose={close}
              onAddProject={() => {
                args.onAddProject?.()
                setAddProjectOpen(true)
              }}
              prepareProject={(projectId, environmentId) =>
                projectForHost(projects, projectId, environmentId)}
              onCreate={async (input) => {
                await args.onCreate(input)
                setCreated(input)
              }}
            />
          ) : undefined
        }
      />
      {created && (
        <div
          role="status"
          className="fixed bottom-4 right-4 rounded-lg border border-line bg-panel px-3 py-2 text-[11px] text-text shadow-lg"
        >
          Created {created.title ?? "untitled session"} in {created.repoName}
        </div>
      )}
      <PreviewAddProjectDialog
        open={addProjectOpen}
        onClose={() => setAddProjectOpen(false)}
        onAdded={(project) => {
          setProjects((current) => [...current.filter((item) => item.id !== project.id), project])
          setAddProjectOpen(false)
        }}
      />
    </div>
  )
}

const meta = {
  title: "Screens/New Session",
  component: NewWorkspaceView,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    projects: PROJECTS,
    environments: [BUILDBOX],
    clis,
    capabilities: CAPABILITIES,
    defaultCli: "codex",
    defaultModel: "gpt-5.6-sol",
    defaultProjectId: "project-jingler",
    prepareProject: (projectId, environmentId) =>
      projectForHost(PROJECTS, projectId, environmentId),
    loadBranches: async () => ["main", "develop", "release/2.0"],
    onCreate: fn(async () => {}),
    onAddProject: fn(),
    onClose: fn()
  },
  render: (args) => <NewSessionStory {...args} />
} satisfies Meta<typeof NewWorkspaceView>

export default meta
type Story = StoryObj<typeof meta>

/** Manual confirmation surface: sidebar stays fixed while creation owns the main pane. */
export const Ready: Story = {}

/** New Session remains in the main pane while existing work stays visible in the sidebar. */
export const PopulatedSidebar: Story = {
  render: (args) => (
    <NewSessionStory
      {...args}
      sidebarSessions={SIDEBAR_SESSIONS}
      sidebarActivity={SIDEBAR_ACTIVITY}
    />
  )
}

/** No registered project: the shared composer explains why it is unavailable. */
export const NoProjects: Story = {
  args: {
    projects: [],
    defaultProjectId: null,
    prepareProject: (projectId, environmentId) =>
      projectForHost([], projectId, environmentId)
  }
}

/** Open the real add-project dialog, register a directory, and select the added project. */
export const AddProjectFlow: Story = {
  args: {
    projects: [],
    defaultProjectId: null
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)

    await userEvent.click(canvas.getByRole("button", { name: "Add project" }))
    const dialog = within(await body.findByRole("dialog"))
    await userEvent.click(dialog.getByRole("option", { name: SEARCH_FOR_DIRECTORY }))
    await userEvent.click(await dialog.findByRole("option", { name: STORYBOOK_PROJECT }))
    await userEvent.click(await dialog.findByRole("button", { name: "Choose current folder" }))
    await userEvent.type(dialog.getByRole("textbox", { name: "Project name" }), "storybook-project")
    await userEvent.click(dialog.getByRole("button", { name: "Add project" }))

    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Project" })).toHaveTextContent("storybook-project")
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Base branch" })).toHaveTextContent("main")
    )
    expect(body.queryByRole("dialog")).not.toBeInTheDocument()
  }
}

/** Preview the native Finder handoff used by Browse, then register the selected repository. */
export const BrowseProjectFlow: Story = {
  args: { projects: [], defaultProjectId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)

    await userEvent.click(canvas.getByRole("button", { name: "Add project" }))
    const addProject = within(await body.findByRole("dialog", { name: "Add project" }))
    await userEvent.click(addProject.getByRole("option", { name: /^Browse/ }))
    const fileBrowser = await waitFor(() => {
      const element = canvasElement.ownerDocument.querySelector('[aria-label="Native file browser preview"]')
      if (!(element instanceof HTMLElement)) throw new Error("Native file browser did not open")
      return within(element)
    })
    fileBrowser.getByText("Choose storybook-project").click()
    await userEvent.click(await addProject.findByRole("button", { name: "Add project" }))

    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Project" })).toHaveTextContent("storybook-project")
    )
  }
}

/** Fetch GitHub App repositories, choose a native clone location, then clone the selection. */
export const CloneFromGitHubFlow: Story = {
  args: { projects: [], defaultProjectId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)

    await userEvent.click(canvas.getByRole("button", { name: "Add project" }))
    const addProject = within(await body.findByRole("dialog", { name: "Add project" }))
    await userEvent.click(addProject.getByRole("option", { name: /^Clone from GitHub/ }))
    await userEvent.click(await addProject.findByRole("option", { name: /widget.*acme on GitHub/i }))
    const fileBrowser = await waitFor(() => {
      const element = canvasElement.ownerDocument.querySelector('[aria-label="Native file browser preview"]')
      if (!(element instanceof HTMLElement)) throw new Error("Native file browser did not open")
      return within(element)
    })
    fileBrowser.getByText("Choose Code").click()
    await userEvent.click(await addProject.findByRole("button", { name: "Clone project" }))

    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Project" })).toHaveTextContent("widget")
    )
  }
}

/** Select another project, choose the host checkout, and create without a prompt. */
export const DirectSessionFlow: Story = {
  args: { onCreate: fn(async () => {}) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)

    await userEvent.click(canvas.getByRole("button", { name: "Project" }))
    await userEvent.type(body.getByPlaceholderText("Search projects…"), "relay")
    await userEvent.click(body.getByRole("option", { name: /device-relay/ }))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Base branch" })).toHaveTextContent("main")
    )
    await userEvent.click(canvas.getByRole("button", { name: "Base branch" }))
    await userEvent.type(body.getByPlaceholderText("Search branches…"), "release")
    await userEvent.click(body.getByRole("option", { name: /release\/2\.0/ }))
    await userEvent.click(canvas.getByRole("button", { name: "Checkout" }))
    await userEvent.click(body.getByRole("option", { name: /Local/ }))
    await userEvent.click(canvas.getByRole("button", { name: "Create workspace" }))

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-relay",
          baseBranch: "release/2.0",
          useWorktree: false
        })
      )
    )
  }
}

/** Send the first task through the real Composer and create an isolated session. */
export const FirstPromptFlow: Story = {
  args: { onCreate: fn(async () => {}) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const composer = await canvas.findByPlaceholderText(FIRST_MESSAGE)

    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Base branch" })).toHaveTextContent("main")
    )
    await userEvent.click(canvas.getByRole("button", { name: /^Model:/ }))
    expect(body.getByRole("option", { name: /Claude Code.*2 models/i })).toBeVisible()
    await userEvent.click(body.getByRole("option", { name: /Claude Code.*2 models/i }))
    await userEvent.click(body.getByRole("option", { name: /Opus 5/i }))
    fireEvent.change(composer, { target: { value: "Refine the empty-state transitions" } })
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" })

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-jingler",
          cli: "claude",
          model: "opus",
          initialPrompt: "Refine the empty-state transitions",
          useWorktree: true
        })
      )
    )
  }
}
