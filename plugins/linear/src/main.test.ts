import type { Disposable, IssueComment, IssueSummary } from "@jingler/plugin-sdk/host"
import { describe, expect, it, vi } from "vitest"
import { activateWithClient, createLinearClient, type LinearClient } from "./main.js"
import type { LinearContext, LinearIssueDetail } from "./types.js"

const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
  id: "issue-1",
  identifier: "ENG-123",
  title: "Retry failed payments",
  description: "Recover invoices after a transient processor error.",
  url: "https://linear.app/acme/issue/ENG-123/retry-failed-payments",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-08T10:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  priority: 2,
  priorityLabel: "High",
  creator: { id: "user-2", name: "Morgan", avatarUrl: null },
  assignee: { id: "user-1", name: "Alex", avatarUrl: "https://example.com/alex.png" },
  state: { id: "state-1", name: "In Progress", type: "started" },
  team: { id: "team-1", name: "Engineering", key: "ENG" },
  project: { id: "project-1", name: "Billing" },
  cycle: { id: "cycle-1", name: "Cycle 42" },
  labels: { nodes: [{ name: "bug", color: "#ff0000" }] },
  ...overrides
})

const repository = { name: "acme/web", path: "/work/acme-web" }

describe("createLinearClient", () => {
  it("searches Linear issues server-side with cursor pagination", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.query).toContain("searchIssues")
      expect(body.variables.term).toBe("ENG-123")
      if (body.variables.after === null) {
        return json({
          issues: {
            nodes: [rawIssue({ id: "issue-older", identifier: "ENG-124" })],
            pageInfo: { hasNextPage: true, endCursor: "next-page" }
          }
        })
      }
      return json({
        issues: {
          nodes: [rawIssue()],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      })
    })
    const client = createLinearClient({
      getSecret: async () => "lin_api_test",
      request
    })

    const issues = await client.listIssues({ repository, search: "ENG-123", mine: false })

    expect(issues).toHaveLength(2)
    expect(issues[1]).toMatchObject({
      providerId: "linear",
      id: "issue-1",
      identifier: "ENG-123",
      title: "Retry failed payments",
      state: "open"
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("filters mine using the authenticated viewer", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes("query LinearContext")) {
        return json({
          viewer: { id: "user-1", name: "Alex", avatarUrl: null },
          organization: { id: "workspace-1", name: "Acme", urlKey: "acme" },
          teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] }
        })
      }
      expect(body.query).not.toContain("searchIssues")
      expect(body.variables.filter).toEqual({ assignee: { id: { eq: "user-1" } } })
      return json({
        issues: {
          nodes: [rawIssue()],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    const issues = await client.listIssues({ repository, search: "", mine: true })

    expect(issues.map(({ id }) => id)).toEqual(["issue-1"])
  })

  it("normalizes a complete Linear issue and paginated comments", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes("query LinearIssue(")) return json({ issue: rawIssue() })
      const firstPage = body.variables.after === null
      return json({
        issue: {
          comments: {
            nodes: [
              {
                id: firstPage ? "comment-1" : "comment-2",
                body: firstPage ? "Investigating" : "Fixed",
                createdAt: firstPage
                  ? "2026-08-08T11:00:00.000Z"
                  : "2026-08-08T12:00:00.000Z",
                url: null,
                user: firstPage ? { id: "user-1", name: "Alex", avatarUrl: null } : null
              }
            ],
            pageInfo: firstPage
              ? { hasNextPage: true, endCursor: "comment-page-2" }
              : { hasNextPage: false, endCursor: null }
          }
        }
      })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    const issue = await client.getIssue({ repository, issueId: "issue-1" })

    expect(issue).toMatchObject({
      identifier: "ENG-123",
      statusName: "In Progress",
      priority: { value: 2, label: "High" },
      team: { id: "team-1", key: "ENG" },
      project: { name: "Billing" },
      cycle: { name: "Cycle 42" }
    })
    expect(issue?.comments.map(({ id }) => id)).toEqual(["comment-1", "comment-2"])
  })

  it("creates a Linear issue with an explicit team and returns the refreshed issue", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes("mutation LinearIssueCreate")) {
        expect(body.variables.input).toEqual({
          teamId: "team-2",
          title: "New issue",
          description: "Issue details"
        })
        return json({ issueCreate: { success: true, issue: { id: "created-1" } } })
      }
      if (body.query.includes("query LinearIssue(")) {
        expect(body.variables.id).toBe("created-1")
        return json({ issue: rawIssue({ id: "created-1", title: "New issue" }) })
      }
      return json({
        issue: {
          comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
        }
      })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    const issue = await client.createIssue({
      repository,
      title: "New issue",
      body: "Issue details",
      teamId: "team-2"
    })

    expect(issue).toMatchObject({ id: "created-1", title: "New issue" })
  })

  it("uses the only accessible team for provider issue creation", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes("query LinearContext")) {
        return json({
          viewer: { id: "user-1", name: "Alex", avatarUrl: null },
          organization: { id: "workspace-1", name: "Acme", urlKey: "acme" },
          teams: { nodes: [{ id: "team-default", name: "Engineering", key: "ENG" }] }
        })
      }
      if (body.query.includes("mutation LinearIssueCreate")) {
        expect(body.variables.input.teamId).toBe("team-default")
        return json({ issueCreate: { success: true, issue: { id: "created-1" } } })
      }
      if (body.query.includes("query LinearIssue(")) {
        return json({ issue: rawIssue({ id: "created-1" }) })
      }
      return json({
        issue: {
          comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
        }
      })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    await client.createIssue({ repository, title: "New issue", body: "" })
  })

  it("requires an explicit team when provider issue creation can access multiple teams", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (!body.query.includes("query LinearContext")) {
        throw new Error("Issue creation must stop before the mutation.")
      }
      return json({
        viewer: { id: "user-1", name: "Alex", avatarUrl: null },
        organization: { id: "workspace-1", name: "Acme", urlKey: "acme" },
        teams: {
          nodes: [
            { id: "team-eng", name: "Engineering", key: "ENG" },
            { id: "team-design", name: "Design", key: "DES" }
          ]
        }
      })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    await expect(
      client.createIssue({ repository, title: "New issue", body: "" })
    ).rejects.toThrow("Choose a team in the Linear Issue tab before creating an issue.")
    expect(request).toHaveBeenCalledOnce()
  })

  it("adds a comment and normalizes the mutation result", async () => {
    const request = vi.fn(async () =>
      json({
        commentCreate: {
          success: true,
          comment: {
            id: "comment-3",
            body: "Shipped",
            createdAt: "2026-08-08T13:00:00.000Z",
            url: "https://linear.app/acme/issue/ENG-123#comment-comment-3",
            user: { id: "user-1", name: "Alex", avatarUrl: null }
          }
        }
      })
    )
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    const created = await client.addComment({ repository, issueId: "issue-1", body: "Shipped" })

    expect(created).toMatchObject({ id: "comment-3", body: "Shipped", author: { name: "Alex" } })
  })

  it("requires the API key before making a request", async () => {
    const request = vi.fn()
    const client = createLinearClient({ getSecret: async () => undefined, request })

    await expect(client.getIssue({ repository, issueId: "issue-1" })).rejects.toThrow(
      "Configure the Linear API key"
    )
    expect(request).not.toHaveBeenCalled()
  })
})

describe("activateWithClient", () => {
  it("registers the Linear provider and every manifest command", async () => {
    const dispose = vi.fn()
    const registration: Disposable = { dispose }
    const registerProvider = vi.fn(() => registration)
    const registeredCommandIds: string[] = []
    const registeredCommands = new Map<string, (input?: unknown) => unknown | Promise<unknown>>()
    const registerCommand = vi.fn(
      (commandId: string, handler: (input?: unknown) => unknown | Promise<unknown>) => {
        registeredCommandIds.push(commandId)
        registeredCommands.set(commandId, handler)
        return registration
      }
    )
    const subscriptions: Disposable[] = []
    const emptyContext: LinearContext = {
      viewer: { id: "user-1", name: "Alex", avatarUrl: null },
      workspace: { id: "workspace-1", name: "Acme", urlKey: "acme" },
      teams: []
    }
    const summary: IssueSummary = {
      providerId: "linear",
      id: "issue-1",
      identifier: "ENG-123",
      title: "Issue",
      url: "https://linear.app/issue/ENG-123",
      labels: [],
      state: "open",
      body: "",
      author: null,
      assignees: [],
      updatedAt: "2026-08-08T10:00:00.000Z"
    }
    const detail: LinearIssueDetail = {
      ...summary,
      createdAt: "2026-08-08T09:00:00.000Z",
      comments: [],
      statusName: "Todo",
      priority: { value: 0, label: "No priority" },
      team: { id: "team-1", name: "Engineering", key: "ENG" },
      project: null,
      cycle: null
    }
    const createdComment: IssueComment = {
      id: "comment-1",
      author: null,
      body: "Done",
      createdAt: "2026-08-08T11:00:00.000Z"
    }
    const client: LinearClient = {
      configured: async () => true,
      context: async () => emptyContext,
      listIssues: async () => [summary],
      getIssue: async () => detail,
      createIssue: async () => detail,
      addComment: async () => createdComment
    }

    activateWithClient(
      {
        subscriptions,
        issues: { registerProvider },
        commands: { register: registerCommand }
      },
      client
    )

    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "linear" }))
    expect(registeredCommandIds).toEqual([
      "linear.configured",
      "linear.context",
      "linear.list",
      "linear.get",
      "linear.create",
      "linear.comment"
    ])
    expect(subscriptions).toHaveLength(7)

    await Promise.all(
      ["linear.list", "linear.get", "linear.create", "linear.comment"].map((commandId) =>
        expect(registeredCommands.get(commandId)?.()).rejects.toThrow(
          "Open the Linear Issue tab to use this command."
        )
      )
    )
  })
})
