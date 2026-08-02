import { useState } from "react"
import type { PlanAnnotation, PlanParticipant } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanCommentLayer } from "./plan-comment-layer.js"

/**
 * `PlanCommentLayer` — the comment overlay over the read-only plan. It positions
 * a "comment on this step" affordance per `[data-stage]`, highlights anchored
 * spans, and opens threads from pins. Here it overlays a mock document container;
 * select text to get the "Add comment" prompt, or click a step's + button.
 */
const meta: Meta = { title: "Composites/Plan Comment Layer" }
export default meta
type Story = StoryObj

const participants: ReadonlyArray<PlanParticipant> = [
  { routingId: "orch", displayName: "Orchestrator", role: "orchestrator", lifecycle: "running", ownerRoutingId: null },
  { routingId: "worker-02", displayName: "codex · worker-02", role: "worker", lifecycle: "running", ownerRoutingId: "orch" }
]

const annotations: ReadonlyArray<PlanAnnotation> = [
  {
    id: "a-stage",
    stageId: "02",
    body: "Should we keep the streaming fallback?",
    author: "user",
    createdAt: "2026-08-02T10:00:00.000Z",
    status: "open",
    messages: [
      {
        id: "m1",
        body: "Should we keep the streaming fallback for composing plans?",
        authorKind: "user",
        authorId: "you",
        createdAt: "2026-08-02T10:00:00.000Z",
        mentionedParticipantIds: [],
        deliveryState: "sent"
      }
    ]
  },
  {
    id: "a-anchor",
    stageId: null,
    body: "Confirm read-only is the intent.",
    author: "agent",
    createdAt: "2026-08-02T10:05:00.000Z",
    status: "open",
    anchor: { quote: "read-only", prefix: "now ", suffix: " and agent" },
    messages: [
      {
        id: "m2",
        body: "Confirming this is fully read-only now.",
        authorKind: "agent",
        authorId: "worker-02",
        createdAt: "2026-08-02T10:05:00.000Z",
        mentionedParticipantIds: [],
        deliveryState: "sent"
      }
    ]
  }
]

function Harness() {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [log, setLog] = useState<string>("Select text, or click a step's + button.")
  return (
    <div
      ref={setContainer}
      className="relative h-[560px] w-[760px] overflow-auto bg-editor p-8 text-text-body"
    >
      <div className="mx-auto flex max-w-[560px] flex-col gap-4">
        <h1 className="text-[18px] font-semibold text-text-bright">PRD: Agent-authored plan view</h1>
        <p className="text-[13px] leading-[1.7]">
          The plan is now read-only and agent-controlled, presented across three pages.
        </p>
        <section data-stage="01" className="rounded-md border border-hairline p-3">
          <div className="text-[12px] font-semibold text-text-bright">01 · Read model</div>
          <p className="text-[12.5px] leading-[1.6]">Pure selectors derived from the projection.</p>
        </section>
        <section data-stage="02" className="rounded-md border border-hairline p-3">
          <div className="text-[12px] font-semibold text-text-bright">02 · Drop TipTap</div>
          <p className="text-[12.5px] leading-[1.6]">Render the sanitized HTML read-only.</p>
        </section>
      </div>
      {container && (
        <PlanCommentLayer
          annotations={annotations}
          participants={participants}
          containerRef={container}
          onAddComment={(target, body) =>
            setLog(`add comment on ${target.stageId ? `stage ${target.stageId}` : "selection"}: "${body}"`)
          }
          onReply={(id, body) => setLog(`reply to ${id}: "${body}"`)}
          onSetResolved={(id, resolved) => setLog(`${resolved ? "resolved" : "reopened"} ${id}`)}
        />
      )}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-panel/90 px-2 py-1 font-mono text-[10px] text-muted-foreground">
        {log}
      </div>
    </div>
  )
}

export const OverMockDoc: Story = { render: () => <Harness /> }
