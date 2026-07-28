import { useMemo, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  parsePlanMdx,
  type PlanDocument,
  type PlanDocumentStatus
} from "@jingler/core"
import { Markdown } from "../components/markdown.js"
import { MermaidDiagram } from "../components/mermaid-diagram.js"
import { PlanEditor } from "./plan-editor.js"
import { PlanProseEditor } from "./plan-prose-editor.js"
import { PlanReview } from "../screens/plan-review.js"

/**
 * The Notion-like plan workspace (PR #124). These stories exercise the new
 * surfaces in isolation so they can be critiqued without launching the app:
 *
 * - **Diagrams** — a ```mermaid fence renders as a themed SVG, and a broken one
 *   degrades to an inline error card.
 * - **Editor** — the four modes (Edit = inline WYSIWYG, Rendered, Source, Split).
 * - **Review states** — empty (Start a plan), draft (Send to agent), proposed
 *   (Revise / Approve), and the conflict banner.
 *
 * Every fixture's `projection` is derived from its MDX `source` through the real
 * `parsePlanMdx`, so a story can never drift from what the parser actually emits.
 */

const SOURCE = `# PRD: Refactor auth into a TokenStore

## Context

Session tokens are read straight from an in-memory map today, so a stale token
throws instead of refreshing. This moves the lifecycle into a dedicated
\`TokenStore\` and adds a guarded 401-retry.

The request path we are changing:

\`\`\`mermaid
graph TD
  A[HTTP request] --> B[authMiddleware]
  B --> C{token expired?}
  C -- yes --> D[refresh + retry once]
  C -- no --> E[proceed]
  D --> E
  E --> F[response]
\`\`\`

## Goals

- One authoritative token lifecycle behind \`TokenStore\`.
- A 401 refresh that fires **at most once** per request.

## Non-goals

- Multi-device session revocation.

<Stage id="01" title="Create the TokenStore service">

### Intent

A dedicated store for the token lifecycle so callers stop touching the raw map.

### Approach

1. Add \`token-store.ts\` exposing \`get\` / \`set\` / \`refresh\`.
2. Cover it with unit tests.

<Acceptance id="01.1" status="passed">
TokenStore.refresh mints and persists a new token.
</Acceptance>

<Acceptance id="01.2" status="pending">
Concurrent requests share a single in-flight refresh.
</Acceptance>

<Annotation id="a1" stageId="01" author="user" status="open" quote="dedicated" prefix="A " suffix=" store for">
Should this be an Effect service like the rest of cli-adapters?
</Annotation>

</Stage>

## Risks

- A refresh loop on repeated 401s — mitigated by the single-flight guard.

## Rollout

Land behind the existing session path; revert by swapping the import back.
`

const makeDoc = (
  status: PlanDocumentStatus,
  source: string = SOURCE,
  revision = 3
): PlanDocument => {
  const parsed = parsePlanMdx(source)
  if (!parsed.valid) {
    throw new Error(`story fixture is invalid MDX: ${JSON.stringify(parsed.diagnostics)}`)
  }
  return {
    id: "plan_story",
    sessionId: "s_story",
    producingChatId: "c_story",
    revision,
    status,
    source,
    projection: parsed.projection,
    updatedAt: "2026-07-28T00:00:00.000Z",
    updatedBy: "agent"
  }
}

const meta: Meta = { title: "Plan/Plan Workspace" }
export default meta
type Story = StoryObj

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-[760px] w-full bg-editor">{children}</div>
)

/**
 * A ```mermaid fence renders as a themed SVG. The second one is deliberately
 * broken to show the inline error card — one bad fence must not blank the doc.
 */
export const Diagrams: Story = {
  render: () => (
    <div className="mx-auto w-[720px] space-y-6 bg-editor p-8">
      <div>
        <p className="mb-2 text-[11px] uppercase tracking-wide text-dim">Valid — flow diagram</p>
        <MermaidDiagram source={"graph TD\n  A[Start] --> B{ok?}\n  B -- yes --> C[Ship]\n  B -- no --> D[Fix]"} />
      </div>
      <div>
        <p className="mb-2 text-[11px] uppercase tracking-wide text-dim">Valid — sequence diagram</p>
        <MermaidDiagram
          source={
            "sequenceDiagram\n  Client->>API: request\n  API->>TokenStore: refresh()\n  TokenStore-->>API: token\n  API-->>Client: 200"
          }
        />
      </div>
      <div>
        <p className="mb-2 text-[11px] uppercase tracking-wide text-dim">Broken — degrades to an error card</p>
        <MermaidDiagram source={"graph TD\n  @@@ this is not valid @@@"} />
      </div>
    </div>
  )
}

/** The full editor. Toggle Edit / Rendered / Source / Split in the header. */
function EditorPlayground({ status = "proposed" }: { status?: PlanDocumentStatus }) {
  // Parsed once so Edit-mode section editors keep a stable buffer (no cursor
  // jump); Source view tracks the live draft.
  const document = useMemo(() => makeDoc(status), [status])
  const [draft, setDraft] = useState(SOURCE)
  return (
    <Frame>
      <PlanEditor
        document={document}
        draft={draft}
        state="clean"
        onEdit={setDraft}
        onCriterionChange={() => {}}
        onAnnotate={() => {}}
      />
    </Frame>
  )
}

export const Editor: Story = { render: () => <EditorPlayground /> }

/** Inline WYSIWYG editing of a single section body (the Edit-mode building block). */
function ProsePlayground() {
  const [value, setValue] = useState(
    "### Intent\n\nType here — this is **live** Tiptap. Try a `- list` or **bold**."
  )
  return (
    <div className="mx-auto w-[680px] bg-editor p-8">
      <div className="rounded-xl border border-line bg-panel p-5">
        <PlanProseEditor value={value} onChange={setValue} ariaLabel="Story prose" />
      </div>
      <pre className="mt-4 overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-[11px] text-dim">
        {value}
      </pre>
    </div>
  )
}

export const ProseEditor: Story = { render: () => <ProsePlayground /> }

/** Prose rendering with a mermaid fence and inline code, via the Markdown renderer. */
export const RenderedMarkdown: Story = {
  render: () => (
    <div className="mx-auto w-[720px] bg-editor p-8">
      <Markdown>{SOURCE.split("<Stage")[0]!}</Markdown>
    </div>
  )
}

/** Empty state — the always-present tab offers a way to start authoring. */
export const ReviewEmpty: Story = {
  render: () => (
    <Frame>
      <PlanReview plan={null} document={null} onStartDraft={() => {}} />
    </Frame>
  )
}

/** A user-authored draft — no agent run yet, so it offers "Send to agent". */
export const ReviewDraft: Story = {
  render: () => (
    <Frame>
      <PlanReview
        plan={null}
        document={makeDoc("draft")}
        draft={SOURCE}
        onStartDraft={() => {}}
        onSendToAgent={() => {}}
      />
    </Frame>
  )
}

/** An agent-proposed plan — Revise / Approve. */
export const ReviewProposed: Story = {
  render: () => (
    <Frame>
      <PlanReview plan={null} document={makeDoc("proposed")} draft={SOURCE} />
    </Frame>
  )
}

/** A settled (done) plan — read-only, criteria verified. */
export const ReviewDone: Story = {
  render: () => (
    <Frame>
      <PlanReview plan={null} document={makeDoc("done")} draft={SOURCE} />
    </Frame>
  )
}

/** The conflict banner — a remote revision arrived while a local draft had edits. */
export const ReviewConflict: Story = {
  render: () => {
    const localDraft = SOURCE.replace(
      "One authoritative token lifecycle",
      "One authoritative token lifecycle (local edit)"
    )
    const remote = makeDoc(
      "proposed",
      SOURCE.replace("at most once", "exactly once"),
      4
    )
    return (
      <Frame>
        <PlanReview
          plan={null}
          document={makeDoc("proposed")}
          draft={localDraft}
          remote={remote}
          syncState="conflict"
        />
      </Frame>
    )
  }
}
