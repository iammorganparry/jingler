import type { Message, StreamEvent } from "@jingler/core"
import { applyStreamEvent, assistantMessage } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  KEEP_RECENT_TOOL_PARTS,
  compactMessageParts,
  compactMessages
} from "./transcript-compaction.js"

const TS = "2026-01-01T00:00:00.000Z"

const fold = (events: ReadonlyArray<StreamEvent>): Message =>
  events.reduce((m, e) => applyStreamEvent(m, e), assistantMessage("a_1", TS))

const toolStart = (id: string): StreamEvent => ({
  _tag: "ToolStart",
  id,
  name: "Bash",
  target: `echo ${id}`
})

const toolEnd = (id: string): StreamEvent => ({
  _tag: "ToolEnd",
  id,
  status: "success",
  meta: "1 line",
  diff: null,
  preview: "diff --git a b",
  output: `output of ${id}`
})

/** A message with `n` settled tool cards, each holding output + preview. */
const messageWithTools = (n: number): Message =>
  fold(
    Array.from({ length: n }, (_, i) => i).flatMap((i) => [
      toolStart(`t_${i}`),
      toolEnd(`t_${i}`)
    ])
  )

const tools = (m: Message) =>
  m.parts.flatMap((p) => (p._tag === "Tool" ? [p.tool] : []))

/** One settled edit tool whose FileChangeSet carries a per-file diff preview. */
const messageWithFileChanges = (): Message =>
  fold([
    toolStart("t_0"),
    {
      _tag: "ToolEnd",
      id: "t_0",
      status: "success",
      meta: null,
      diff: null,
      preview: null,
      fileChanges: {
        id: "fc_1",
        callId: "t_0",
        changes: [
          {
            status: "M",
            path: "src/a.ts",
            oldPath: null,
            added: 3,
            removed: 1,
            binary: false,
            noNewlineAtEnd: false,
            beforeBytes: 10,
            afterBytes: 20,
            preview: "@@ -1 +1 @@",
            patchArtifactId: null
          }
        ],
        totals: { added: 3, removed: 1 },
        authoritative: true,
        reconciledAt: TS
      }
    }
  ])

describe("compactMessageParts", () => {
  it("is an identity (same reference) below the keep window", () => {
    const msg = messageWithTools(KEEP_RECENT_TOOL_PARTS)
    expect(compactMessageParts(msg)).toBe(msg)
  })

  it("strips output and previews from cards older than the window, keeps the rest whole", () => {
    const msg = messageWithTools(KEEP_RECENT_TOOL_PARTS + 3)
    const compacted = tools(compactMessageParts(msg))

    for (const old of compacted.slice(0, 3)) {
      expect(old.compacted).toBe(true)
      expect(old.output).toBeUndefined()
      expect(old.preview).toBeNull()
    }
    for (const recent of compacted.slice(3)) {
      expect(recent.compacted).toBeUndefined()
      expect(recent.output).toBeDefined()
      expect(recent.preview).not.toBeNull()
    }
  })

  it("keeps everything a collapsed card renders", () => {
    const msg = messageWithTools(KEEP_RECENT_TOOL_PARTS + 1)
    const oldest = tools(compactMessageParts(msg))[0]!
    expect(oldest.name).toBe("Bash")
    expect(oldest.target).toBe("echo t_0")
    expect(oldest.status).toBe("success")
    expect(oldest.meta).toBe("1 line")
  })

  it("never touches a running card, even outside the window", () => {
    const events = Array.from({ length: KEEP_RECENT_TOOL_PARTS + 2 }, (_, i) => i).flatMap(
      (i) =>
        // t_0 never ends: it stays `running`, pushed past the window by the rest.
        i === 0 ? [toolStart("t_0")] : [toolStart(`t_${i}`), toolEnd(`t_${i}`)]
    )
    const running = tools(compactMessageParts(fold(events)))[0]!
    expect(running.status).toBe("running")
    expect(running.compacted).toBeUndefined()
  })

  it("is idempotent — a second pass finds nothing left to release", () => {
    const once = compactMessageParts(messageWithTools(KEEP_RECENT_TOOL_PARTS + 5))
    expect(compactMessageParts(once)).toBe(once)
  })

  it("compacts every settled card when the window is zero", () => {
    const all = tools(compactMessageParts(messageWithTools(2), 0))
    expect(all.every((t) => t.compacted === true)).toBe(true)
  })

  it("nulls per-file previews but keeps paths and counts", () => {
    const msg = messageWithFileChanges()
    const change = tools(compactMessageParts(msg, 0))[0]!.fileChanges!.changes[0]!
    expect(change.preview).toBeNull()
    expect(change.path).toBe("src/a.ts")
    expect(change.added).toBe(3)
  })
})

describe("compactMessages", () => {
  it("returns the same array when no message needed work", () => {
    const messages = [messageWithTools(2), messageWithTools(3)]
    expect(compactMessages(messages)).toBe(messages)
  })

  it("bounds each message independently, preserving untouched references", () => {
    const small = messageWithTools(1)
    const giant = messageWithTools(KEEP_RECENT_TOOL_PARTS * 2)
    const next = compactMessages([small, giant])
    expect(next[0]).toBe(small)
    expect(next[1]).not.toBe(giant)
    expect(
      tools(next[1]!).filter((t) => t.compacted === true)
    ).toHaveLength(KEEP_RECENT_TOOL_PARTS)
  })
})
