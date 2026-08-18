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
  LinearConfiguration,
  LinearProfile,
  LinearSelection,
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

export interface LinearRoute {
  readonly sessionId?: string
  readonly repository?: { readonly name: string; readonly path: string }
}

export interface LinearClient {
  configured(route?: LinearRoute): Promise<boolean>
  context(route?: LinearRoute): Promise<LinearContext>
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
  return {
    viewer,
    workspace,
    teams: data.teams.nodes.map(team),
    projects: data.projects.nodes.map(displayItem)
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
    input: {
      teamId,
      title: input.title,
      description: input.body,
      ...(input.projectId ? { projectId: input.projectId } : {})
    }
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

const PROFILE_COLLECTION = "linear.accounts"
const PROFILES_KEY = "profiles"
const REPO_DEFAULTS_KEY = "repo-defaults"
const SESSION_OVERRIDES_KEY = "session-overrides"
const LEGACY_PROFILE_ID = "legacy-default"

type LinearConfigurationHost = Pick<HostContext, "settings" | "storage">

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const selectionOf = (value: unknown): LinearSelection | null => {
  const candidate = record(value)
  if (typeof candidate?.profileId !== "string") return null
  return {
    profileId: candidate.profileId,
    ...(typeof candidate.teamId === "string" ? { teamId: candidate.teamId } : {}),
    ...(typeof candidate.projectId === "string" ? { projectId: candidate.projectId } : {})
  }
}

const profileOf = (value: unknown): LinearProfile | null => {
  const candidate = record(value)
  const viewer = record(candidate?.viewer)
  const workspace = record(candidate?.workspace)
  if (
    typeof candidate?.id !== "string" || typeof candidate.name !== "string" ||
    typeof viewer?.id !== "string" || typeof viewer.name !== "string" ||
    typeof workspace?.id !== "string" || typeof workspace.name !== "string" ||
    typeof workspace.urlKey !== "string" || !Array.isArray(candidate.teams) ||
    !Array.isArray(candidate.projects)
  ) return null
  return candidate as unknown as LinearProfile
}

const profileFromContext = (
  id: string,
  name: string,
  context: LinearContext,
  legacy = false
): LinearProfile => ({ id, name, ...context, ...(legacy ? { legacy: true } : {}) })

const mapOf = (value: unknown): Record<string, LinearSelection> => {
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
    ((await ctx.storage.get<unknown[]>(PROFILES_KEY)) ?? []).flatMap((value) => {
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
    const resolved = sessionOverride ?? repoDefault ?? (available[0] ? { profileId: available[0].id } : null)
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

const issueTabCommand = <Input, Output>(handler: (input: Input) => Output | Promise<Output>) =>
  async (input?: unknown): Promise<Output> => {
    if (input === undefined) {
      throw new Error("Open the Linear Issue tab to use this command.")
    }
    return handler(input as Input)
  }

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
