import type {
  Activate,
  HostContext,
  AgentToolDefinition,
  AgentToolExecutionContext,
  IssueActor,
  IssueComment,
  IssueLabel,
  IssueProvider,
  IssueReference,
  IssueSummary
} from "@jingler/plugin-sdk/host"
import {
  linearApiUrl,
  linearGraphql,
  type LinearGraphqlOptions,
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
  UPDATE_ISSUE_MUTATION,
  TEAMS_PAGE_QUERY,
  PROJECTS_PAGE_QUERY,
  WORKFLOW_STATES_PAGE_QUERY,
  LABELS_PAGE_QUERY,
  USERS_PAGE_QUERY,
  type LinearActorNode,
  type LinearCommentCreateData,
  type LinearCommentNode,
  type LinearCommentsData,
  type LinearContextData,
  type LinearDisplayNode,
  type LinearIssueCreateData,
  type LinearIssueData,
  type LinearIssueNode,
  type LinearIssueUpdateData,
  type LinearIssuesData,
  type LinearPageInfo,
  type LinearConnection,
  type LinearMetadataPageData,
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
  LinearConfiguration,
  LinearProfile,
  LinearSelection,
  LinearToolEnvelope,
  LinearToolLinkIntent,
  LinearUpdateRequest,
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
const MAX_COMMENT_PAGES = 100

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
  const base: IssueComment = {
    id: input.id,
    author: optionalActor(input.user),
    body: input.body,
    createdAt: input.createdAt
  }
  return input.url ? { ...base, url: input.url } : base
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

export interface LinearRoute {
  readonly sessionId?: string
  readonly repository?: { readonly name: string; readonly path: string }
  /** Explicit link-bound account; overrides mutable session/repository mappings. */
  readonly profileId?: string
}

export interface LinearClient {
  configured(route?: LinearRoute): Promise<boolean>
  /** Resolved named account for durable issue-link routing, when account-managed. */
  profileId(route?: LinearRoute): Promise<string | undefined>
  context(route?: LinearRoute): Promise<LinearContext>
  listIssues(input: LinearListRequest): Promise<readonly IssueSummary[]>
  getIssue(input: LinearGetRequest): Promise<LinearIssueDetail | null>
  createIssue(input: LinearCreateRequest): Promise<LinearIssueDetail>
  updateIssue(input: LinearUpdateRequest): Promise<LinearIssueDetail>
  addComment(input: LinearCommentRequest): Promise<IssueComment>
}

type Execute = <Data extends object>(
  query: string,
  variables?: LinearGraphqlOptions["variables"]
) => Promise<Data>

const LINEAR_PRIORITIES = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" }
] as const

const loadMetadataConnection = async <Node>(
  execute: Execute,
  query: string,
  initial: LinearConnection<Node>,
  page = 0
): Promise<readonly Node[]> => {
  if (page >= 100) throw new Error("Linear returned too many metadata pages.")
  const info = initial.pageInfo
  if (!info?.hasNextPage) return initial.nodes
  if (!info.endCursor) throw new Error("Linear returned invalid metadata pagination information.")
  const next = await execute<LinearMetadataPageData<Node>>(query, { after: info.endCursor })
  return [
    ...initial.nodes,
    ...await loadMetadataConnection(execute, query, next.items, page + 1)
  ]
}

const loadContext = async (execute: Execute): Promise<LinearContext> => {
  const data = await execute<LinearContextData>(CONTEXT_QUERY)
  const [teams, projects, workflowStates, issueLabels, users] = await Promise.all([
    loadMetadataConnection(execute, TEAMS_PAGE_QUERY, data.teams),
    loadMetadataConnection(execute, PROJECTS_PAGE_QUERY, data.projects),
    loadMetadataConnection(execute, WORKFLOW_STATES_PAGE_QUERY, data.workflowStates ?? { nodes: [] }),
    loadMetadataConnection(execute, LABELS_PAGE_QUERY, data.issueLabels ?? { nodes: [] }),
    loadMetadataConnection(execute, USERS_PAGE_QUERY, data.users ?? { nodes: [] })
  ])
  const viewer: LinearViewer = {
    ...displayItem(data.viewer),
    avatarUrl: data.viewer.avatarUrl
  }
  const workspace: LinearWorkspace = {
    ...displayItem(data.organization),
    urlKey: data.organization.urlKey
  }
  return {
    viewer,
    workspace,
    teams: teams.map(team),
    projects: projects.map(displayItem),
    workflowStates: workflowStates.map((state) => ({
      ...displayItem(state),
      type: state.type,
      team: optionalDisplayItem(state.team)
    })),
    labels: issueLabels.map((label) => ({
      ...displayItem(label),
      color: label.color
    })),
    members: users.map((member) => ({
      ...displayItem(member),
      avatarUrl: member.avatarUrl
    })),
    priorities: LINEAR_PRIORITIES
  }
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
  if (!data.issue) {
    throw new Error("Linear could not find this issue.")
  }
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
  const variables = { first: PAGE_SIZE, after: state.after }
  if (state.term) Object.assign(variables, { term: state.term })
  if (state.filter) Object.assign(variables, { filter: state.filter })
  const data = await execute<LinearIssuesData>(
    state.term ? SEARCH_ISSUES_QUERY : ISSUES_QUERY,
    variables
  )
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
  const mutationInput = {
    teamId,
    title: input.title,
    description: input.body
  }
  if (input.projectId) Object.assign(mutationInput, { projectId: input.projectId })
  if (input.stateId) Object.assign(mutationInput, { stateId: input.stateId })
  if (input.priority !== undefined) Object.assign(mutationInput, { priority: input.priority })
  if (input.assigneeId) Object.assign(mutationInput, { assigneeId: input.assigneeId })
  if (input.labelIds) Object.assign(mutationInput, { labelIds: [...input.labelIds] })
  const data = await execute<LinearIssueCreateData>(CREATE_ISSUE_MUTATION, {
    input: mutationInput
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

const updateIssue = async (
  execute: Execute,
  input: LinearUpdateRequest
): Promise<LinearIssueDetail> => {
  const mutationInput: LinearGraphqlOptions["variables"] = {}
  if (input.title !== undefined) Object.assign(mutationInput, { title: input.title })
  if (input.body !== undefined) Object.assign(mutationInput, { description: input.body })
  if (input.teamId !== undefined) Object.assign(mutationInput, { teamId: input.teamId })
  if (input.projectId !== undefined) Object.assign(mutationInput, { projectId: input.projectId })
  if (input.stateId !== undefined) Object.assign(mutationInput, { stateId: input.stateId })
  if (input.priority !== undefined) Object.assign(mutationInput, { priority: input.priority })
  if (input.assigneeId !== undefined) Object.assign(mutationInput, { assigneeId: input.assigneeId })
  if (input.labelIds !== undefined) Object.assign(mutationInput, { labelIds: [...input.labelIds] })
  if (Object.keys(mutationInput).length === 0) {
    throw new Error("Choose at least one Linear issue field to update.")
  }
  const data = await execute<LinearIssueUpdateData>(UPDATE_ISSUE_MUTATION, {
    id: input.issueId,
    input: mutationInput
  })
  if (!data.issueUpdate.success) throw new Error("Linear did not update the issue.")
  // A team transfer may change the human identifier; the mutation's stable UUID
  // is the only reliable key for the authoritative reload.
  const issue = await loadIssue(execute, {
    ...input,
    issueId: data.issueUpdate.issue.id
  })
  if (!issue) throw new Error("Linear updated the issue but could not load it.")
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
  const execute: Execute = async <Data extends object>(query: string, variables = {}) => {
    const requestOptions: LinearGraphqlOptions = {
      apiKey: await configuredApiKey(options.getSecret),
      query,
      variables,
      endpoint: options.endpoint ?? linearApiUrl()
    }
    return linearGraphql<Data>(
      options.request ? { ...requestOptions, request: options.request } : requestOptions
    )
  }
  const context = () => loadContext(execute)

  return {
    configured: async () => Boolean(await options.getSecret(API_KEY_SETTING)),
    profileId: async () => undefined,
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
    updateIssue: (input) => updateIssue(execute, input),
    addComment: (input) => addComment(execute, input)
  }
}

const PROFILE_COLLECTION = "linear.accounts"
const PROFILES_KEY = "profiles"
const REPO_DEFAULTS_KEY = "repo-defaults"
const SESSION_OVERRIDES_KEY = "session-overrides"
const LEGACY_PROFILE_ID = "legacy-default"

type LinearConfigurationHost = Pick<HostContext, "settings" | "storage">

type PersistedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly PersistedValue[]
  | PersistedRecord

interface PersistedRecord {
  readonly [key: string]: PersistedValue
}

const isString = (value: PersistedValue): value is string =>
  Object.prototype.toString.call(value) === "[object String]" && Object(value) !== value

const record = (value: PersistedValue): PersistedRecord | null => {
  if (value === null || value === undefined || Array.isArray(value)) return null
  if (Object.prototype.toString.call(value) !== "[object Object]") return null
  // SAFETY: The object-tag and array checks above establish a plain persisted
  // key/value object; every value remains in the recursive persisted-value domain.
  return value as PersistedRecord
}

const selectionOf = (value: PersistedValue): LinearSelection | null => {
  const candidate = record(value)
  if (!isString(candidate?.profileId)) return null
  let selection: LinearSelection = { profileId: candidate.profileId }
  if (isString(candidate.teamId)) selection = { ...selection, teamId: candidate.teamId }
  if (isString(candidate.projectId)) {
    selection = { ...selection, projectId: candidate.projectId }
  }
  return selection
}

const profileOf = (value: PersistedValue): LinearProfile | null => {
  const candidate = record(value)
  const viewer = record(candidate?.viewer)
  const workspace = record(candidate?.workspace)
  if (
    !isString(candidate?.id) || !isString(candidate.name) ||
    !isString(viewer?.id) || !isString(viewer.name) ||
    !isString(workspace?.id) || !isString(workspace.name) ||
    !isString(workspace.urlKey) || !Array.isArray(candidate.teams) ||
    !Array.isArray(candidate.projects)
  ) return null
  // SAFETY: Stored profiles were originally produced from LinearContext. The
  // required profile, viewer, workspace and collection fields are revalidated
  // above before the persisted value re-enters the account manager.
  // The storage API intentionally erases its generic value; the checks above
  // reconstruct the profile contract before this one unavoidable bridge.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  return candidate as unknown as LinearProfile
}

const profileFromContext = (
  id: string,
  name: string,
  context: LinearContext,
  legacy = false
): LinearProfile => {
  const profile: LinearProfile = { id, name, ...context }
  return legacy ? { ...profile, legacy: true } : profile
}

const mapOf = (value: PersistedValue): Record<string, LinearSelection> => {
  const source = record(value)
  if (!source) return {}
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, candidate]) => {
      const selection = selectionOf(candidate)
      return selection ? [[key, selection]] : []
    })
  )
}

export interface LinearAccountManager {
  configuration(route: LinearRoute): Promise<LinearConfiguration>
  addProfile(input: LinearRoute & { readonly name: string; readonly apiKey: string }): Promise<LinearConfiguration>
  removeProfile(input: LinearRoute & { readonly profileId: string }): Promise<LinearConfiguration>
  setRepoDefault(input: LinearRoute & { readonly selection: LinearSelection }): Promise<LinearConfiguration>
  setSessionOverride(input: LinearRoute & { readonly selection: LinearSelection }): Promise<LinearConfiguration>
  resetSessionOverride(input: LinearRoute): Promise<LinearConfiguration>
  clientFor(route: LinearRoute): Promise<{ readonly client: LinearClient; readonly selection: LinearSelection }>
}

export const createLinearAccountManager = (ctx: LinearConfigurationHost): LinearAccountManager => {
  const profiles = async (): Promise<readonly LinearProfile[]> =>
    ((await ctx.storage.get<readonly PersistedValue[]>(PROFILES_KEY)) ?? []).flatMap((value) => {
      const profile = profileOf(value)
      return profile ? [profile] : []
    })

  const saveProfiles = (value: readonly LinearProfile[]) => ctx.storage.set(PROFILES_KEY, value)

  const secret = async (profileId: string): Promise<string | undefined> =>
    profileId === LEGACY_PROFILE_ID
      ? ctx.settings.getSecret(API_KEY_SETTING)
      : ctx.settings.getProfileSecret(PROFILE_COLLECTION, profileId)

  const ensureLegacy = async (): Promise<readonly LinearProfile[]> => {
    const current = await profiles()
    if (current.some(({ id }) => id === LEGACY_PROFILE_ID)) return current
    const apiKey = await ctx.settings.getSecret(API_KEY_SETTING)
    if (!apiKey) return current
    const client = createLinearClient({ getSecret: async () => apiKey })
    const context = await client.context()
    const next = [profileFromContext(LEGACY_PROFILE_ID, "Default", context, true), ...current]
    await saveProfiles(next)
    return next
  }

  const configuration = async (route: LinearRoute): Promise<LinearConfiguration> => {
    const available = await ensureLegacy()
    const repoDefaults = mapOf(await ctx.storage.get(REPO_DEFAULTS_KEY))
    const sessionOverrides = mapOf(await ctx.storage.get(SESSION_OVERRIDES_KEY))
    const repoDefault = route.repository ? repoDefaults[route.repository.name] ?? null : null
    const sessionOverride = route.sessionId ? sessionOverrides[route.sessionId] ?? null : null
    const explicit = route.profileId && available.some(({ id }) => id === route.profileId)
      ? { profileId: route.profileId }
      : null
    const resolved = explicit ?? sessionOverride ?? repoDefault ?? (available[0] ? { profileId: available[0].id } : null)
    return { profiles: available, repoDefault, sessionOverride, resolved }
  }

  const validatedSelection = async (candidate: LinearSelection): Promise<LinearSelection> => {
    const available = await ensureLegacy()
    const profile = available.find(({ id }) => id === candidate.profileId)
    if (!profile) throw new Error("Choose an available Linear account.")
    if (candidate.teamId && !profile.teams.some(({ id }) => id === candidate.teamId)) {
      throw new Error("Choose a team from the selected Linear workspace.")
    }
    if (candidate.projectId && !profile.projects.some(({ id }) => id === candidate.projectId)) {
      throw new Error("Choose a project from the selected Linear workspace.")
    }
    return candidate
  }

  const setMapping = async (
    key: typeof REPO_DEFAULTS_KEY | typeof SESSION_OVERRIDES_KEY,
    identity: string,
    selection: LinearSelection | null
  ): Promise<void> => {
    const mappings = mapOf(await ctx.storage.get(key))
    if (selection) mappings[identity] = await validatedSelection(selection)
    else delete mappings[identity]
    await ctx.storage.set(key, mappings)
  }

  const manager: LinearAccountManager = {
    configuration,
    addProfile: async (input) => {
      const name = input.name.trim()
      const apiKey = input.apiKey.trim()
      if (!name) throw new Error("Name this Linear account.")
      if (!apiKey.startsWith("lin_api_")) throw new Error("Linear personal API keys start with lin_api_.")
      const id = `account_${globalThis.crypto.randomUUID().replaceAll("-", "")}`
      const client = createLinearClient({ getSecret: async () => apiKey })
      const context = await client.context()
      await ctx.settings.setProfileSecret(PROFILE_COLLECTION, id, apiKey)
      try {
        await saveProfiles([...(await ensureLegacy()), profileFromContext(id, name, context)])
      } catch (cause) {
        await ctx.settings.deleteProfileSecret(PROFILE_COLLECTION, id).catch(() => undefined)
        throw cause
      }
      return configuration(input)
    },
    removeProfile: async (input) => {
      if (input.profileId === LEGACY_PROFILE_ID) {
        throw new Error("Remove the legacy default API key from Plugin Settings.")
      }
      await ctx.settings.deleteProfileSecret(PROFILE_COLLECTION, input.profileId)
      await saveProfiles((await profiles()).filter(({ id }) => id !== input.profileId))
      for (const key of [REPO_DEFAULTS_KEY, SESSION_OVERRIDES_KEY] as const) {
        const mappings = mapOf(await ctx.storage.get(key))
        const filtered = Object.fromEntries(
          Object.entries(mappings).filter(([, value]) => value.profileId !== input.profileId)
        )
        await ctx.storage.set(key, filtered)
      }
      return configuration(input)
    },
    setRepoDefault: async (input) => {
      if (!input.repository) throw new Error("A repository is required.")
      await setMapping(REPO_DEFAULTS_KEY, input.repository.name, input.selection)
      return configuration(input)
    },
    setSessionOverride: async (input) => {
      if (!input.sessionId) throw new Error("A session is required.")
      await setMapping(SESSION_OVERRIDES_KEY, input.sessionId, input.selection)
      return configuration(input)
    },
    resetSessionOverride: async (input) => {
      if (input.sessionId) await setMapping(SESSION_OVERRIDES_KEY, input.sessionId, null)
      return configuration(input)
    },
    clientFor: async (route) => {
      const config = await configuration(route)
      if (!config.resolved) throw new Error("Connect a Linear account for this repository.")
      const apiKey = await secret(config.resolved.profileId)
      if (!apiKey) throw new Error("The selected Linear account needs to be reconnected.")
      return {
        selection: config.resolved,
        client: createLinearClient({ getSecret: async () => apiKey })
      }
    }
  }
  return manager
}

type HostCommandInput = Parameters<Parameters<HostContext["commands"]["register"]>[1]>[0]

const issueTabCommand = <Input, Output>(handler: (input: Input) => Output | Promise<Output>) =>
  async (input?: HostCommandInput): Promise<Output> => {
    if (input === undefined) {
      throw new Error("Open the Linear Issue tab to use this command.")
    }
    // SAFETY: Each registered command pairs this adapter with its concrete
    // handler, and renderer invocations originate from that command's form.
    return handler(input as Input)
  }

type LinearHostContext = Pick<HostContext, "issues" | "commands" | "agentTools" | "subscriptions">

interface LinearAgentToolInput {
  readonly query?: string
  readonly mine?: boolean
  readonly limit?: number
  readonly issueId?: string
  readonly title?: string
  readonly description?: string
  readonly teamId?: string
  readonly projectId?: string | null
  readonly stateId?: string
  readonly priority?: number
  readonly assigneeId?: string | null
  readonly labelIds?: readonly string[]
  readonly body?: string
}

type AgentToolInput = Parameters<AgentToolDefinition["execute"]>[0]

const toolInput = (input: AgentToolInput): LinearAgentToolInput => {
  if (input === null || Array.isArray(input) ||
      Object.prototype.toString.call(input) !== "[object Object]") {
    throw new Error("Linear tool input must be an object.")
  }
  // SAFETY: The host validates every tool call against the adjacent JSON schema
  // before execute runs; this check also rejects non-object direct callers.
  return input as LinearAgentToolInput
}

const stringInput = (
  input: LinearAgentToolInput,
  key: keyof LinearAgentToolInput,
  required = false
): string | undefined => {
  const value = input[key]
  if (value === undefined && !required) return
  if (!isString(value) || (required && !value.trim())) {
    throw new Error(`Linear tool field "${key}" must be a${required ? " non-empty" : ""} string.`)
  }
  return value
}

const reference = (
  issue: IssueReference,
  providerAccountId: string | undefined
): IssueReference => {
  const base: IssueReference = {
    providerId: issue.providerId,
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    labels: issue.labels
  }
  return providerAccountId === undefined
    ? base
    : { ...base, providerAccountId }
}

const envelope = <T>(
  linkIntent: LinearToolLinkIntent,
  issues: readonly IssueReference[],
  result: T,
  providerAccountId?: string
): LinearToolEnvelope<T> => ({
  kind: "linear.issue-result",
  linkIntent,
  issues: issues.map((issue) => reference(issue, providerAccountId)),
  result
})

const boundedIssue = (issue: LinearIssueDetail) => ({
  ...issue,
  body: issue.body.slice(0, 8_000),
  comments: issue.comments.slice(-20).map((entry) => ({
    ...entry,
    body: entry.body.slice(0, 2_000)
  }))
})

const boundedSummary = (issue: IssueSummary) => ({ ...issue, body: issue.body.slice(0, 1_000) })

const routeFrom = (
  context: AgentToolExecutionContext
): Pick<Required<LinearRoute>, "sessionId" | "repository"> => ({
  sessionId: context.session.id,
  repository: context.session.repository
})

const optionalStringArray = (
  input: LinearAgentToolInput,
  key: "labelIds"
): readonly string[] | undefined => {
  const value = input[key]
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((item) => !isString(item))) {
    throw new Error(`Linear tool field "${key}" must be an array of strings.`)
  }
  return value
}

const LINEAR_TOOLSET_ID = "linear.issues"

const linearAgentTools = (client: LinearClient): readonly AgentToolDefinition[] => {
  const base = {
    timeoutMs: 30_000,
    outputBudget: 64_000,
    cancellable: true
  } as const
  return [
    {
      ...base,
      id: "linear_context",
      description: "Load the mapped Linear workspace metadata (teams, projects, states, labels, members, priorities). Call once before create/update and reuse returned IDs.",
      inputSchema: { type: "object", additionalProperties: false },
      risk: "network",
      idempotency: "safe",
      execute: async (_input, context) => envelope("none", [], await client.context(routeFrom(context)))
    },
    {
      ...base,
      id: "linear_search_issues",
      description: "Search issues in the session's mapped Linear account. Use a focused identifier/title query; search results are not linked to the session.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Identifier or title text; empty lists recent issues." },
          mine: { type: "boolean", description: "Only issues assigned to the authenticated viewer." },
          limit: { type: "integer", minimum: 1, maximum: 20 }
        },
        additionalProperties: false
      },
      risk: "network",
      idempotency: "safe",
      execute: async (raw, context) => {
        const input = toolInput(raw)
        const limit = input.limit === undefined
          ? 20
          : Math.max(1, Math.min(20, Math.trunc(input.limit)))
        const route = routeFrom(context)
        const issues = (await client.listIssues({
          ...route,
          search: stringInput(input, "query") ?? "",
          mine: input.mine === true
        })).slice(0, limit)
        return envelope("none", [], issues.map(boundedSummary))
      }
    },
    {
      ...base,
      id: "linear_get_issue",
      description: "Fetch one Linear issue and comments by UUID or identifier. It is linked only when the user referenced that issue in the current request.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
        additionalProperties: false
      },
      risk: "network",
      idempotency: "safe",
      execute: async (raw, context) => {
        const input = toolInput(raw)
        const route = routeFrom(context)
        const issue = await client.getIssue({ ...route, issueId: stringInput(input, "issueId", true)! })
        if (!issue) throw new Error("Linear could not find this issue.")
        return envelope("user-reference", [issue], boundedIssue(issue), await client.profileId(route))
      }
    },
    {
      ...base,
      id: "linear_create_issue",
      description: "Create an issue using repository/session defaults. Call linear_context first only when you need explicit team/project/state/assignee/label IDs.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" }, description: { type: "string" }, teamId: { type: "string" },
          projectId: { type: "string" }, stateId: { type: "string" }, priority: { type: "integer", minimum: 0, maximum: 4 },
          assigneeId: { type: "string" }, labelIds: { type: "array", items: { type: "string" } }
        },
        required: ["title"],
        additionalProperties: false
      },
      risk: "mutate",
      idempotency: "keyed",
      execute: async (raw, context) => {
        const input = toolInput(raw)
        const route = routeFrom(context)
        const createInput: LinearCreateRequest = {
          ...route,
          title: stringInput(input, "title", true)!,
          body: stringInput(input, "description") ?? ""
        }
        const teamId = stringInput(input, "teamId")
        const projectId = stringInput(input, "projectId")
        const stateId = stringInput(input, "stateId")
        const assigneeId = stringInput(input, "assigneeId")
        const labelIds = optionalStringArray(input, "labelIds")
        if (teamId) Object.assign(createInput, { teamId })
        if (projectId) Object.assign(createInput, { projectId })
        if (stateId) Object.assign(createInput, { stateId })
        if (input.priority !== undefined) Object.assign(createInput, { priority: input.priority })
        if (assigneeId) Object.assign(createInput, { assigneeId })
        if (labelIds) Object.assign(createInput, { labelIds })
        const issue = await client.createIssue(createInput)
        return envelope("mutation", [issue], boundedIssue(issue), await client.profileId(route))
      }
    },
    {
      ...base,
      id: "linear_update_issue",
      description: "Update one Linear issue. Call linear_context first for metadata IDs; omit unchanged fields. The refreshed issue is linked to this session.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, teamId: { type: "string" },
          projectId: { type: ["string", "null"] }, stateId: { type: "string" }, priority: { type: "integer", minimum: 0, maximum: 4 },
          assigneeId: { type: ["string", "null"] }, labelIds: { type: "array", items: { type: "string" } }
        },
        required: ["issueId"],
        additionalProperties: false
      },
      risk: "mutate",
      idempotency: "keyed",
      execute: async (raw, context) => {
        const input = toolInput(raw)
        const route = routeFrom(context)
        const nullable = (
          key: "projectId" | "assigneeId"
        ): string | null | undefined => input[key] === null ? null : stringInput(input, key)
        const updateInput: LinearUpdateRequest = {
          ...route,
          issueId: stringInput(input, "issueId", true)!
        }
        assignUpdateTextFields(updateInput, input)
        if (input.projectId !== undefined) {
          Object.assign(updateInput, { projectId: nullable("projectId") })
        }
        if (input.stateId !== undefined) {
          Object.assign(updateInput, { stateId: stringInput(input, "stateId") })
        }
        if (input.priority !== undefined) Object.assign(updateInput, { priority: input.priority })
        if (input.assigneeId !== undefined) {
          Object.assign(updateInput, { assigneeId: nullable("assigneeId") })
        }
        if (input.labelIds !== undefined) {
          Object.assign(updateInput, { labelIds: optionalStringArray(input, "labelIds") })
        }
        const issue = await client.updateIssue(updateInput)
        return envelope("mutation", [issue], boundedIssue(issue), await client.profileId(route))
      }
    },
    {
      ...base,
      id: "linear_add_comment",
      description: "Add a comment to one Linear issue, then return and link the refreshed issue.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
        additionalProperties: false
      },
      risk: "mutate",
      idempotency: "keyed",
      execute: async (raw, context) => {
        const input = toolInput(raw)
        const issueId = stringInput(input, "issueId", true)!
        const route = routeFrom(context)
        await client.addComment({ ...route, issueId, body: stringInput(input, "body", true)! })
        const issue = await client.getIssue({ ...route, issueId })
        if (!issue) throw new Error("Linear added the comment but could not reload the issue.")
        return envelope("mutation", [issue], boundedIssue(issue), await client.profileId(route))
      }
    }
  ]
}

const assignUpdateTextFields = (update: LinearUpdateRequest, input: ReturnType<typeof toolInput>): void => {
  if (input.title !== undefined) Object.assign(update, { title: stringInput(input, "title") })
  if (input.description !== undefined) Object.assign(update, { body: stringInput(input, "description") })
  if (input.teamId !== undefined) Object.assign(update, { teamId: stringInput(input, "teamId") })
}

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
    ctx.agentTools.registerToolset({ id: LINEAR_TOOLSET_ID, tools: linearAgentTools(client) }),
    ctx.commands.register("linear.configured", () => client.configured()),
    ctx.commands.register("linear.context", () => client.context()),
    ctx.commands.register("linear.list", issueTabCommand(client.listIssues)),
    ctx.commands.register("linear.get", issueTabCommand(client.getIssue)),
    ctx.commands.register("linear.create", issueTabCommand(client.createIssue)),
    ctx.commands.register("linear.comment", issueTabCommand(client.addComment))
  )
}

export const activate: Activate = (ctx) => {
  const accounts = createLinearAccountManager(ctx)
  const client: LinearClient = {
    configured: async (route = {}) => (await accounts.configuration(route)).profiles.length > 0,
    profileId: async (route = {}) => (await accounts.clientFor(route)).selection.profileId,
    context: async (route = {}) => (await accounts.clientFor(route)).client.context(),
    listIssues: async (input) => (await accounts.clientFor(input)).client.listIssues(input),
    getIssue: async (input) => (await accounts.clientFor(input)).client.getIssue(input),
    createIssue: async (input) => {
      const selected = await accounts.clientFor(input)
      return selected.client.createIssue({
        ...input,
        teamId: input.teamId ?? selected.selection.teamId,
        projectId: input.projectId ?? selected.selection.projectId
      })
    },
    updateIssue: async (input) => (await accounts.clientFor(input)).client.updateIssue(input),
    addComment: async (input) => (await accounts.clientFor(input)).client.addComment(input)
  }
  activateWithClient(ctx, client)
  ctx.subscriptions.push(
    ctx.commands.register("linear.configuration", issueTabCommand((input: LinearRoute) => accounts.configuration(input))),
    ctx.commands.register("linear.profile-add", issueTabCommand((input: LinearRoute & { name: string; apiKey: string }) => accounts.addProfile(input))),
    ctx.commands.register("linear.profile-remove", issueTabCommand((input: LinearRoute & { profileId: string }) => accounts.removeProfile(input))),
    ctx.commands.register("linear.repo-default", issueTabCommand((input: LinearRoute & { selection: LinearSelection }) => accounts.setRepoDefault(input))),
    ctx.commands.register("linear.session-override", issueTabCommand((input: LinearRoute & { selection: LinearSelection }) => accounts.setSessionOverride(input))),
    ctx.commands.register("linear.session-reset", issueTabCommand((input: LinearRoute) => accounts.resetSessionOverride(input)))
  )
}
