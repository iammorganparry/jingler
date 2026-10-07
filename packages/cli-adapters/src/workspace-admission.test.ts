import { afterEach, describe, expect, it } from "vitest"
import {
  acquireWorkspaceActivity,
  acquireWorkspaceLifecycleActivity,
  closeWorkspaceAdmission,
  reopenWorkspaceAdmission,
  resetWorkspaceAdmissions,
  setWorkspaceAdmissionReadiness,
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

it("never shares a closure even when the reason matches", () => {
  const owner = closeWorkspaceAdmission("exclusive", "setup")
  expect(() => closeWorkspaceAdmission("exclusive", "setup")).toThrow(/already unavailable/)
  expect(reopenWorkspaceAdmission("exclusive", Symbol("setup"))).toBe(false)
  const activity = acquireWorkspaceLifecycleActivity("exclusive", "setup", owner)
  expect(() => acquireWorkspaceLifecycleActivity("exclusive", "cleanup", Symbol())).toThrow(/owner/)
  activity.release()
  expect(reopenWorkspaceAdmission("exclusive", owner)).toBe(true)
  expect(() => acquireWorkspaceLifecycleActivity("exclusive", "setup", owner)).toThrow(/owner/)
})

it("blocks restarted failed/interrupted work independently of ephemeral closure tokens", () => {
  setWorkspaceAdmissionReadiness("restart", "workspace cleanup-failed")
  expect(() => acquireWorkspaceActivity("restart", "native-child")).toThrow(/cleanup-failed/)
  const owner = closeWorkspaceAdmission("restart", "retry cleanup")
  acquireWorkspaceLifecycleActivity("restart", "cleanup", owner).release()
  reopenWorkspaceAdmission("restart", owner)
  expect(() => acquireWorkspaceActivity("restart", "terminal")).toThrow(/cleanup-failed/)
  setWorkspaceAdmissionReadiness("restart")
  acquireWorkspaceActivity("restart", "agent").release()
})
