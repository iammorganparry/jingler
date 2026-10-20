import { createEventBus } from "@earendil-works/pi-coding-agent"
import type { SubagentFleetEvent } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { PiSubagentLifecycleAdapter } from "./pi-subagent-lifecycle-adapter.js"

const parent = "parent-session"

/**
 * An async `workflowScript` run (`runs.all`/`runs.run`) spawns its children
 * inside the detached workflow process, not the parent's own pi session —
 * their `subagent:async-started` events carry no `sessionId` at all, only
 * `parentWorkflowRunId` naming the already-tracked workflow root. Before
 * this fix, `#belongsToParent` rejected a child with no `sessionId` unless
 * its id was ALREADY known (asyncStarts or an existing tree node) — which a
 * brand-new child's first announcement never is — so every workflow child
 * was silently dropped and the Fleet/SUBAGENTS panel stayed empty while the
 * fleet RPC still reported them running.
 */
describe("PiSubagentLifecycleAdapter workflow children", () => {
  it("registers a workflow child whose async-started event has no sessionId, via parentWorkflowRunId", () => {
    const events = createEventBus()
    const emitted: SubagentFleetEvent[] = []
    const adapter = new PiSubagentLifecycleAdapter({
      events,
      parentRuntimeSessionId: parent,
      controlJournal: null,
      emit: (event) => emitted.push(event),
      now: () => 10
    })
    adapter.start()

    events.emit("subagent:async-started", {
      lifecycleArtifactVersion: 3,
      id: "workflow-1",
      sessionId: parent,
      mode: "workflow",
      agent: "workflow"
    })
    events.emit("subagent:async-started", {
      lifecycleArtifactVersion: 3,
      id: "child-1",
      agent: "scout",
      goal: "Inspect one branch",
      parentWorkflowRunId: "workflow-1"
    })
    events.emit("subagent:async-started", {
      lifecycleArtifactVersion: 3,
      id: "child-2",
      agent: "reviewer",
      goal: "Review the diff",
      parentWorkflowRunId: "workflow-1"
    })

    const nodes = adapter.snapshot().nodes
    expect(nodes.map((node) => node.subagentId)).toEqual(
      expect.arrayContaining(["child-1", "child-2"])
    )
    expect(nodes.filter((node) => node.subagentId.startsWith("child-"))).toHaveLength(2)
    adapter.stop()
  })
})
