import { type CheckoutFields, foldCheckout } from "../test-support"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Project, Session, SessionActivity } from "@jingler/core"
import { ProjectSidebar } from "./project-sidebar.js"

const meta = {
  title: "App/ProjectSidebar",
  component: ProjectSidebar,
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof ProjectSidebar>

export default meta
type Story = StoryObj<typeof meta>

const project = (over: Partial<Project> & Pick<Project, "id" | "name">): Project => ({
  availability: "available",
  path: `/Users/dev/repos/${over.id}`,
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  ...over
})

const session = (projectId: string, over: Partial<Session> & CheckoutFields & Pick<Session, "id" | "title">): Session => foldCheckout({
  repo: "jingler",
  branch: `feat/${over.id}`,
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-10-12T10:00:00.000Z",
  chats: [{ id: `c_${over.id}`, title: null, createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z" }],
  activeChatId: `c_${over.id}`,
  archived: false,
  projectId,
  ...over
})

const PROJECTS: ReadonlyArray<Project> = [
  project({ id: "jingler", name: "Jingler", path: "/Users/dev/repos/jingler" }),
  project({ id: "trigify", name: "Trigify", path: "/Users/dev/repos/trigify-app" }),
  project({ id: "demo", name: "Demo" })
]

const SESSIONS: ReadonlyArray<Session> = [
  session("jingler", { id: "s1", title: "Refactor auth flow" }),
  session("jingler", { id: "s2", title: "Fix token refresh", status: "running" }),
  session("trigify", { id: "s3", title: "Watch CI on #204", prNumber: 204 }),
  session("demo", { id: "s4", title: "Type-check watcher" })
]

const ACTIVITY: Record<string, SessionActivity> = {
  s2: { kind: "running", verb: "Running", target: "pnpm test" }
}

const PROJECT_OWNERS: Record<string, string> = {
  jingler: "iammorganparry",
  trigify: "trigify"
}

export const Default: Story = {
  args: {
    projects: PROJECTS,
    sessions: SESSIONS,
    activeProjectId: "jingler",
    liveActivity: ACTIVITY,
    projectOwners: PROJECT_OWNERS,
    onSelect: () => {},
    onAddProject: () => {}
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <ProjectSidebar {...args} />
    </div>
  )
}

export const ActiveProject: Story = {
  args: {
    projects: PROJECTS,
    sessions: SESSIONS,
    activeProjectId: "trigify",
    projectOwners: PROJECT_OWNERS,
    onSelect: () => {},
    onAddProject: () => {}
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <ProjectSidebar {...args} />
    </div>
  )
}

export const WithUnavailable: Story = {
  args: {
    projects: [
      ...PROJECTS,
      project({ id: "offline", name: "Offline", availability: "offline" })
    ],
    sessions: [
      ...SESSIONS,
      session("offline", { id: "s5", title: "Disk full session" })
    ],
    activeProjectId: "jingler",
    projectOwners: PROJECT_OWNERS,
    onSelect: () => {},
    onAddProject: () => {}
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <ProjectSidebar {...args} />
    </div>
  )
}
