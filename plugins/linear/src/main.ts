import type {
  Activate,
  HostContext,
  IssueActor,
  IssueComment,
  IssueLabel,
  IssueProvider,
  IssueSummary
} from "@jingler/plugin-sdk/host"
import {
  linearApiUrl,
  linearGraphql,
  type LinearRequest
} from "./graphql.js"
import {
  COMMENTS_QUERY,
  CONTEXT_QUERY,
  CREATE_COMMENT_MUTATION,
  CREATE_ISSUE_MUTATION,
  ISSUES_QUERY,
  ISSUE_QUERY,
  SEARCH_ISSUES_QUERY,
  type LinearActorNode,
  type LinearCommentCreateData,
  type LinearCommentNode,
  type LinearCommentsData,
  type LinearContextData,
  type LinearDisplayNode,
  type LinearIssueCreateData,
  type LinearIssueData,
  type LinearIssueNode,
  type LinearIssuesData,
  type LinearPageInfo,
  type LinearTeamNode
} from "./operations.js"
import type {
  LinearCommentRequest,
  LinearContext,
  LinearCreateRequest,
  LinearDisplayItem,
  LinearGetRequest,
  LinearIssueDetail,
  LinearListRequest,
  LinearTeam,
  LinearViewer,
  LinearWorkspace
} from "./types.js"

export type {
  LinearCommentRequest,
  LinearContext,
  LinearCreateRequest,
  LinearGetRequest,
  LinearIssueDetail,
  LinearListRequest
} from "./types.js"

const API_KEY_SETTING = "linear.api-key"
const PAGE_SIZE = 50
const MAX_ISSUE_PAGES = 5
const MAX_COMMENT_PAGES = 10

const configuredApiKey = async (getSecret: (id: string) => Promise<string | undefined>) => {
  const apiKey = await getSecret(API_KEY_SETTING)
  if (!apiKey) {
    throw new Error("Configure the Linear API key in Settings → Plugins → Linear.")
  }
  return apiKey
}

const actor = (input: LinearActorNode): IssueActor => ({
  id: input.id,
  name: input.name,
  avatarUrl: input.avatarUrl
})

const optionalActor = (input: LinearActorNode | null): IssueActor | null =>
  input ? actor(input) : null

const displayItem = (input: LinearDisplayNode): LinearDisplayItem => ({
  id: input.id,
  name: input.name
})

const optionalDisplayItem = (input: LinearDisplayNode | null): LinearDisplayItem | null =>
  input ? displayItem(input) : null

const team = (input: LinearTeamNode): LinearTeam => ({
  ...displayItem(input),
  key: input.key
})

const labels = (input: LinearIssueNode["labels"]): readonly IssueLabel[] =>
  input.nodes.map(({ name, color }) => ({ name, color }))

const closedState = (issue: LinearIssueNode): boolean =>
  Boolean(issue.completedAt || issue.canceledAt) ||
  issue.state.type === "completed" ||
  issue.state.type === "canceled"

const issueDetailFields = (issue: LinearIssueNode): Omit<LinearIssueDetail, "comments"> => {
  const assignee = optionalActor(issue.assignee)
  return {
    providerId: "linear",
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    labels: labels(issue.labels),
    state: closedState(issue) ? "closed" : "open",
    body: issue.description ?? "",
    author: optionalActor(issue.creator),
    assignees: assignee ? [assignee] : [],
    updatedAt: issue.updatedAt,
    createdAt: issue.createdAt,
    statusName: issue.state.name,
    priority: {
      value: issue.priority,
      label: issue.priorityLabel
    },
    team: team(issue.team),
    project: optionalDisplayItem(issue.project),
    cycle: optionalDisplayItem(issue.cycle)
  }
}

const summary = (issue: LinearIssueNode): IssueSummary => {
  const detail = issueDetailFields(issue)
  return {
    providerId: detail.providerId,
    id: detail.id,
    identifier: detail.identifier,
    title: detail.title,
    url: detail.url,
    labels: detail.labels,
    state: detail.state,
    body: detail.body,
    author: detail.author,
    assignees: detail.assignees,
    updatedAt: detail.updatedAt
  }
}

const comment = (input: LinearCommentNode): IssueComment => {
  return {
    id: input.id,
    author: optionalActor(input.user),
    body: input.body,
    createdAt: input.createdAt,
    ...(input.url ? { url: input.url } : {})
  }
}

const pageInfo = (input: LinearPageInfo): LinearPageInfo => {
  if (input.hasNextPage && !input.endCursor) {
    throw new Error("Linear returned invalid pagination information.")
  }
  return input
}

export interface LinearClientOptions {
  readonly getSecret: (id: string) => Promise<string | undefined>
  readonly request?: LinearRequest
  readonly endpoint?: string
}

export interface LinearClient {
  configured(): Promise<boolean>
  context(): Promise<LinearContext>
  listIssues(input: LinearListRequest): Promise<readonly IssueSummary[]>
  getIssue(input: LinearGetRequest): Promise<LinearIssueDetail | null>
  createIssue(input: LinearCreateRequest): Promise<LinearIssueDetail>
  addComment(input: LinearCommentRequest): Promise<IssueComment>
}

type Execute = <Data extends object>(
  query: string,
  variables?: Readonly<Record<string, unknown>>
) => Promise<Data>

const loadContext = async (execute: Execute): Promise<LinearContext> => {
  const data = await execute<LinearContextData>(CONTEXT_QUERY)
  const viewer: LinearViewer = {
    ...displayItem(data.viewer),
    avatarUrl: data.viewer.avatarUrl
  }
  const workspace: LinearWorkspace = {
    ...displayItem(data.organization),
    urlKey: data.organization.urlKey
  }
  return { viewer, workspace, teams: data.teams.nodes.map(team) }
}

interface CommentPageState {
  readonly after: string | null
  readonly page: number
  readonly accumulated: readonly IssueComment[]
}

const loadCommentsPage = async (
  execute: Execute,
  issueId: string,
  state: CommentPageState
): Promise<readonly IssueComment[]> => {
  if (state.page >= MAX_COMMENT_PAGES) {
    throw new Error("Linear returned too many comment pages for this issue.")
  }
  const data = await execute<LinearCommentsData>(COMMENTS_QUERY, {
    id: issueId,
    first: PAGE_SIZE,
    after: state.after
  })
  const connection = data.issue.comments
  const comments = [
    ...state.accumulated,
    ...connection.nodes.map(comment)
  ]
  const info = pageInfo(connection.pageInfo)
  return info.hasNextPage
    ? loadCommentsPage(execute, issueId, {
        after: info.endCursor,
        page: state.page + 1,
        accumulated: comments
      })
    : comments
}

const loadIssue = async (
  execute: Execute,
  input: LinearGetRequest
): Promise<LinearIssueDetail | null> => {
  const data = await execute<LinearIssueData>(ISSUE_QUERY, { id: input.issueId })
  if (!data.issue) return null
  const fields = issueDetailFields(data.issue)
  return {
    ...fields,
    comments: await loadCommentsPage(execute, fields.id, {
      after: null,
      page: 0,
      accumulated: []
    })
  }
}

interface LinearIssueFilter {
  readonly assignee?: {
    readonly id: { readonly eq: string }
  }
}

const issueFilter = (viewerId: string | null): LinearIssueFilter | undefined =>
  viewerId ? { assignee: { id: { eq: viewerId } } } : undefined

interface IssuePageState {
  readonly term: string | null
  readonly filter?: LinearIssueFilter
  readonly after: string | null
  readonly page: number
  readonly accumulated: readonly IssueSummary[]
}

const loadIssuesPage = async (
  execute: Execute,
  state: IssuePageState
): Promise<readonly IssueSummary[]> => {
  if (state.page >= MAX_ISSUE_PAGES) return state.accumulated
  const data = await execute<LinearIssuesData>(state.term ? SEARCH_ISSUES_QUERY : ISSUES_QUERY, {
    first: PAGE_SIZE,
    after: state.after,
    ...(state.term ? { term: state.term } : {}),
    ...(state.filter ? { filter: state.filter } : {})
  })
  const connection = data.issues
  const result = [...state.accumulated, ...connection.nodes.map(summary)]
  const info = pageInfo(connection.pageInfo)
  return info.hasNextPage
    ? loadIssuesPage(execute, {
        ...state,
        after: info.endCursor,
        page: state.page + 1,
        accumulated: result
      })
    : result
}

const onlyTeamId = async (context: () => Promise<LinearContext>): Promise<string> => {
  const teams = (await context()).teams
  if (teams.length === 0) {
    throw new Error("Linear has no accessible team in which to create an issue.")
  }
  if (teams.length > 1) {
    throw new Error("Choose a team in the Linear Issue tab before creating an issue.")
  }
  return teams[0]!.id
}

const createIssue = async (
  execute: Execute,
  context: () => Promise<LinearContext>,
  input: LinearCreateRequest
): Promise<LinearIssueDetail> => {
  const teamId = input.teamId ?? await onlyTeamId(context)
  const data = await execute<LinearIssueCreateData>(CREATE_ISSUE_MUTATION, {
    input: { teamId, title: input.title, description: input.body }
  })
  if (!data.issueCreate.success) {
    throw new Error("Linear did not create the issue. Check the details and retry.")
  }
  const issue = await loadIssue(execute, {
    ...input,
    issueId: data.issueCreate.issue.id
  })
  if (!issue) throw new Error("Linear created the issue but could not load it.")
  return issue
}

const addComment = async (execute: Execute, input: LinearCommentRequest): Promise<IssueComment> => {
  const data = await execute<LinearCommentCreateData>(CREATE_COMMENT_MUTATION, {
    input: { issueId: input.issueId, body: input.body }
  })
  if (!data.commentCreate.success) {
    throw new Error("Linear did not add the comment. Check it and retry.")
  }
  return comment(data.commentCreate.comment)
}

export const createLinearClient = (options: LinearClientOptions): LinearClient => {
  const execute: Execute = async <Data extends object>(query: string, variables = {}) =>
    linearGraphql<Data>({
      apiKey: await configuredApiKey(options.getSecret),
      query,
      variables,
      ...(options.request ? { request: options.request } : {}),
      endpoint: options.endpoint ?? linearApiUrl()
    })
  const context = () => loadContext(execute)

  return {
    configured: async () => Boolean(await options.getSecret(API_KEY_SETTING)),
    context,
    listIssues: async (input) => {
      const viewerId = input.mine ? (await context()).viewer.id : null
      return loadIssuesPage(execute, {
        term: input.search.trim() || null,
        filter: issueFilter(viewerId),
        after: null,
        page: 0,
        accumulated: []
      })
    },
    getIssue: (input) => loadIssue(execute, input),
    createIssue: (input) => createIssue(execute, context, input),
    addComment: (input) => addComment(execute, input)
  }
}

const command = <Input, Output>(handler: (input: Input) => Output | Promise<Output>) =>
  (input?: unknown) => handler(input as Input)

type LinearHostContext = Pick<HostContext, "issues" | "commands" | "subscriptions">

export const activateWithClient = (ctx: LinearHostContext, client: LinearClient): void => {
  const provider: IssueProvider = {
    id: "linear",
    listIssues: client.listIssues,
    getIssue: client.getIssue,
    createIssue: client.createIssue,
    addComment: client.addComment
  }
  ctx.subscriptions.push(
    ctx.issues.registerProvider(provider),
    ctx.commands.register("linear.configured", () => client.configured()),
    ctx.commands.register("linear.context", () => client.context()),
    ctx.commands.register("linear.list", command(client.listIssues)),
    ctx.commands.register("linear.get", command(client.getIssue)),
    ctx.commands.register("linear.create", command(client.createIssue)),
    ctx.commands.register("linear.comment", command(client.addComment))
  )
}

export const activate: Activate = (ctx) => {
  activateWithClient(
    ctx,
    createLinearClient({
      getSecret: (id) => ctx.settings.getSecret(id)
    })
  )
}
