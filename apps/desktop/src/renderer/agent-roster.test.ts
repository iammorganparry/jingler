import { afterEach, describe, expect, it, vi } from "vitest"
import type { Session } from "@jingler/core"
import { projectAgentRoster } from "./agent-roster.js"
import {
  clearAgentFileActivitySession,
  getAgentTouchedFiles,
  publishAgentFileActivity
} from "./agent-file-activity.js"

vi.mock("./conversation-registry.js", () => ({ useChatActivities: () => ({}) }))
vi.mock("./plan-presence.js", () => ({ usePlanSessions: () => new Set() }))

afterEach(() => clearAgentFileActivitySession("session"))

describe("projectAgentRoster", () => {
  it("keeps peers separate and reports plan/activity state", () => {
    const session = {
      id: "session",
      chats: [
        { id: "a", title: "Agent A", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "b", title: "Agent B", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
      ],
      activeChatId: "a"
    } as unknown as Session
    const roster = projectAgentRoster(
      session,
      { b: { kind: "editing", verb: "Editing", target: "src/b.ts" } },
      new Set(["a"])
    )
    expect(roster).toMatchObject([
      { chatId: "a", status: "idle", planStage: "Plan active" },
      { chatId: "b", status: "running", task: "Editing src/b.ts" }
    ])
  })

  it("deduplicates and bounds touched files independently per agent", () => {
    for (let index = 0; index < 25; index += 1) {
      publishAgentFileActivity("session", "a", {
        eventId: `a-${index}`,
        path: `src/a-${index}.ts`,
        phase: "editing",
        preview: null
      })
    }
    publishAgentFileActivity("session", "a", {
      eventId: "a-duplicate",
      path: "src/a-24.ts",
      phase: "completed",
      preview: null
    })
    publishAgentFileActivity("session", "b", {
      eventId: "b-1",
      path: "src/shared.ts",
      phase: "editing",
      preview: null
    })

    expect(getAgentTouchedFiles("session", "a")).toHaveLength(20)
    expect(getAgentTouchedFiles("session", "a").filter((path) => path === "src/a-24.ts"))
      .toHaveLength(1)
    expect(getAgentTouchedFiles("session", "a")).not.toContain("src/shared.ts")
    expect(getAgentTouchedFiles("session", "b")).toEqual(["src/shared.ts"])
  })
})
