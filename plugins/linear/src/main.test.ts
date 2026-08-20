import type { AgentToolDefinition, AgentToolset, Disposable, HostContext, IssueComment, IssueSummary } from "@jingler/plugin-sdk/host"
import { describe, expect, it, vi } from "vitest"
import {
  activateWithClient,
  createLinearAccountManager,
  createLinearClient,
  type LinearClient
} from "./main.js"
import type { LinearContext, LinearIssueDetail } from "./types.js"

const json = <Data>(data: Data) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

interface RawIssueOverrides {
  readonly id?: string
  readonly identifier?: string
  readonly title?: string
}

const rawIssue = (overrides: RawIssueOverrides = {}) => ({
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
          teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
          projects: { nodes: [] }
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

  it("loads issue workflow metadata for efficient writes", async () => {
    const request = vi.fn(async () => json({
      viewer: { id: "user-1", name: "Alex", avatarUrl: null },
      organization: { id: "workspace-1", name: "Acme", urlKey: "acme" },
      teams: { nodes: [{ id: "team-1", name: "Engineering", key: "ENG" }] },
      projects: { nodes: [{ id: "project-1", name: "Billing" }] },
      workflowStates: { nodes: [{ id: "state-1", name: "Todo", type: "unstarted", team: { id: "team-1", name: "Engineering" } }] },
      issueLabels: { nodes: [{ id: "label-1", name: "Bug", color: "#ff0000" }] },
      users: { nodes: [{ id: "user-1", name: "Alex", avatarUrl: null }] }
    }))
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    const context = await client.context()

    expect(context).toMatchObject({
      workflowStates: [{ id: "state-1", type: "unstarted", team: { id: "team-1" } }],
      labels: [{ id: "label-1", color: "#ff0000" }],
      members: [{ id: "user-1" }],
      priorities: [{ value: 0 }, { value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }]
    })
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

  it("maps an issue disappearing before comments load to a not-found error", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return body.query.includes("query LinearIssue(")
        ? json({ issue: rawIssue() })
        : json({ issue: null })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    await expect(client.getIssue({ repository, issueId: "issue-1" })).rejects.toThrow(
      "Linear could not find this issue."
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("loads issues with more than 500 comments", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes("query LinearIssue(")) return json({ issue: rawIssue() })
      const page = body.variables.after === null
        ? 0
        : Number(String(body.variables.after).replace("comment-page-", ""))
      return json({
        issue: {
          comments: {
            nodes: Array.from({ length: 50 }, (_, index) => ({
              id: `comment-${page * 50 + index + 1}`,
              body: `Comment ${page * 50 + index + 1}`,
              createdAt: "2026-08-08T11:00:00.000Z",
              url: null,
              user: null
            })),
            pageInfo: page < 10
              ? { hasNextPage: true, endCursor: `comment-page-${page + 1}` }
              : { hasNextPage: false, endCursor: null }
          }
        }
      })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    const issue = await client.getIssue({ repository, issueId: "issue-1" })

    expect(issue?.comments).toHaveLength(550)
    expect(issue?.comments.at(-1)?.id).toBe("comment-550")
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
          teams: { nodes: [{ id: "team-default", name: "Engineering", key: "ENG" }] },
          projects: { nodes: [] }
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
        },
        projects: { nodes: [] }
      })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    await expect(
      client.createIssue({ repository, title: "New issue", body: "" })
    ).rejects.toThrow("Choose a team in the Linear Issue tab before creating an issue.")
    expect(request).toHaveBeenCalledOnce()
  })

  it("updates supported issue fields and returns the refreshed issue", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes("mutation LinearIssueUpdate")) {
        expect(body.variables).toEqual({
          id: "ENG-123",
          input: {
            title: "Retry payments safely",
            stateId: "state-done",
            priority: 1,
            projectId: null,
            assigneeId: null,
            labelIds: ["label-1"]
          }
        })
        return json({ issueUpdate: { success: true, issue: { id: "issue-1" } } })
      }
      if (body.query.includes("query LinearIssue(")) return json({ issue: rawIssue({ title: "Retry payments safely" }) })
      return json({ issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
    })
    const client = createLinearClient({ getSecret: async () => "lin_api_test", request })

    const issue = await client.updateIssue({
      repository,
      issueId: "ENG-123",
      title: "Retry payments safely",
      stateId: "state-done",
      priority: 1,
      projectId: null,
      assigneeId: null,
      labelIds: ["label-1"]
    })

    expect(issue.title).toBe("Retry payments safely")
    expect(request).toHaveBeenCalledTimes(3)
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

describe("Linear account configuration", () => {
  const setupAccounts = (legacy?: string) => {
    const storage = new Map<string, unknown>()
    const secrets = new Map<string, string>()
    const settings = {
      getSecret: vi.fn(async () => legacy),
      getProfileSecret: vi.fn(async (_collection: string, profileId: string) => secrets.get(profileId)),
      setProfileSecret: vi.fn(async (_collection: string, profileId: string, value: string) => {
        secrets.set(profileId, value)
      }),
      deleteProfileSecret: vi.fn(async (_collection: string, profileId: string) => {
        secrets.delete(profileId)
      })
    }
    const manager = createLinearAccountManager({
      settings,
      storage: {
        // SAFETY: This in-memory test store returns only values written through
        // the same PluginStorage interface in this setup.
        get: async <T,>(key: string) => storage.get(key) as T | undefined,
        set: async (key: string, value: Parameters<HostContext["storage"]["set"]>[1]) => {
          storage.set(key, value)
        },
        delete: async (key: string) => { storage.delete(key) },
        keys: async () => [...storage.keys()]
      }
    })
    return { manager, settings, storage, secrets }
  }

  const contextResponse = (workspace: string) => json({
    viewer: { id: `viewer-${workspace}`, name: "Alex", avatarUrl: null },
    organization: { id: `workspace-${workspace}`, name: workspace, urlKey: workspace.toLowerCase() },
    teams: { nodes: [{ id: `team-${workspace}`, name: "Engineering", key: "ENG" }] },
    projects: { nodes: [{ id: `project-${workspace}`, name: "Roadmap" }] }
  })

  it("adapts the legacy API key as a default profile without re-entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => contextResponse("Legacy")))
    const { manager, settings } = setupAccounts("lin_api_legacy")
    const configuration = await manager.configuration({ repository })

    expect(configuration.profiles).toEqual([
      expect.objectContaining({ id: "legacy-default", name: "Default", legacy: true })
    ])
    expect(configuration.resolved).toEqual({ profileId: "legacy-default" })
    expect(settings.setProfileSecret).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("encrypts named keys and resolves session overrides ahead of repo defaults", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => contextResponse("Work")))
    const { manager, settings, storage } = setupAccounts()
    const route = { repository, sessionId: "session-1" }
    const added = await manager.addProfile({ ...route, name: "Work", apiKey: "lin_api_work" })
    const profile = added.profiles[0]!
    const repo = { profileId: profile.id, teamId: profile.teams[0]!.id }
    await manager.setRepoDefault({ ...route, selection: repo })
    const session = { profileId: profile.id, projectId: profile.projects[0]!.id }
    const configured = await manager.setSessionOverride({ ...route, selection: session })

    expect(settings.setProfileSecret).toHaveBeenCalledWith("linear.accounts", profile.id, "lin_api_work")
    expect(JSON.stringify([...storage.values()])).not.toContain("lin_api_work")
    expect(configured.repoDefault).toEqual(repo)
    expect(configured.sessionOverride).toEqual(session)
    expect(configured.resolved).toEqual(session)
    expect((await manager.resetSessionOverride(route)).resolved).toEqual(repo)
    vi.unstubAllGlobals()
  })
})

describe("activateWithClient", () => {
  it("registers the Linear provider and every manifest command", async () => {
    const dispose = vi.fn()
    const registration: Disposable = { dispose }
    const registerProvider = vi.fn(() => registration)
    const registeredCommandIds: string[] = []
    type CommandHandler = Parameters<HostContext["commands"]["register"]>[1]
    const registeredCommands = new Map<string, CommandHandler>()
    const registerCommand = vi.fn(
      (commandId: string, handler: CommandHandler) => {
        registeredCommandIds.push(commandId)
        registeredCommands.set(commandId, handler)
        return registration
      }
    )
    const subscriptions: Disposable[] = []
    const registerToolset = vi.fn(() => registration)
    const emptyContext: LinearContext = {
      viewer: { id: "user-1", name: "Alex", avatarUrl: null },
      workspace: { id: "workspace-1", name: "Acme", urlKey: "acme" },
      teams: [],
      projects: [],
      workflowStates: [],
      labels: [],
      members: [],
      priorities: []
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
      profileId: async () => "profile-1",
      context: async () => emptyContext,
      listIssues: async () => [summary],
      getIssue: async () => detail,
      createIssue: async () => detail,
      updateIssue: async () => detail,
      addComment: async () => createdComment
    }

    activateWithClient(
      {
        subscriptions,
        issues: { registerProvider },
        agentTools: { registerToolset },
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
    expect(registerToolset).toHaveBeenCalledWith(expect.objectContaining({ id: "linear.issues" }))
    expect(subscriptions).toHaveLength(8)

    await Promise.all(
      ["linear.list", "linear.get", "linear.create", "linear.comment"].map((commandId) =>
        expect(registeredCommands.get(commandId)?.()).rejects.toThrow(
          "Open the Linear Issue tab to use this command."
        )
      )
    )
  })

  it("registers tools that use trusted session repository context and return link envelopes", async () => {
    let toolset: AgentToolset | undefined
    const getIssue = vi.fn(async () => ({
      providerId: "linear", id: "issue-1", identifier: "ENG-1", title: "Trusted route",
      url: "https://linear.app/acme/issue/ENG-1", labels: [], state: "open" as const,
      body: "", author: null, assignees: [], updatedAt: "2026-08-08T10:00:00.000Z",
      createdAt: "2026-08-08T09:00:00.000Z", comments: [], statusName: "Todo",
      priority: { value: 0, label: "No priority" }, team: { id: "team-1", name: "Engineering", key: "ENG" },
      project: null, cycle: null
    }))
    const client = {
      configured: async () => true,
      profileId: async () => "profile-1",
      context: async () => ({ viewer: { id: "u", name: "U", avatarUrl: null }, workspace: { id: "w", name: "W", urlKey: "w" }, teams: [], projects: [], workflowStates: [], labels: [], members: [], priorities: [] }),
      listIssues: async () => [await getIssue()],
      getIssue,
      createIssue: async () => getIssue(),
      updateIssue: async () => getIssue(),
      addComment: async () => ({ id: "c", author: null, body: "", createdAt: "" })
    } satisfies LinearClient
    const registration = { dispose: () => undefined }
    activateWithClient({
      subscriptions: [],
      issues: { registerProvider: () => registration },
      commands: { register: () => registration },
      agentTools: { registerToolset: (value) => { toolset = value; return registration } }
    }, client)

    const context = {
      signal: new AbortController().signal,
      session: { id: "session-1", repository }
    }
    const execute = (toolId: string, input: Parameters<AgentToolDefinition["execute"]>[0]) =>
      toolset?.tools.find(({ id }) => id === toolId)?.execute(input, context)

    const search = await execute("linear_search_issues", { query: "ENG" })
    const fetched = await execute("linear_get_issue", {
      issueId: "ENG-1",
      repository: { name: "spoofed", path: "/evil" }
    })
    const created = await execute("linear_create_issue", { title: "Create it" })
    const updated = await execute("linear_update_issue", { issueId: "ENG-1", title: "Update it" })
    const commented = await execute("linear_add_comment", { issueId: "ENG-1", body: "Done" })

    expect(getIssue).toHaveBeenCalledWith({ sessionId: "session-1", repository, issueId: "ENG-1" })
    expect(search).toMatchObject({ kind: "linear.issue-result", linkIntent: "none", issues: [] })
    expect(fetched).toMatchObject({
      kind: "linear.issue-result", linkIntent: "user-reference", issues: [{ id: "issue-1" }]
    })
    for (const result of [created, updated, commented]) {
      expect(result).toMatchObject({
        kind: "linear.issue-result", linkIntent: "mutation", issues: [{ id: "issue-1" }]
      })
    }
  })
})
