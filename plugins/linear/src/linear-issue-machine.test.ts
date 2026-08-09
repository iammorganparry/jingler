import type { IssueReference, IssueSummary } from "@jingler/plugin-sdk"
import { createActor, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import {
  linearIssueMachine,
  type LinearIssueDetail,
  type LinearIssueServices
} from "./linear-issue-machine.js"

const reference: IssueReference = {
  providerId: "linear",
  id: "issue-123",
  identifier: "ENG-123",
  url: "https://linear.app/acme/issue/ENG-123",
  title: "Retry failed payments",
  labels: [{ name: "bug", color: null }]
}

const summary: IssueSummary = {
  ...reference,
  state: "open",
  body: "Payment retries stop after the first failure.",
  author: { id: "user-1", name: "Morgan", avatarUrl: null },
  assignees: [],
  updatedAt: "2026-08-09T10:00:00.000Z"
}

const detail: LinearIssueDetail = {
  ...summary,
  createdAt: "2026-08-08T10:00:00.000Z",
  comments: [],
  statusName: "In Progress",
  priority: { value: 2, label: "High" },
  team: { id: "team-1", name: "Engineering", key: "ENG" },
  project: { id: "project-1", name: "Reliability" },
  cycle: { id: "cycle-1", name: "August" }
}

const services = (overrides: Partial<LinearIssueServices> = {}): LinearIssueServices => ({
  configured: vi.fn().mockResolvedValue(true),
  context: vi.fn().mockResolvedValue({
    viewer: { id: "user-1", name: "Morgan", avatarUrl: null },
    workspace: { id: "workspace-1", name: "Acme", urlKey: "acme" },
    teams: [{ id: "team-1", name: "Engineering", key: "ENG" }]
  }),
  list: vi.fn().mockResolvedValue([summary]),
  get: vi.fn().mockResolvedValue(detail),
  create: vi.fn().mockResolvedValue(summary),
  comment: vi.fn().mockResolvedValue(undefined),
  link: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

describe("linearIssueMachine configuration and linking", () => {
  it("moves from unconfigured to the unlinked picker", async () => {
    let configured = false
    const actor = createActor(
      linearIssueMachine,
      { input: { services: services({ configured: vi.fn(() => Promise.resolve(configured)) }) } }
    ).start()

    await waitFor(actor, (snapshot) => snapshot.matches("needsConfiguration"))
    configured = true
    actor.send({ type: "CONFIGURATION_CHANGED" })

    await waitFor(actor, (snapshot) => snapshot.matches("unlinked"))
    actor.stop()
  })

  it("links an existing issue", async () => {
    const link = vi.fn().mockResolvedValue(undefined)
    const actor = createActor(linearIssueMachine, {
      input: { services: services({ link }) }
    }).start()
    await waitFor(actor, (snapshot) => snapshot.matches("unlinked"))

    actor.send({ type: "LINK", issue: summary })
    await waitFor(actor, (snapshot) => snapshot.matches("detail"))

    expect(link).toHaveBeenCalledWith(reference)
    expect(actor.getSnapshot().context.issue?.identifier).toBe("ENG-123")
    actor.stop()
  })
})

describe("linearIssueMachine creation and comments", () => {
  it("creates and links a new issue", async () => {
    const create = vi.fn().mockResolvedValue(summary)
    const link = vi.fn().mockResolvedValue(undefined)
    const actor = createActor(linearIssueMachine, {
      input: { services: services({ create, link }) }
    }).start()
    await waitFor(actor, (snapshot) => snapshot.matches("unlinked"))

    actor.send({ type: "CREATE_CHANGED", field: "teamId", value: "team-1" })
    actor.send({ type: "CREATE_CHANGED", field: "title", value: "Retry failed payments" })
    actor.send({ type: "CREATE_SUBMIT" })
    await waitFor(actor, (snapshot) => snapshot.matches("detail"))

    expect(create).toHaveBeenCalledWith({
      teamId: "team-1",
      title: "Retry failed payments",
      description: ""
    })
    expect(link).toHaveBeenCalledWith(reference)
    actor.stop()
  })

  it("adds a comment and refreshes the timeline", async () => {
    const refreshed = {
      ...detail,
      comments: [{
        id: "comment-1",
        author: null,
        body: "I can reproduce this.",
        createdAt: "2026-08-09T11:00:00.000Z"
      }]
    }
    const get = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(refreshed)
    const comment = vi.fn().mockResolvedValue(undefined)
    const actor = createActor(linearIssueMachine, {
      input: { linkedIssue: reference, services: services({ comment, get }) }
    }).start()
    await waitFor(actor, (snapshot) => snapshot.matches("detail"))

    actor.send({ type: "COMMENT_CHANGED", body: "  I can reproduce this.  " })
    actor.send({ type: "COMMENT_SUBMIT" })
    await waitFor(actor, (snapshot) =>
      snapshot.matches("detail") && snapshot.context.issue?.comments.length === 1
    )

    expect(comment).toHaveBeenCalledWith("issue-123", "I can reproduce this.")
    expect(actor.getSnapshot().context.commentBody).toBe("")
    actor.stop()
  })
})

describe("linearIssueMachine persistence and races", () => {
  it("unlinks only after persistence succeeds", async () => {
    let resolveUnlink: (() => void) | undefined
    const unlink = vi.fn(() => new Promise<void>((resolve) => { resolveUnlink = resolve }))
    const actor = createActor(linearIssueMachine, {
      input: { linkedIssue: reference, services: services({ unlink }) }
    }).start()
    await waitFor(actor, (snapshot) => snapshot.matches("detail"))

    actor.send({ type: "UNLINK" })
    expect(actor.getSnapshot().matches("unlinking")).toBe(true)
    expect(actor.getSnapshot().context.linkedIssue).toEqual(reference)

    resolveUnlink?.()
    await waitFor(actor, (snapshot) => snapshot.matches("unlinked"))
    expect(actor.getSnapshot().context.linkedIssue).toBeUndefined()
    actor.stop()
  })

  it("unlinks a linked issue that can no longer be loaded", async () => {
    const unlink = vi.fn().mockResolvedValue(undefined)
    const actor = createActor(linearIssueMachine, {
      input: {
        linkedIssue: reference,
        services: services({
          get: vi.fn().mockRejectedValue(new Error("Linear could not find this issue.")),
          unlink
        })
      }
    }).start()

    await waitFor(actor, (snapshot) => snapshot.matches("error"))
    actor.send({ type: "UNLINK" })
    await waitFor(actor, (snapshot) => snapshot.matches("unlinked"))

    expect(unlink).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context.linkedIssue).toBeUndefined()
    actor.stop()
  })

  it("keeps a dead issue linked when unlink persistence fails", async () => {
    const actor = createActor(linearIssueMachine, {
      input: {
        linkedIssue: reference,
        services: services({
          get: vi.fn().mockRejectedValue(new Error("Linear could not find this issue.")),
          unlink: vi.fn().mockRejectedValue(new Error("Could not save the session."))
        })
      }
    }).start()

    await waitFor(actor, (snapshot) => snapshot.matches("error"))
    actor.send({ type: "UNLINK" })
    await waitFor(actor, (snapshot) =>
      snapshot.matches("error") && snapshot.context.error === "Could not save the session."
    )

    expect(actor.getSnapshot().context.linkedIssue).toEqual(reference)
    actor.stop()
  })

  it("ignores a stale issue response after the session changes", async () => {
    let resolveOld: ((issue: LinearIssueDetail) => void) | undefined
    const other = { ...reference, id: "issue-456", identifier: "ENG-456" }
    const get = vi.fn((id: string) =>
      id === reference.id
        ? new Promise<LinearIssueDetail>((resolve) => { resolveOld = resolve })
        : Promise.resolve({ ...detail, ...other })
    )
    const actor = createActor(linearIssueMachine, {
      input: { linkedIssue: reference, services: services({ get }) }
    }).start()
    await waitFor(actor, (snapshot) => snapshot.matches("loadingIssue"))

    actor.send({ type: "SESSION_CHANGED", linkedIssue: other })
    await waitFor(actor, (snapshot) =>
      snapshot.matches("detail") && snapshot.context.issue?.id === other.id
    )
    resolveOld?.(detail)
    await Promise.resolve()

    expect(actor.getSnapshot().context.issue?.id).toBe(other.id)
    actor.stop()
  })
})
