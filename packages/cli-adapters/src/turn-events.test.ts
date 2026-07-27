import { describe, expect, it } from "vitest"
import type { StreamEvent } from "@jingler/core"
import { isTerminal, routeOf } from "./turn-events.js"

/**
 * Where each kind of event goes.
 *
 * Enumerated rather than inferred from the order of early returns, because two of
 * these routes exist to prevent a specific expensive mistake and neither is
 * obvious from the event's shape.
 */

const tool = (over: Partial<Extract<StreamEvent, { _tag: "ToolStart" }>> = {}): StreamEvent => ({
  _tag: "ToolStart",
  id: "t1",
  name: "Bash",
  target: null,
  ...over
})

describe("routeOf", () => {
  it("persists ordinary turn content", () => {
    expect(routeOf({ _tag: "Assistant", text: "hi" })).toBe("transcript")
    expect(routeOf({ _tag: "Thinking", text: "hmm", seconds: null, done: false })).toBe(
      "transcript"
    )
    expect(routeOf(tool())).toBe("transcript")
    expect(routeOf({ _tag: "Done", costUsd: 0, tokens: 0 })).toBe("transcript")
  })

  it("keeps live tool output OUT of the transcript", () => {
    // The trap. `ToolDelta` is not a sub-agent event, so before it was routed
    // explicitly it fell through to the transcript fold — a full read, decode,
    // encode and rewrite of the transcript file on every tick of a running
    // command. `ToolEnd` persists the authoritative output instead.
    expect(routeOf({ _tag: "ToolDelta", id: "t1", output: "…" })).toBe("stream-only")
  })

  it("sends background-task events to the registry, not the turn", () => {
    // They outlive the turn; persisting one would pin a still-running task to a
    // finished message.
    expect(
      routeOf({
        _tag: "BackgroundTaskStarted",
        id: "bg1",
        description: "watch",
        taskType: "bash",
        subagentType: null,
        toolUseId: null
      })
    ).toBe("background-task")
    expect(routeOf({ _tag: "BackgroundTasksChanged", ids: [] })).toBe("background-task")
  })

  it("gives sub-agent events their own tab, not the main turn", () => {
    // Folded in, an unrelated agent's output would interleave into the transcript.
    expect(
      routeOf({
        _tag: "SubagentStarted",
        id: "s1",
        name: "Explore",
        description: "survey",
        parentId: null
      })
    ).toBe("subagent")
  })

  it("prefers the registry when an event is both backgrounded AND a sub-agent", () => {
    // A backgrounded `Task` is both. The registry has to win: it is the surface
    // that survives the turn, and the dock is where the operator can stop it.
    const backgroundedSubagent: StreamEvent = {
      _tag: "BackgroundTaskStarted",
      id: "bg1",
      description: "survey",
      taskType: "subagent",
      subagentType: "Explore",
      toolUseId: "toolu_1"
    }
    expect(routeOf(backgroundedSubagent)).toBe("background-task")
  })
})

describe("isTerminal", () => {
  it("recognises the two events that end a turn", () => {
    expect(isTerminal({ _tag: "Done", costUsd: 0, tokens: 0 })).toBe(true)
    expect(isTerminal({ _tag: "Failed", message: "nope" })).toBe(true)
    expect(isTerminal({ _tag: "Assistant", text: "hi" })).toBe(false)
    expect(isTerminal(tool())).toBe(false)
  })
})
