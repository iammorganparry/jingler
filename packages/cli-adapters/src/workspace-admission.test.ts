import { afterEach, describe, expect, it } from "vitest"
import {
  acquireWorkspaceActivity,
  closeWorkspaceAdmission,
  reopenWorkspaceAdmission,
  resetWorkspaceAdmissions,
  waitForWorkspaceIdle,
  workspaceActivityCount
} from "./workspace-admission.js"

afterEach(resetWorkspaceAdmissions)

describe("workspace admission", () => {
  it("closes before new work can race shutdown and waits for admitted work", async () => {
    const lease = acquireWorkspaceActivity("s-1", "agent")
    closeWorkspaceAdmission("s-1", "archive is in progress")
    expect(() => acquireWorkspaceActivity("s-1", "terminal")).toThrow(/archive is in progress/)
    let settled = false
    const idle = waitForWorkspaceIdle("s-1").then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    lease.release()
    await idle
    expect(workspaceActivityCount("s-1")).toBe(0)
  })

  it("requires an explicit reopen after a failed operation", () => {
    const token = closeWorkspaceAdmission("s-1", "cleanup failed")
    expect(() => acquireWorkspaceActivity("s-1", "agent")).toThrow(/cleanup failed/)
    reopenWorkspaceAdmission("s-1", token)
    const lease = acquireWorkspaceActivity("s-1", "agent")
    lease.release()
  })
})
