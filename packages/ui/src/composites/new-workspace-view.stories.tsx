import type { Meta, StoryObj } from "@storybook/react-vite"
import type {
  CreateSessionInput,
  Environment,
  GitHubCloneRepository,
  IssueSummary,
  PrSummary,
  Project,
  Session,
  SessionActivity
} from "@jingler/core"
import { ProviderCatalog } from "@jingler/core"
import { Schema } from "effect"
import { useRef, useState } from "react"
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test"
import { FolderGit2, GitBranch, GitFork, GitPullRequest, SlidersHorizontal, SquarePen } from "lucide-react"
import { MotionTabs } from "../components/beui/index.js"
import { Select, SelectContent, SelectItem, SelectSearch, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { Button } from "../components/button.js"
import { GithubMark } from "../components/github-mark.js"
import { LinearMark } from "../components/linear-mark.js"
import { SearchInput } from "../components/search-input.js"
import { SessionConversation } from "../screens/session-conversation.js"
import { AddProjectDialog } from "./add-project-dialog.js"
import { Composer } from "./composer.js"
import { IssuePickerList } from "./issue-picker-list.js"
import { NewWorkspaceView, type NewWorkspaceViewProps } from "./new-workspace-view.js"
import { PrPickerList } from "./pr-picker-list.js"

const FIRST_MESSAGE = /Message the agent/
const SEARCH_FOR_DIRECTORY = /Search for directory/
const STORYBOOK_PROJECT = /storybook-project/
const PREVIEW_PROJECT_PATH = "/Users/morgan/Code/storybook-project"
const PREVIEW_CLONE_PATH = "/Users/morgan/Code/widget"

type PreviewSource = "blank" | "branch" | "pr" | "github" | "linear"

const PREVIEW_PRS: ReadonlyArray<PrSummary> = [
  {
    number: 182,
    title: "Restore provider-aware session creation",
    headRefName: "feat/session-sources",
    baseRefName: "main",
    author: { login: "morgan", avatarUrl: null },
    state: "open",
    isDraft: false,
    additions: 284,
    deletions: 61,
    updatedAt: "2026-08-10T06:30:00.000Z"
  },
  {
    number: 179,
    title: "Fix remote project preparation",
    headRefName: "fix/remote-projects",
    baseRefName: "main",
    author: { login: "alex", avatarUrl: null },
    state: "open",
    isDraft: true,
    additions: 97,
    deletions: 22,
    updatedAt: "2026-08-09T15:20:00.000Z"
  }
]

const issue = (
  providerId: "github" | "linear",
  id: string,
  identifier: string,
  title: string,
  labels: IssueSummary["labels"]
): IssueSummary => ({
  providerId,
  id,
  identifier,
  url: providerId === "github"
    ? `https://github.com/acme/jingler/issues/${id}`
    : `https://linear.app/acme/issue/${identifier}`,
  title,
  labels,
  state: "open",
  body: `Implement ${title.toLowerCase()} and preserve the existing session configuration controls.`,
  author: { id: "author-1", name: "Morgan", avatarUrl: null },
  assignees: [{ id: "assignee-1", name: "Morgan", avatarUrl: null }],
  updatedAt: "2026-08-10T07:10:00.000Z"
})

const GITHUB_ISSUES: ReadonlyArray<IssueSummary> = [
  issue("github", "241", "#241", "Restore sessions from GitHub issues", [
    { name: "product", color: "6f42c1" },
    { name: "desktop", color: "0e8a16" }
  ]),
  issue("github", "233", "#233", "Existing branch sessions lose their checkout", [
    { name: "bug", color: "d73a4a" }
  ])
]

const LINEAR_ISSUES: ReadonlyArray<IssueSummary> = [
  issue("linear", "linear-eng-418", "ENG-418", "Unify the new session entry points", [
    { name: "Feature", color: "5e6ad2" },
    { name: "Desktop", color: "0e8a16" }
  ]),
  issue("linear", "linear-eng-403", "ENG-403", "Show Linear issues in session creation", [
    { name: "Integration", color: "f9d0c4" }
  ])
]

const SOURCE_OPTIONS: ReadonlyArray<{
  value: PreviewSource
  label: string
  description: string
  icon: React.ReactNode
}> = [
  {
    value: "blank",
    label: "New task",
    description: "Start from a base branch",
    icon: <SquarePen size={15} className="text-muted-foreground" />
  },
  {
    value: "branch",
    label: "Existing branch",
    description: "Continue work already started",
    icon: <GitBranch size={15} className="text-muted-foreground" />
  },
  {
    value: "pr",
    label: "Pull request",
    description: "Work on an open GitHub PR",
    icon: <GitPullRequest size={15} className="text-muted-foreground" />
  },
  {
    value: "github",
    label: "GitHub issue",
    description: "Link and prefill from GitHub",
    icon: <GithubMark className="size-[15px] text-muted-foreground" />
  },
  {
    value: "linear",
    label: "Linear issue",
    description: "Link and prefill from Linear",
    icon: <LinearMark className="size-[15px] text-muted-foreground" />
  }
]

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
  kind: "owned",
  id: "buildbox",
  name: "Buildbox",
  platform: { os: "linux", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    maxConcurrentSessions: 4
  },
  state: "online",
  agentVersion: "2.0.3",
  lastSeenAt: Date.now()
}

const PROVIDER_CATALOG = Schema.decodeSync(ProviderCatalog)({
  refreshedAt: "2026-08-10T00:00:00.000Z",
  stale: false,
  connections: [{
    connection: {
      id: "openai-codex-local",
      providerId: "openai-codex",
      authKind: "openai-codex-oauth",
      account: { fingerprint: "storybook", displayLabel: "Storybook account" },
      targetId: "local",
      status: "authenticated",
      subscription: {
        entitlement: "active",
        planLabel: "Plus",
        expiresAt: null,
        quotaLabel: null,
        rateLimitLabel: null,
        confirmedBillingRoute: "subscription"
      },
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    },
    models: [{
      providerId: "openai-codex",
      id: "openai-codex/gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      capabilities: { contextWindow: 400_000, reasoning: ["low", "medium", "high"], vision: true },
      verification: "certified",
      selectable: true,
      certificationKey: "storybook-certification"
    }]
  }]
})

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
              onCreate={async (input, images) => {
                await args.onCreate(input, images)
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

function PreviewField({
  label,
  value,
  icon
}: {
  label: string
  value: string
  icon: React.ReactNode
}) {
  return (
    <div className="flex w-[240px] flex-col gap-0.5">
      <span className="px-2 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
        {label}
      </span>
      <button
        type="button"
        className="flex h-10 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-text-bright outline-none transition-[background-color,scale] hover:bg-surface active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-ring"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{value}</span>
        <span className="text-dim" aria-hidden>⌄</span>
      </button>
    </div>
  )
}

function SessionSourcePrototype({ initialSource = "blank" }: { initialSource?: PreviewSource }) {
  const [source, setSource] = useState<PreviewSource>(initialSource)
  const [search, setSearch] = useState("")
  const [selectedBranch, setSelectedBranch] = useState(
    initialSource === "branch" ? "feat/session-sources" : ""
  )
  const [selectedPr, setSelectedPr] = useState<PrSummary | null>(
    initialSource === "pr" ? PREVIEW_PRS[0]! : null
  )
  const initialIssues = initialSource === "linear" ? LINEAR_ISSUES : GITHUB_ISSUES
  const [selectedIssue, setSelectedIssue] = useState<IssueSummary | null>(
    initialSource === "github" || initialSource === "linear" ? initialIssues[0]! : null
  )
  const [draft, setDraft] = useState(
    selectedIssue ? `${selectedIssue.title}\n\n${selectedIssue.body}` : ""
  )

  const chooseSource = (next: PreviewSource) => {
    setSource(next)
    setSearch("")
    setSelectedBranch("")
    setSelectedPr(null)
    setSelectedIssue(null)
    setDraft("")
  }

  const issues = source === "linear" ? LINEAR_ISSUES : GITHUB_ISSUES
  const branch = source === "branch"
    ? selectedBranch || "Choose a branch"
    : source === "pr"
      ? selectedPr?.headRefName ?? "Choose a pull request"
      : "main"

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-editor" data-testid="session-source-prototype">
      <div className="flex h-12 flex-none items-center border-b border-hairline px-5">
        <h1 className="text-[13px] font-semibold text-text-bright">New session</h1>
        <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.4px] text-dim">
          Layout preview
        </span>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto px-6 py-8">
        <div className="m-auto flex w-full max-w-[980px] flex-col gap-4">
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.2px] text-text-bright">
              What are we working on?
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Choose where the work starts, configure the checkout, then send the first message.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
              Start from
            </span>
            <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Session source">
              {SOURCE_OPTIONS.map((option) => {
                const selected = option.value === source
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => chooseSource(option.value)}
                    className={`flex min-h-16 min-w-0 flex-col justify-center gap-1 rounded-lg border px-3 text-left outline-none transition-[background-color,border-color,scale] active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? "border-blue/55 bg-blue/10"
                        : "border-line bg-sunken hover:border-line-strong hover:bg-surface"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-[12.5px] font-medium text-text-bright">
                      {option.icon}
                      <span className="truncate">{option.label}</span>
                    </span>
                    <span className="truncate text-[10.5px] text-dim">{option.description}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <PreviewField
              label="Project"
              value="jingler"
              icon={<GitBranch size={15} className="text-muted-foreground" />}
            />
            <PreviewField
              label="Checkout mode"
              value={source === "pr" ? "PR worktree" : "Worktree"}
              icon={<GitPullRequest size={15} className="text-muted-foreground" />}
            />
            <PreviewField
              label={source === "branch" || source === "pr" ? "Working branch" : "Base branch"}
              value={branch}
              icon={<GitBranch size={15} className="text-muted-foreground" />}
            />
          </div>

          {source !== "blank" && (
            <section className="rounded-xl border border-line bg-panel p-3" aria-label="Source picker">
              <div className="mb-3 flex items-center gap-2">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={source === "branch"
                    ? "Search branches…"
                    : source === "pr"
                      ? "Search pull requests…"
                      : `Search ${source === "linear" ? "Linear" : "GitHub"} issues…`}
                  className="flex-1"
                />
                {source !== "branch" && (
                  <Button variant="secondary" className="h-[34px]">Just mine</Button>
                )}
              </div>

              {source === "branch" ? (
                <div className="grid grid-cols-2 gap-2">
                  {["feat/session-sources", "fix/linear-plugin-loading", "release/2.0", "main"]
                    .filter((candidate) => candidate.includes(search))
                    .map((candidate) => (
                      <button
                        key={candidate}
                        type="button"
                        aria-pressed={candidate === selectedBranch}
                        onClick={() => setSelectedBranch(candidate)}
                        className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-left font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          candidate === selectedBranch
                            ? "border-blue/55 bg-blue/10 text-text-bright"
                            : "border-line bg-sunken text-text hover:border-line-strong"
                        }`}
                      >
                        <GitBranch size={14} className="text-muted-foreground" />
                        {candidate}
                      </button>
                    ))}
                </div>
              ) : source === "pr" ? (
                <PrPickerList
                  prs={PREVIEW_PRS.filter((pr) => pr.title.toLowerCase().includes(search.toLowerCase()))}
                  selected={selectedPr?.number ?? null}
                  onSelect={setSelectedPr}
                />
              ) : (
                <IssuePickerList
                  issues={issues.filter((candidate) =>
                    `${candidate.identifier} ${candidate.title}`.toLowerCase().includes(search.toLowerCase()))}
                  selected={selectedIssue?.id ?? null}
                  onSelect={(next) => {
                    setSelectedIssue(next)
                    setDraft(`${next.title}\n\n${next.body}`)
                  }}
                />
              )}
            </section>
          )}

          <Composer
            value={draft}
            onValueChange={setDraft}
            placeholder={source === "pr"
              ? "Add an instruction for this pull request (optional)"
              : source === "branch"
                ? "What should the agent do on this branch?"
                : "Message the agent, tag @files, or use /commands and /skills"}
            repo="jingler"
            branch={branch}
            providerCatalog={PROVIDER_CATALOG}
            connectionId={PROVIDER_CATALOG.connections[0]!.connection.id}
            modelId={PROVIDER_CATALOG.connections[0]!.models[0]!.id}
            mode="auto"
            onSend={() => {}}
          />
        </div>
      </div>
    </div>
  )
}

function SessionSourceStory({ initialSource }: { initialSource?: PreviewSource }) {
  return (
    <div className="flex h-screen w-full bg-panel">
      <SessionConversation
        sessions={SIDEBAR_SESSIONS}
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        showEmpty
        version="2.0.3"
        newSessionViewActive
        newSessionView={<SessionSourcePrototype initialSource={initialSource} />}
      />
    </div>
  )
}

type MinimalConcept = "prompt-first" | "source-tabs" | "setup-dock"

function MinimalSessionConcept({ concept }: { concept: MinimalConcept }) {
  const [source, setSource] = useState<PreviewSource>("blank")
  const [project, setProject] = useState("jingler")
  const [branch, setBranch] = useState("main")
  const [checkout, setCheckout] = useState("worktree")
  const [draft, setDraft] = useState("")
  const sourceTabs = SOURCE_OPTIONS.map(({ value, label }) => ({ value, label }))
  const controls = (
    <>
      <ConceptSelect
        label="Project"
        value={project}
        onValueChange={setProject}
        icon={<FolderGit2 className="size-3.5 text-muted-foreground" />}
        options={[{ value: "jingler", label: "jingler" }, { value: "device-relay", label: "device-relay" }]}
      />
      {concept !== "source-tabs" && (
        <ConceptSelect
          label="Start from"
          value={source}
          onValueChange={(value) => setSource(value as PreviewSource)}
          icon={<SquarePen className="size-3.5 text-muted-foreground" />}
          options={SOURCE_OPTIONS.map(({ value, label, icon }) => ({ value, label, icon }))}
        />
      )}
      <ConceptSelect
        label="Checkout"
        value={checkout}
        onValueChange={setCheckout}
        icon={<GitFork className="size-3.5 text-muted-foreground" />}
        options={[{ value: "worktree", label: "Worktree" }, { value: "direct", label: "Local checkout" }]}
      />
      <ConceptSelect
        label={source === "branch" || source === "pr" ? "Branch" : "Base"}
        value={branch}
        onValueChange={setBranch}
        icon={<GitBranch className="size-3.5 text-muted-foreground" />}
        options={[{ value: "main", label: "main" }, { value: "develop", label: "develop" }, { value: "release/2.0", label: "release/2.0" }]}
      />
    </>
  )
  const composer = (
    <Composer
      value={draft}
      onValueChange={setDraft}
      placeholder="What do you want the agent to do?"
      repo={project}
      branch={branch}
      contextControls={concept === "prompt-first" ? controls : undefined}
      providerCatalog={PROVIDER_CATALOG}
      connectionId={PROVIDER_CATALOG.connections[0]!.connection.id}
      modelId={PROVIDER_CATALOG.connections[0]!.models[0]!.id}
      mode="auto"
      onSend={() => {}}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-editor">
      <header className="flex h-12 flex-none items-center border-b border-hairline px-5">
        <h1 className="text-[13px] font-semibold text-text-bright">New session</h1>
        <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-dim">Concept</span>
      </header>
      <main className="flex min-h-0 flex-1 overflow-auto px-6 py-10">
        <div className="m-auto flex w-full max-w-[760px] flex-col gap-5">
          <div className="text-center">
            <h2 className="text-[22px] font-semibold tracking-[-0.35px] text-text-bright">Start something</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">Describe the outcome. The setup stays out of your way.</p>
          </div>

          {concept === "prompt-first" && composer}

          {concept === "source-tabs" && (
            <>
              <MotionTabs items={sourceTabs} value={source} onChange={setSource} variant="segment" className="mx-auto" />
              {composer}
              <div className="mx-auto grid w-full max-w-[610px] grid-cols-3 gap-2">{controls}</div>
            </>
          )}

          {concept === "setup-dock" && (
            <>
              {composer}
              <div className="mx-auto flex max-w-full items-center gap-1 rounded-xl border border-line bg-panel p-1 shadow-sm">
                <span className="flex size-8 flex-none items-center justify-center text-dim" aria-hidden><SlidersHorizontal className="size-3.5" /></span>
                {controls}
              </div>
              <p className="text-center text-[10.5px] text-dim">Session starts from <span className="font-mono text-text">{project}/{branch}</span> in an isolated worktree.</p>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function ConceptSelect({ label, value, onValueChange, icon, options }: {
  label: string
  value: string
  onValueChange: (value: string) => void
  icon: React.ReactNode
  options: ReadonlyArray<{ value: string; label: string; icon?: React.ReactNode }>
}) {
  const selectedIcon = options.find((option) => option.value === value)?.icon ?? icon
  return (
    <Select value={value} onValueChange={onValueChange} placement="top" className="min-w-0 flex-1">
      <SelectTrigger ariaLabel={label} className="h-8 min-w-0 rounded-lg border-0 bg-transparent px-2 py-0 text-[11.5px] shadow-none hover:bg-surface">
        <span className="flex min-w-0 items-center gap-1.5">
          {selectedIcon}
          <SelectValue placeholder={label} className="truncate text-muted-foreground" />
        </span>
      </SelectTrigger>
      <SelectContent
        className="right-auto w-56"
        search={<SelectSearch autoFocus wrapperClassName="mb-2" placeholder={`Search ${label.toLowerCase()}…`} />}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex min-w-0 items-center gap-2">{option.icon}{option.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MinimalConceptStory({ concept }: { concept: MinimalConcept }) {
  return (
    <div className="flex h-screen w-full bg-panel">
      <SessionConversation
        sessions={SIDEBAR_SESSIONS}
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        showEmpty
        version="2.0.3"
        newSessionViewActive
        newSessionView={<MinimalSessionConcept concept={concept} />}
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
    providerCatalog: PROVIDER_CATALOG,
    defaultConnectionId: PROVIDER_CATALOG.connections[0]!.connection.id,
    defaultModelId: PROVIDER_CATALOG.connections[0]!.models[0]!.id,
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

/** Prompt Input first; every setup choice collapses into one quiet strip. */
export const MinimalPromptFirst: Story = {
  render: () => <MinimalConceptStory concept="prompt-first" />
}

/** BeUI expandable-tabs direction: source is the only prominent setup choice. */
export const MinimalSourceTabs: Story = {
  render: () => <MinimalConceptStory concept="source-tabs" />
}

/** BeUI overflow-actions direction: all setup lives in a compact dock. */
export const MinimalSetupDock: Story = {
  render: () => <MinimalConceptStory concept="setup-dock" />
}

/** Approval surface: all source choices are interactive on the unified screen. */
export const SessionSources: Story = {
  render: () => <SessionSourceStory />
}

/** Approval surface: continuing work on an existing branch. */
export const ExistingBranchSource: Story = {
  render: () => <SessionSourceStory initialSource="branch" />
}

/** Approval surface: selecting a pull request checks out its head branch. */
export const PullRequestSource: Story = {
  render: () => <SessionSourceStory initialSource="pr" />
}

/** Approval surface: GitHub issue selection prefills the shared Composer. */
export const GitHubIssueSource: Story = {
  render: () => <SessionSourceStory initialSource="github" />
}

/** Approval surface: Linear uses the same normalized issue layout as GitHub. */
export const LinearIssueSource: Story = {
  render: () => <SessionSourceStory initialSource="linear" />
}

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
    expect(body.getByRole("option", { name: /ChatGPT Codex.*1 model/i })).toBeVisible()
    await userEvent.click(body.getByRole("option", { name: /ChatGPT Codex.*1 model/i }))
    await userEvent.click(body.getByRole("option", { name: /GPT-5.6 Sol/i }))
    fireEvent.change(composer, { target: { value: "Refine the empty-state transitions" } })
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" })

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-jingler",
          connectionId: "openai-codex-local",
          providerId: "openai-codex",
          modelId: "openai-codex/gpt-5.6-sol",
          initialPrompt: "Refine the empty-state transitions",
          useWorktree: true
        })
      )
    )
  }
}
