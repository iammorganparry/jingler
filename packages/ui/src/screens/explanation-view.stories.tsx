import type { ExplanationDocument, VisualBlock } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { ExplanationView } from "./explanation-view.js"

const blocks: ReadonlyArray<VisualBlock> = [
  { kind: "prose", id: "prose", text: "The session keeps **one typed explanation** and advances it by revision." },
  { kind: "heading", id: "heading", level: 3, text: "Decision ladder" },
  {
    kind: "list",
    id: "list",
    ordered: true,
    items: ["Infer explanation intent", "Choose the smallest useful visual", "Publish one structured document"]
  },
  {
    kind: "code",
    id: "pseudocode",
    language: "text",
    code: "on(prompt)\n  if explanation intent\n    choose smallest visual\n    publish document\n  else\n    reply in chat"
  },
  {
    kind: "code",
    id: "call-tree",
    language: "text",
    code: "publishExplanation\n  ExplanationStore.publish\n    atomicWrite\n  Explanation.watch\n    ExplanationView"
  },
  {
    kind: "code",
    id: "component-tree",
    language: "tsx",
    code: "<SessionPane>\n  <ConversationPane>\n    useExplanationDocument()\n    <ExplanationView>\n      <VisualBlocks />"
  },
  {
    kind: "code",
    id: "file-tree",
    language: "text",
    code: "packages/\n├── core/          # typed explanation contract\n├── cli-adapters/  # publish + persistence\n└── ui/            # maintained visual renderer"
  },
  {
    kind: "code",
    id: "diff",
    language: "diff",
    code: " Conversation\n+Explanation\n Plan Review"
  },
  {
    kind: "table",
    id: "comparison",
    headers: ["Representation", "Best for", "Cost"],
    rows: [
      ["Call tree", "Runtime ownership", "Low"],
      ["Mermaid", "Interaction and state", "Medium"],
      ["Table", "Trade-offs", "Low"]
    ]
  },
  {
    kind: "diagram",
    id: "mermaid",
    source: "sequenceDiagram\n  participant U as Operator\n  participant A as Agent\n  participant V as Explanation view\n  U->>A: show me the request flow\n  A->>V: publish visual blocks\n  V-->>U: focused explanation"
  }
]

const completeDocument: ExplanationDocument = {
  id: "explanation-story",
  sessionId: "session-story",
  producingChatId: "chat-story",
  revision: 3,
  title: "How explanation publishing works",
  summary: "Inference and the explicit /explain skill converge on one typed, durable artifact path.",
  sections: [
    {
      id: "overview",
      title: "Overview",
      blocks: blocks.slice(0, 3)
    },
    {
      id: "code-shapes",
      title: "Code shapes",
      blocks: blocks.slice(3, 8)
    },
    {
      id: "comparison",
      title: "Choosing a visual",
      blocks: blocks.slice(8)
    }
  ],
  updatedAt: "2026-08-12T12:00:00.000Z"
}

const galleryDocument: ExplanationDocument = {
  ...completeDocument,
  id: "explanation-gallery",
  title: "Visual block gallery",
  summary: "Every maintained block type and every show-me code shape in one design surface.",
  sections: blocks.map((block) => ({
    id: `section-${block.id}`,
    title: block.id.replaceAll("-", " "),
    blocks: [block]
  }))
}

function Frame({
  document = completeDocument,
  width = 980,
  loading = false,
  error = null
}: {
  readonly document?: ExplanationDocument | null
  readonly width?: number
  readonly loading?: boolean
  readonly error?: string | null
}) {
  return (
    <div
      className="flex h-[760px] max-w-full overflow-hidden rounded-lg border border-hairline bg-editor"
      style={{ width }}
    >
      <ExplanationView document={document} loading={loading} error={error} onRetry={() => {}} />
    </div>
  )
}

const meta: Meta = {
  title: "Screens/Explanation View",
  component: ExplanationView,
  parameters: { layout: "centered" }
}
export default meta
type Story = StoryObj

/** The production composition with rationale, code shapes, comparison, and Mermaid flow. */
export const Complete: Story = { render: () => <Frame /> }

/** Every supported structured block and every compact visual code shape. */
export const VisualBlockGallery: Story = {
  render: () => <Frame document={galleryDocument} />
}

/** Compact pane behavior at the narrow end of Jingler's responsive range. */
export const Narrow: Story = {
  render: () => <Frame width={390} />
}

/** Wide reading surface; content remains bounded for readable line lengths. */
export const Wide: Story = {
  render: () => <Frame width={1280} />
}

export const Loading: Story = {
  render: () => <Frame document={null} loading />
}

export const Empty: Story = {
  render: () => <Frame document={null} />
}

export const Error: Story = {
  render: () => <Frame document={null} error="Could not load the latest explanation." />
}
