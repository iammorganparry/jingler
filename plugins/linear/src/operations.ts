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

export interface LinearContextData {
  readonly viewer: LinearActorNode
  readonly organization: LinearDisplayNode & { readonly urlKey: string }
  readonly teams: { readonly nodes: readonly LinearTeamNode[] }
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
  }
}

export interface LinearIssueCreateData {
  readonly issueCreate: {
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
  teams(first: 100) { nodes { id name key } }
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

export const CREATE_COMMENT_MUTATION = `mutation LinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body createdAt url user { id name avatarUrl } }
  }
}`
