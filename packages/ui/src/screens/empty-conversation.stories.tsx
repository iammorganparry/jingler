import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Project, Session } from "@jingler/core"
import { Button } from "../components/button.js"
import { EmptyConversation } from "./empty-conversation.js"

const meta: Meta<typeof EmptyConversation> = {
  title: "Screens/EmptyConversation",
  component: EmptyConversation,
  parameters: { layout: "fullscreen" },
  args: {
    now: new Date(2026, 0, 1, 9),
    userName: "Morgan Parry",
    projects: [{ id: "p1", name: "jingler", path: "/repo" } as Project],
    loadBranches: async () => ["main", "dev"],
    onStartWithPrompt: () => {},
    onOpenSession: () => {},
    liveActivity: {}
  }
}
export default meta
type Story = StoryObj<typeof EmptyConversation>

const session = (id: string, title: string) => ({ id, title, archived: false } as unknown as Session)

/** Signed in, with sessions: Needs you / Running cards. */
export const WithSessions: Story = {
  args: { sessions: [session("s1", "Fix flaky login test"), session("s2", "Add CSV export")] }
}

/** Signed out: the greeting drops the name. */
export const SignedOut: Story = { args: { userName: undefined, sessions: [session("s1", "Fix flaky login test")] } }

/** First run: no sessions, so the starter rows show. */
export const FirstRun: Story = { args: { sessions: [] } }

/** With the MCP import card below the composer. */
export const WithImportCard: Story = {
  args: { sessions: [session("s1", "Fix flaky login test")], importCard: <Button variant="outline">Import MCP servers</Button> }
}
