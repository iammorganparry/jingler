import type { Session } from "@jingler/core"
import { describe, expect, it, vi } from "vitest"
import { createActor, fromPromise, waitFor } from "xstate"
import {
  appMachine,
  type ChosenRepositoryDirectory,
  type InitialData
} from "./app-machine.js"

vi.mock("./rpc-client.js", () => ({ rpc: {} }))

const unconfigured = () =>
  appMachine.provide({
    actors: {
      initialLoad: fromPromise<InitialData>(async () => ({
        configured: false,
        clis: [],
        repos: [],
        sessions: []
      })),
      chooseDir: fromPromise<ChosenRepositoryDirectory | null>(async () => ({
        reposDir: "/repos",
        repos: []
      })),
      loadSessions: fromPromise<ReadonlyArray<Session>>(async () => [])
    }
  })

describe("appMachine first-run coordination", () => {
  it("adds a newly-published continuation session to the ready session list", async () => {
    const configured = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true,
          clis: [],
          repos: [],
          sessions: []
        }))
      }
    })
    const actor = createActor(configured).start()
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    const continuation = {
      id: "session-continuation",
      repo: "widget",
      branch: "main",
      title: "Local session continuation",
      status: "idle",
      cli: "codex",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-08-08T08:00:00.000Z",
      chats: [],
      activeChatId: "chat-1"
    } as Session

    actor.send({ type: "SESSION_UPDATED", session: continuation })

    expect(actor.getSnapshot().context.sessions).toContainEqual(continuation)
    actor.stop()
  })

  it("coordinates workspace selection, an explicit GitHub step, and skip", async () => {
    const actor = createActor(unconfigured()).start()
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { workspace: "idle" } }))

    actor.send({ type: "CHOOSE" })
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos")
    actor.send({ type: "CONTINUE" })
    expect(actor.getSnapshot().matches({ setup: "github" })).toBe(true)

    actor.send({ type: "SKIP_GITHUB" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.stop()
  })

  it("merges authoritative publish checkpoints without replacing concurrent session fields", async () => {
    const session = {
      id: "session-1",
      repo: "acme/widget",
      branch: "feat/publish-progress",
      title: "Current title",
      status: "idle",
      cli: "codex",
      diff: { added: 1, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-08-05T08:00:00.000Z",
      chats: [],
      activeChatId: "chat-1"
    } as Session
    const configured = appMachine.provide({
      actors: {
        initialLoad: fromPromise<InitialData>(async () => ({
          configured: true,
          clis: [],
          repos: [],
          sessions: [session]
        }))
      }
    })
    const actor = createActor(configured).start()
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))

    actor.send({
      type: "SESSION_PUBLISH_UPDATED",
      sessionId: session.id,
      checkpoint: {
        step: "complete",
        completed: ["inspecting", "verifying-branch", "pushing", "linking"],
        branch: session.branch,
        prNumber: 42,
        updatedAt: "2026-08-05T08:01:00.000Z"
      }
    })

    expect(actor.getSnapshot().context.sessions[0]).toMatchObject({
      title: "Current title",
      prNumber: 42,
      publish: { step: "complete", prNumber: 42 }
    })
    actor.stop()
  })

  it("resumes into the app when the separate GitHub machine reports connected", async () => {
    const actor = createActor(unconfigured()).start()
    await waitFor(actor, (snapshot) => snapshot.matches({ setup: { workspace: "idle" } }))
    actor.send({ type: "CHOOSE" })
    await waitFor(actor, (snapshot) => snapshot.context.reposDir === "/repos")
    actor.send({ type: "CONTINUE" })
    actor.send({ type: "GITHUB_CONNECTED" })
    await waitFor(actor, (snapshot) => snapshot.matches("ready"))
    actor.stop()
  })
})
