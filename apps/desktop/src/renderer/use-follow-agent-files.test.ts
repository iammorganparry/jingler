import { afterEach, describe, expect, it } from "vitest"
import {
  clearAgentFileActivitySession,
  currentAgentFileActivity,
  publishAgentFileActivity,
  publishFleetAgentFileActivity
} from "./agent-file-activity.js"
import { followedAgentFile } from "./use-follow-agent-files.js"

afterEach(() => clearAgentFileActivitySession("s1"))

const edit = (eventId: string, path: string) =>
  ({ eventId, path, phase: "completed", preview: null }) as const
const followed = () => followedAgentFile(currentAgentFileActivity("s1", "c1"), "/wt")

describe("followedAgentFile", () => {
  it("opens the viewed subagent's edited file instead of the main chat's", () => {
    publishAgentFileActivity("s1", "c1", edit("main-1", "/wt/src/main.ts"))
    expect(followed()).toMatchObject({ path: "src/main.ts", eventId: "main-1", completed: true })

    publishFleetAgentFileActivity("s1", edit("sub-1", "/wt/src/sub.ts"))
    expect(followed()).toMatchObject({ path: "src/sub.ts", eventId: "sub-1" })

    publishFleetAgentFileActivity("s1", null)
    expect(followed()?.path).toBe("src/main.ts")
  })

  it("ignores edits outside the worktree", () => {
    publishAgentFileActivity("s1", "c1", edit("x", "/elsewhere/a.ts"))
    expect(followed()).toBeNull()
  })
})
