import type {
  IssueAddCommentRequest,
  IssueCreateRequest,
  IssueDetail,
  IssueGetRequest,
  IssueListRequest,
  IssueSummary
} from "@jingler/plugin-sdk/host"

export interface LinearDisplayItem {
  readonly id: string
  readonly name: string
}

export interface LinearTeam extends LinearDisplayItem {
  readonly key: string
}

export interface LinearViewer extends LinearDisplayItem {
  readonly avatarUrl: string | null
}

export interface LinearWorkspace extends LinearDisplayItem {
  readonly urlKey: string
}

export interface LinearContext {
  readonly viewer: LinearViewer
  readonly workspace: LinearWorkspace
  readonly teams: readonly LinearTeam[]
}

export interface LinearIssueDetail extends IssueDetail {
  readonly statusName: string
  readonly priority: {
    readonly value: number
    readonly label: string
  }
  readonly team: LinearTeam
  readonly project: LinearDisplayItem | null
  readonly cycle: LinearDisplayItem | null
}

export interface LinearCreateRequest extends IssueCreateRequest {
  readonly teamId?: string
}

export type LinearListRequest = IssueListRequest
export type LinearGetRequest = IssueGetRequest
export type LinearCommentRequest = IssueAddCommentRequest
export type LinearIssueSummary = IssueSummary
