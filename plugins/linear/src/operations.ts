export interface LinearActorNode {
  readonly id: string
  readonly name: string
  readonly avatarUrl: string | null
}

export interface LinearDisplayNode {
  readonly id: string
  readonly name: string
}

export interface LinearTeamNode extends LinearDisplayNode {
  readonly key: string
}

export interface LinearPageInfo {
  readonly hasNextPage: boolean
  readonly endCursor: string | null
}

export interface LinearCommentNode {
  readonly id: string
  readonly body: string
  readonly createdAt: string
  readonly url: string | null
  readonly user: LinearActorNode | null
}

export interface LinearIssueNode {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly description: string | null
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
  readonly canceledAt: string | null
  readonly priority: number
  readonly priorityLabel: string
  readonly creator: LinearActorNode | null
  readonly assignee: LinearActorNode | null
  readonly state: LinearDisplayNode & { readonly type: string }
  readonly team: LinearTeamNode
  readonly project: LinearDisplayNode | null
  readonly cycle: LinearDisplayNode | null
  readonly labels: {
    readonly nodes: readonly { readonly name: string; readonly color: string | null }[]
  }
}

export interface LinearConnection<Node> {
  readonly nodes: readonly Node[]
  readonly pageInfo?: LinearPageInfo
}

export type LinearWorkflowStateNode = LinearDisplayNode & {
  readonly type: string
  readonly team: LinearDisplayNode | null
}
export type LinearLabelNode = LinearDisplayNode & { readonly color: string | null }

export interface LinearContextData {
  readonly viewer: LinearActorNode
  readonly organization: LinearDisplayNode & { readonly urlKey: string }
  readonly teams: LinearConnection<LinearTeamNode>
  readonly projects: LinearConnection<LinearDisplayNode>
  readonly workflowStates: LinearConnection<LinearWorkflowStateNode>
  readonly issueLabels: LinearConnection<LinearLabelNode>
  readonly users: LinearConnection<LinearActorNode>
}

export interface LinearMetadataPageData<Node> {
  readonly items: LinearConnection<Node> & { readonly pageInfo: LinearPageInfo }
}

export interface LinearIssuesData {
  readonly issues: {
    readonly nodes: readonly LinearIssueNode[]
    readonly pageInfo: LinearPageInfo
  }
}

export interface LinearIssueData {
  readonly issue: LinearIssueNode | null
}

export interface LinearCommentsData {
  readonly issue: {
    readonly comments: {
      readonly nodes: readonly LinearCommentNode[]
      readonly pageInfo: LinearPageInfo
    }
  } | null
}

export interface LinearIssueCreateData {
  readonly issueCreate: {
    readonly success: boolean
    readonly issue: { readonly id: string }
  }
}

export interface LinearIssueUpdateData {
  readonly issueUpdate: {
    readonly success: boolean
    readonly issue: { readonly id: string }
  }
}

export interface LinearCommentCreateData {
  readonly commentCreate: {
    readonly success: boolean
    readonly comment: LinearCommentNode
  }
}

const ISSUE_FIELDS = `
  id identifier title description url createdAt updatedAt completedAt canceledAt
  priority priorityLabel
  creator { id name avatarUrl }
  assignee { id name avatarUrl }
  state { id name type }
  team { id name key }
  project { id name }
  cycle { id name }
  labels { nodes { name color } }
`

export const CONTEXT_QUERY = `query LinearContext {
  viewer { id name avatarUrl }
  organization { id name urlKey }
  teams(first: 50) { nodes { id name key } pageInfo { hasNextPage endCursor } }
  projects(first: 50) { nodes { id name } pageInfo { hasNextPage endCursor } }
  workflowStates(first: 50) { nodes { id name type team { id name } } pageInfo { hasNextPage endCursor } }
  issueLabels(first: 50) { nodes { id name color } pageInfo { hasNextPage endCursor } }
  users(first: 50) { nodes { id name avatarUrl } pageInfo { hasNextPage endCursor } }
}`

export const TEAMS_PAGE_QUERY = `query LinearTeamsPage($after: String) {
  items: teams(first: 50, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } }
}`
export const PROJECTS_PAGE_QUERY = `query LinearProjectsPage($after: String) {
  items: projects(first: 50, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } }
}`
export const WORKFLOW_STATES_PAGE_QUERY = `query LinearWorkflowStatesPage($after: String) {
  items: workflowStates(first: 50, after: $after) { nodes { id name type team { id name } } pageInfo { hasNextPage endCursor } }
}`
export const LABELS_PAGE_QUERY = `query LinearLabelsPage($after: String) {
  items: issueLabels(first: 50, after: $after) { nodes { id name color } pageInfo { hasNextPage endCursor } }
}`
export const USERS_PAGE_QUERY = `query LinearUsersPage($after: String) {
  items: users(first: 50, after: $after) { nodes { id name avatarUrl } pageInfo { hasNextPage endCursor } }
}`

export const ISSUES_QUERY = `query LinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`

export const SEARCH_ISSUES_QUERY = `query LinearIssueSearch($term: String!, $first: Int!, $after: String, $filter: IssueFilter) {
  issues: searchIssues(term: $term, first: $first, after: $after, filter: $filter) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`

export const ISSUE_QUERY = `query LinearIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`

export const COMMENTS_QUERY = `query LinearComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    comments(first: $first, after: $after) {
      nodes { id body createdAt url user { id name avatarUrl } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

export const CREATE_ISSUE_MUTATION = `mutation LinearIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id } }
}`

export const UPDATE_ISSUE_MUTATION = `mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id } }
}`

export const CREATE_COMMENT_MUTATION = `mutation LinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body createdAt url user { id name avatarUrl } }
  }
}`
