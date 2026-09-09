import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Project, Session } from "@jingler/core"
import { FileCode2, Folder, Search } from "lucide-react"
import { testSession } from "../test-support.js"
import { AppShell } from "../app/app-shell.js"
import { TitleSearch } from "../app/title-search.js"
import { SessionConversation } from "./session-conversation.js"

const meta: Meta = {
  title: "Flows/Project sessions and explorer",
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj

const projects: ReadonlyArray<Project> = [
  { id: "jingler", name: "jingler", path: "/Users/morgan/repos/jingler", availability: "available", createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-09T09:00:00Z" },
  { id: "memory", name: "jingler-memory", path: "/Users/morgan/repos/jingler-memory", availability: "available", createdAt: "2026-08-01T09:00:00Z", updatedAt: "2026-09-08T09:00:00Z" },
  { id: "empty", name: "new-project", path: "/Users/morgan/repos/new-project", availability: "available", createdAt: "2026-09-09T09:00:00Z", updatedAt: "2026-09-09T09:00:00Z" }
]

const sessions: ReadonlyArray<Session> = [
  testSession({ id: "sidebar-flow", projectId: "jingler", repo: "jingler", repoPath: projects[0]!.path, title: "Projects then sessions", branch: "feat/project-navigation", updatedAt: "2026-09-09T12:00:00Z" }),
  testSession({ id: "explorer-flow", projectId: "jingler", repo: "jingler", repoPath: projects[0]!.path, title: "Move files into Explorer", branch: "feat/worktree-explorer", updatedAt: "2026-09-09T11:00:00Z" }),
  testSession({ id: "memory-search", projectId: "memory", repo: "jingler-memory", repoPath: projects[1]!.path, title: "Tune memory search", branch: "fix/search-ranking", updatedAt: "2026-09-08T15:00:00Z" }),
  testSession({ id: "memory-worker", projectId: "memory", repo: "jingler-memory", repoPath: projects[1]!.path, title: "Review publish worker", branch: "chore/publish-worker", updatedAt: "2026-09-08T14:00:00Z" })
]

const files = ["packages/ui/src/app/project-sidebar.tsx", "packages/ui/src/app/session-sidebar.tsx", "apps/desktop/src/renderer/file-browser-view.tsx"]

function Explorer({ onOpenPath }: { onOpenPath: (path: string) => void }) {
  return (
    <div className="p-2" role="tree" aria-label="Story worktree files">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-text">
        <Folder size={13} className="text-cyan" /> src
      </div>
      {files.map((path) => (
        <button
          key={path}
          type="button"
          role="treeitem"
          onClick={() => onOpenPath(path)}
          className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-left font-mono text-[10.5px] text-muted-foreground hover:bg-surface hover:text-text"
        >
          <FileCode2 size={12} className="flex-none text-blue" />
          <span className="truncate">{path.split("/").at(-1)}</span>
        </button>
      ))}
    </div>
  )
}

function Flow() {
  const [activeSessionId, setActiveSessionId] = useState(sessions[0]!.id)
  const [openFile, setOpenFile] = useState<{ sessionId: string; path: string } | null>(null)
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null)

  return (
    <AppShell title="Project navigation flow">
      <SessionConversation
        projects={projects}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => {
          setCreatingProjectId(null)
          setOpenFile(null)
          setActiveSessionId(id)
        }}
        onNewSessionForProject={setCreatingProjectId}
        onAddProject={() => setCreatingProjectId("new")}
        search={<TitleSearch onOpen={() => {}} className="w-full" />}
        renderExplorer={(session, onOpenPath) => <Explorer onOpenPath={onOpenPath} />}
        onOpenFile={(sessionId, path) => setOpenFile({ sessionId, path })}
        newSessionViewActive={creatingProjectId !== null}
        newSessionView={
          <div className="grid flex-1 place-items-center bg-canvas">
            <div className="rounded-xl border border-line bg-panel px-8 py-6 text-center">
              <div className="text-sm font-semibold text-text-bright">New session</div>
              <div className="mt-1 text-xs text-dim">Project: {projects.find((project) => project.id === creatingProjectId)?.name ?? "new project"}</div>
            </div>
          </div>
        }
        renderConversation={(session) => {
          const selected = openFile?.sessionId === session.id ? openFile.path : null
          return (
            <div className="flex h-full flex-col bg-canvas p-8">
              <div className="mb-6 flex items-center gap-2 text-xs text-dim">
                <Search size={13} /> Pick a project, choose a session, then open Explorer.
              </div>
              <div className="m-auto w-full max-w-2xl rounded-xl border border-line bg-panel p-6">
                <div className="font-mono text-[10px] text-blue">{session.repo} · {session.branch}</div>
                <h2 className="mt-2 text-xl font-semibold text-text-bright">{selected ?? session.title}</h2>
                <p className="mt-3 text-sm text-muted-foreground">
                  {selected ? "Opened from the active session's worktree Explorer." : "This is the active session content. Switch projects to verify each project restores its last selected session."}
                </p>
              </div>
            </div>
          )
        }}
      />
    </AppShell>
  )
}

export const InteractiveFlow: Story = {
  render: () => <Flow />
}
