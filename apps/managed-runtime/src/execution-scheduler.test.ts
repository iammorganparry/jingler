import { describe, expect, it, vi } from "vitest"
import { ManagedExecutionScheduler } from "./execution-scheduler.js"

describe("ManagedExecutionScheduler", () => {
  it("does not queue an agent turn behind slow observation reads", async () => {
    let releaseObservation!: () => void
    const observation = new Promise<void>((resolve) => { releaseObservation = resolve })
    const started: string[] = []
    const execute = vi.fn(async (operation: string) => {
      started.push(operation)
      if (operation === "Sessions.transcriptPage") await observation
    })
    const scheduler = new ManagedExecutionScheduler(execute)

    const read = scheduler.schedule("Sessions.transcriptPage", "observe")
    const run = scheduler.schedule("Agent.run", "mutate")
    await vi.waitFor(() => expect(started).toEqual(["Sessions.transcriptPage", "Agent.run"]))
    releaseObservation()
    await Promise.all([read, run])
  })

  it("keeps workspace mutations ordered", async () => {
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const started: string[] = []
    const scheduler = new ManagedExecutionScheduler(async (operation: string) => {
      started.push(operation)
      if (operation === "Agent.run") await first
    })

    const run = scheduler.schedule("Agent.run", "mutate")
    const followup = scheduler.schedule("Workspace.importHandoff", "mutate")
    await vi.waitFor(() => expect(started).toEqual(["Agent.run"]))
    releaseFirst()
    await Promise.all([run, followup])
    expect(started).toEqual(["Agent.run", "Workspace.importHandoff"])
  })
})
