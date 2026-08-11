import type { Meta, StoryObj } from "@storybook/react-vite"
import type {
  Attachment,
  Message,
  PlanDocument,
  PlanPrdStage,
  PlanTaskStatus
} from "@jingler/core"
import { ConversationView } from "../app/conversation-view.js"
import { SEED_CONVERSATION } from "../seed.js"
import { testProviderCatalog } from "../test-support.js"
import { CodeChip } from "../components/code-chip.js"
import { DiffPeek } from "../components/diff-peek.js"
import { FileIcon } from "../components/file-icon.js"
import { ApprovalGate } from "./approval-gate.js"
import { Composer } from "./composer.js"
import { MessageTurn } from "./message-turn.js"
import { ModeSwitch } from "./mode-switch.js"
import { ToolCall } from "./tool-call.js"

const meta: Meta = { title: "Conversation/Overview" }
export default meta
type Story = StoryObj

const providerCatalog = testProviderCatalog(["low", "medium", "high"])
const { id: connectionId, providerId } = providerCatalog.connections[0]!.connection
const { id: modelId } = providerCatalog.connections[0]!.models[0]!

/** A tiny inline PNG so the attachment stories render without external assets. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const img = (name: string): Attachment => ({ id: name, name, mediaType: "image/png", data: PNG })

const planStage = (
  id: string,
  title: string,
  taskStatus: PlanTaskStatus,
  passed = false
): PlanPrdStage => ({
  id,
  title,
  intent: title,
  approach: [],
  tasks: [{ id: `${id}.task`, text: title, status: taskStatus }],
  files: [],
  diagrams: [],
  notes: [],
  acceptance: [{
    id: `${id}.1`,
    text: `${title} is verified.`,
    testReferences: [],
    status: passed ? "passed" : "pending",
    evidence: passed ? "Verified by the selected agent." : null
  }]
})

const LIVE_PLAN: PlanDocument = {
  id: "plan-chat-progress",
  sessionId: "session-story",
  producingChatId: "chat-story",
  revision: 8,
  status: "executing",
  plan: {
    title: "PRD: Single-agent execution",
    sections: [],
    stages: [
      planStage("01", "Register projects", "completed", true),
      planStage("02", "Create workspaces", "completed", true),
      planStage("03", "Redesign the composer", "in-progress"),
      planStage("04", "Reconcile amendments", "pending"),
      planStage("05", "Verify the workflow", "pending")
    ],
    annotations: []
  },
  updatedAt: "2026-07-30T09:00:00.000Z",
  updatedBy: "agent"
}
/** A user turn that attached two screenshots as context, plus a line of text. */
const USER_TURN_WITH_IMAGES: Message = {
  id: "u_img",
  role: "user",
  streaming: false,
  createdAt: "2026-07-13T10:00:00.000Z",
  parts: [
    { _tag: "Image", attachment: img("login-500.png") },
    { _tag: "Image", attachment: img("stacktrace.png") },
    { _tag: "Text", text: "Here's the failing screen and the stack trace — the token refresh 500s." }
  ]
}

export const Transcript: Story = {
  render: () => (
    <div className="flex w-[640px] flex-col gap-6 bg-editor p-6">
      {SEED_CONVERSATION.map((m) => (
        <MessageTurn key={m.id} message={m} />
      ))}
    </div>
  )
}

/** An assistant turn with rich output: inline + display LaTeX, and an opt-in
 *  sandboxed HTML preview block (defaults to the plain-text Code view). */
const RICH_TURN: Message = {
  id: "a_rich",
  role: "assistant",
  streaming: false,
  createdAt: "2026-07-13T10:01:00.000Z",
  parts: [
    {
      _tag: "Text",
      text: [
        "The energy–mass relation is $E = mc^2$, and the area under the curve is",
        "",
        "$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}.$$",
        "",
        "Here's a snippet you can preview:",
        "",
        "```html",
        '<button style="padding:8px 14px;border-radius:8px;background:#61afef;color:#0b0e14;border:0;">',
        "  Click me",
        "</button>",
        "```"
      ].join("\n")
    }
  ]
}

/** LaTeX + an opt-in HTML preview inside a normal assistant turn. */
export const RichPreviews: Story = {
  render: () => (
    <div className="flex w-[640px] flex-col gap-6 bg-editor p-6">
      <MessageTurn message={RICH_TURN} />
    </div>
  )
}

export const ToolWithDiffPeek: Story = {
  render: () => (
    <div className="w-[560px] bg-editor p-6">
      <ToolCall status="success" name="Edit" filePath="src/routes/billing.ts" target="src/routes/billing.ts" meta="+7 −0">
        <DiffPeek preview={"61  + router.post('/refund', rateLimit(5, '1m'), requireAuth, refundHandler)"} />
      </ToolCall>
    </div>
  )
}

export const Modes: Story = {
  render: () => (
    <div className="flex flex-col gap-3 bg-editor p-6">
      <ModeSwitch mode="ask" />
      <ModeSwitch mode="accept-edits" />
      <ModeSwitch mode="auto" paused />
    </div>
  )
}

export const Gates: Story = {
  render: () => (
    <div className="flex w-[560px] flex-col gap-3 bg-editor p-6">
      <ApprovalGate
        kind="command"
        title="Approval needed · run a command"
        detail="Not in your allowlist. Agents never run shell commands until you allow."
        command="npm test -- billing"
        allowLabel="npm test"
        status="pending"
      />
      <ApprovalGate
        kind="edit"
        title="Approval needed · edit refresh.ts"
        detail="Review the change above, then approve to write it to disk."
        status="approved"
      />
    </div>
  )
}

export const Chips: Story = {
  render: () => (
    <div className="flex items-center gap-2 bg-editor p-6">
      <FileIcon path="src/app.tsx" />
      <CodeChip path="src/routes/billing.ts" line={61} />
      <CodeChip path="README.md" onRemove={() => {}} />
    </div>
  )
}

export const ComposerWithMenus: Story = {
  render: () => (
    <div className="w-[560px] bg-editor p-6">
      <Composer
        environments={[
          {
            kind: "owned",
            id: "mac-mini",
            name: "Mac Mini",
            platform: { os: "darwin", arch: "arm64" },
            capabilities: {
              version: 1,
              capabilities: ["session.start"],
              maxConcurrentSessions: 4
            },
            state: "online",
            agentVersion: "2.0.3",
            lastSeenAt: Date.now()
          }
        ]}
        onSetEnvironment={() => {}}
        skills={[
          { name: "/plan", description: "Draft a plan before editing", source: "command" },
          { name: "/deploy", description: "Ship the app to production", source: "skill" }
        ]}
        files={["src/routes/billing.ts", "README.md"]}
        mode="accept-edits"
        providerCatalog={providerCatalog}
        connectionId={connectionId}
        modelId={modelId}
      />
    </div>
  )
}

/**
 * A user turn that attached images as context — the thumbnails render as a row
 * above the text (the transcript side of image attachments).
 */
export const MessageWithImages: Story = {
  render: () => (
    <div className="w-[640px] bg-editor p-6">
      <MessageTurn message={USER_TURN_WITH_IMAGES} />
    </div>
  )
}

/**
 * The composer while the agent is busy: sends are queued rather than blocked, so
 * the button reads "Queue" and the hint invites attaching an image.
 */
export const ComposerBusy: Story = {
  render: () => (
    <div className="w-[560px] bg-editor p-6">
      <Composer
        busy
        mode="accept-edits"
        providerCatalog={providerCatalog}
        connectionId={connectionId}
        modelId={modelId}
      />
    </div>
  )
}

/** The live canonical plan dock in its real position immediately above the composer. */
export const WithPlanProgress: Story = {
  render: () => (
    <div className="h-[760px] w-[760px] overflow-hidden bg-editor">
      <ConversationView
        messages={SEED_CONVERSATION}
        mode="accept-edits"
        providerCatalog={providerCatalog}
        connectionId={connectionId}
        providerId={providerId}
        modelId={modelId}
        busy
        branch="feature/provider-neutral-orchestration"
        repo="jingler"
        planDocument={LIVE_PLAN}
        onOpenPlanReview={(stageId) =>
          console.info("Open plan review", stageId)
        }
      />
    </div>
  )
}
