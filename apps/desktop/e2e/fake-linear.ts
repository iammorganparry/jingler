import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

interface FakeLinearComment {
  readonly id: string
  readonly body: string
  readonly createdAt: string
}

interface FakeLinearIssue {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly url: string
  readonly description: string
  readonly priority: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly comments: FakeLinearComment[]
}

export interface FakeLinearServer {
  readonly url: string
  readonly operations: readonly string[]
  /** Kept separately so failures never print credentials with request metadata. */
  readonly authorizations: readonly string[]
  readonly close: () => Promise<void>
}

const team = { id: "team-1", key: "ENG", name: "Engineering" }
const actor = {
  id: "user-1",
  name: "Morgan",
  displayName: "Morgan",
  avatarUrl: null
}
const state = { id: "state-1", name: "In Progress", type: "started" }
const labels = { nodes: [{ id: "label-1", name: "Bug", color: "#5E6AD2" }] }
const project = { id: "project-1", name: "Payments" }
const cycle = { id: "cycle-1", name: "Cycle 42", number: 42 }
const ISSUE_QUERY = /\bissue\s*\(/
const ISSUES_QUERY = /\bissues\s*\(/
const SEARCH_ISSUES_QUERY = /\bsearchIssues\s*\(/

const seedIssues = (): FakeLinearIssue[] => [
  {
    id: "issue-uuid-123",
    identifier: "ENG-123",
    title: "Retry failed payments",
    url: "https://linear.app/acme/issue/ENG-123/retry-failed-payments",
    description: "Retry a failed payment after refreshing its token.",
    priority: 2,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    comments: [
      {
        id: "comment-1",
        body: "The retry should preserve idempotency.",
        createdAt: "2026-08-08T12:01:00.000Z"
      }
    ]
  },
  {
    id: "issue-uuid-124",
    identifier: "ENG-124",
    title: "Document retry policy",
    url: "https://linear.app/acme/issue/ENG-124/document-retry-policy",
    description: "Document the retry policy.",
    priority: 3,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
    comments: []
  }
]

const issueNode = (issue: FakeLinearIssue) => ({
  ...issue,
  priorityLabel: issue.priority === 1 ? "Urgent" : "High",
  state,
  assignee: actor,
  creator: actor,
  labels,
  team,
  project,
  cycle,
  comments: {
    nodes: issue.comments.map((comment) => ({
      ...comment,
      url: `${issue.url}#comment-${comment.id}`,
      user: actor
    })),
    pageInfo: { hasNextPage: false, endCursor: null }
  }
})

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  })
  response.end(JSON.stringify(body))
}

const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

const variablesOf = (body: Record<string, unknown>): Record<string, unknown> => {
  const variables = body.variables
  return variables !== null && typeof variables === "object" && !Array.isArray(variables)
    ? (variables as Record<string, unknown>)
    : {}
}

interface FakeLinearState {
  readonly issues: FakeLinearIssue[]
  readonly operations: string[]
}

const inputOf = (variables: Record<string, unknown>): Record<string, unknown> =>
  (variables.input as Record<string, unknown> | undefined) ?? {}

const createComment = (
  state: FakeLinearState,
  variables: Record<string, unknown>,
  response: ServerResponse
): void => {
  state.operations.push("commentCreate")
  const input = inputOf(variables)
  const issue = state.issues.find(({ id }) => id === String(input.issueId ?? ""))
  if (!issue) {
    json(response, 200, { errors: [{ message: "Issue not found" }] })
    return
  }
  const comment = {
    id: `comment-${issue.comments.length + 1}`,
    body: String(input.body ?? ""),
    createdAt: "2026-08-09T09:00:00.000Z"
  }
  issue.comments.push(comment)
  json(response, 200, {
    data: {
      commentCreate: {
        success: true,
        comment: { ...comment, user: actor, url: `${issue.url}#comment-${comment.id}` }
      }
    }
  })
}

const createIssue = (
  state: FakeLinearState,
  variables: Record<string, unknown>,
  response: ServerResponse
): void => {
  state.operations.push("issueCreate")
  const input = inputOf(variables)
  const issueNumber = 125 + state.issues.length
  const created: FakeLinearIssue = {
    id: `issue-uuid-${issueNumber}`,
    identifier: `ENG-${issueNumber}`,
    title: String(input.title ?? "Untitled issue"),
    url: `https://linear.app/acme/issue/ENG-${issueNumber}`,
    description: String(input.description ?? ""),
    priority: Number(input.priority ?? 0),
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z",
    comments: []
  }
  state.issues.unshift(created)
  json(response, 200, { data: { issueCreate: { success: true, issue: issueNode(created) } } })
}

const readIssue = (
  state: FakeLinearState,
  variables: Record<string, unknown>,
  response: ServerResponse
): void => {
  state.operations.push("issue")
  const issue = state.issues.find(({ id }) => id === variables.id)
  json(response, 200, { data: { issue: issue ? issueNode(issue) : null } })
}

const listIssues = (
  state: FakeLinearState,
  variables: Record<string, unknown>,
  response: ServerResponse,
  operation = "issues"
): void => {
  state.operations.push(operation)
  const term = String(variables.term ?? "").trim().toLocaleLowerCase()
  const issues = term
    ? state.issues.filter((issue) =>
        issue.identifier.toLocaleLowerCase().includes(term) ||
        issue.title.toLocaleLowerCase().includes(term) ||
        issue.description.toLocaleLowerCase().includes(term)
      )
    : state.issues
  const offset = Number(String(variables.after ?? "page-0").replace("page-", ""))
  const nodes = issues.slice(offset, offset + 1).map(issueNode)
  const hasNextPage = offset + nodes.length < issues.length
  json(response, 200, {
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `page-${offset + nodes.length}` : null }
      }
    }
  })
}

const handleGraphql = (
  state: FakeLinearState,
  query: string,
  variables: Record<string, unknown>,
  response: ServerResponse
): void => {
  if (query.includes("commentCreate")) {
    createComment(state, variables, response)
    return
  }
  if (query.includes("issueCreate")) {
    createIssue(state, variables, response)
    return
  }
  if (ISSUE_QUERY.test(query)) {
    readIssue(state, variables, response)
    return
  }
  if (SEARCH_ISSUES_QUERY.test(query)) {
    listIssues(state, variables, response, "searchIssues")
    return
  }
  if (ISSUES_QUERY.test(query)) {
    listIssues(state, variables, response)
    return
  }
  if (query.includes("viewer") || query.includes("teams")) {
    state.operations.push("context")
    json(response, 200, {
      data: {
        viewer: actor,
        organization: { id: "org-1", name: "Acme", urlKey: "acme" },
        teams: { nodes: [team], pageInfo: { hasNextPage: false, endCursor: null } }
      }
    })
    return
  }
  json(response, 200, { errors: [{ message: "Unknown operation" }] })
}

const handleRequest = async (
  state: FakeLinearState,
  authorizations: string[],
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  if (request.method !== "POST") {
    json(response, 404, { errors: [{ message: "Not found" }] })
    return
  }
  const authorization = request.headers.authorization ?? ""
  authorizations.push(authorization)
  if (!authorization.startsWith("lin_api_")) {
    json(response, 401, { errors: [{ message: "Authentication required" }] })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await bodyOf(request)
  } catch {
    json(response, 400, { errors: [{ message: "Invalid JSON request body" }] })
    return
  }
  handleGraphql(
    state,
    typeof body.query === "string" ? body.query : "",
    variablesOf(body),
    response
  )
}

export const startFakeLinearServer = async (): Promise<FakeLinearServer> => {
  const operations: string[] = []
  const authorizations: string[] = []
  const state = { issues: seedIssues(), operations }
  const server = createServer(async (request, response) => {
    await handleRequest(state, authorizations, request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    operations,
    authorizations,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
