import type { ProviderId } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { createEditorLayout, dropTab, focusedGroup } from "../app/editor-layout.js"
import { initEditorLayout, resetEditorLayouts } from "../app/editor-layout-machine.js"
import { testSession } from "../test-support.js"
import { SessionPane } from "./session-pane.js"

const meta = {
  title: "Screens/SessionPane",
  parameters: { layout: "fullscreen" }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const editorSession = testSession({
  id: "editor-groups-story",
  repo: "jingler",
  branch: "feat/editor-groups",
  title: "IDE editor groups",
  chats: [
    { id: "chat-nav", title: "Chat navigation", providerId: "anthropic" as ProviderId, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" },
    { id: "chat-files", title: "File tabs", providerId: "openai-codex" as ProviderId, createdAt: "2026-09-01T10:01:00.000Z", updatedAt: "2026-09-01T10:01:00.000Z" }
  ],
  activeChatId: "chat-nav"
})

function EditorGroupsPreview() {
  useState(() => {
    resetEditorLayouts()
    let layout = createEditorLayout(
      [
        { kind: "chat", id: "chat-nav" },
        { kind: "file", id: "packages/ui/src/app/editor-groups.tsx" }
      ],
      "chat-nav"
    )
    layout = dropTab(
      layout,
      { surface: { kind: "terminal", id: "t1" } },
      focusedGroup(layout)?.id ?? null,
      "bottom"
    )
    layout = dropTab(
      layout,
      { surface: { kind: "chat", id: "chat-files" } },
      focusedGroup(layout)?.id ?? null,
      "right"
    )
    initEditorLayout(editorSession.id, layout)
  })

  return (
    <div className="h-screen min-h-[620px] bg-app">
      <SessionPane
        session={editorSession}
        renderConversation={(session) => (
          <div className="flex flex-1 flex-col bg-editor p-6 text-sm text-text">
            <strong className="text-text-bright">
              {session.chats.find((chat) => chat.id === session.activeChatId)?.title}
            </strong>
            <p className="mt-2 text-dim">Chat transcript stays mounted while another tab is selected.</p>
          </div>
        )}
        renderFiles={(_session, ctx) => (
          <div className="flex flex-1 flex-col bg-editor p-6 font-mono text-xs text-text">
            <strong>{ctx.path ?? "Repository files"}</strong>
            <pre className="mt-3 text-dim">{"export function EditorGroups() {\n  return <Workbench />\n}"}</pre>
          </div>
        )}
        useSessionTerminals={() => ({
          tabs: [{ id: "t1", title: "zsh", status: "running" }],
          hydrated: true,
          create: async () => "t1",
          close: async () => {},
          restart: async () => "t1",
          renderTerminal: () => (
            <div className="flex flex-1 bg-canvas p-4 font-mono text-xs text-green">
              $ pnpm test -- editor-layout
            </div>
          )
        })}
      />
    </div>
  )
}

/** The real editor-group tree: mixed tabs, horizontal and vertical splits, breadcrumbs, and resize handles. */
export const EditorGroupsWorkbench: Story = {
  render: () => <EditorGroupsPreview />
}
