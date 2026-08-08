import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearAgentFileActivitySession,
  clearAgentFileActivityChat,
  getAgentFileActivity,
  normalizeAgentFileTarget,
  publishAgentFileActivity,
  subscribeAgentFileActivity
} from "./agent-file-activity.js"

afterEach(() => {
  clearAgentFileActivitySession("s1")
  clearAgentFileActivitySession("s2")
})

describe("agent file activity", () => {
  it("publishes monotonic file targets per session and chat", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAgentFileActivity(listener)

    publishAgentFileActivity("s1", "c1", {
      eventId: "edit-1",
      path: "src/a.ts",
      phase: "editing"
    })
    const editingSequence = getAgentFileActivity("s1", "c1")?.sequence
    publishAgentFileActivity("s1", "c1", {
      eventId: "edit-1",
      path: "src/a.ts",
      phase: "editing"
    })
    publishAgentFileActivity("s1", "c1", {
      eventId: "edit-1",
      path: "src/a.ts",
      phase: "completed"
    })

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getAgentFileActivity("s1", "c1")).toMatchObject({
      eventId: "edit-1",
      phase: "completed",
      sequence: (editingSequence ?? 0) + 1
    })
    unsubscribe()
  })

  it("keeps background chat file activity isolated", () => {
    publishAgentFileActivity("s1", "foreground", {
      eventId: "one",
      path: "src/foreground.ts",
      phase: "editing"
    })
    publishAgentFileActivity("s1", "background", {
      eventId: "two",
      path: "src/background.ts",
      phase: "editing"
    })

    expect(getAgentFileActivity("s1", "foreground")?.path).toBe("src/foreground.ts")
    expect(getAgentFileActivity("s1", "background")?.path).toBe("src/background.ts")
  })

  it("clears file activity when a chat or session is disposed", () => {
    publishAgentFileActivity("s1", "c1", {
      eventId: "one",
      path: "src/a.ts",
      phase: "editing"
    })
    publishAgentFileActivity("s1", "c2", {
      eventId: "two",
      path: "src/b.ts",
      phase: "editing"
    })
    clearAgentFileActivityChat("s1", "c1")
    expect(getAgentFileActivity("s1", "c1")).toBeNull()
    expect(getAgentFileActivity("s1", "c2")).not.toBeNull()
    clearAgentFileActivitySession("s1")
    expect(getAgentFileActivity("s1", "c2")).toBeNull()
  })
})

describe("normalizeAgentFileTarget", () => {
  it("normalizes contained absolute and repository-relative agent targets", () => {
    expect(normalizeAgentFileTarget("./src/a.ts:12:4", "/work/repo")).toBe("src/a.ts")
    expect(normalizeAgentFileTarget("/work/repo/src/a.ts", "/work/repo")).toBe("src/a.ts")
  })

  it("normalizes macOS private aliases and case-insensitive Windows roots", () => {
    expect(
      normalizeAgentFileTarget(
        "/private/Users/operator/worktree/src/a.ts",
        "/Users/operator/worktree"
      )
    ).toBe("src/a.ts")
    expect(
      normalizeAgentFileTarget(
        "/Users/operator/worktree/src/b.ts",
        "/private/Users/operator/worktree"
      )
    ).toBe("src/b.ts")
    expect(normalizeAgentFileTarget("c:\\WORK\\repo\\src\\a.ts", "C:\\work\\repo")).toBe(
      "src/a.ts"
    )
  })

  it("rejects traversal and targets outside the session worktree", () => {
    expect(normalizeAgentFileTarget("../../secret.ts", "/work/repo")).toBeNull()
    expect(normalizeAgentFileTarget("/other/repo/src/a.ts", "/work/repo")).toBeNull()
  })
})
