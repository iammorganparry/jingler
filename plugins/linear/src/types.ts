import type {
  IssueAddCommentRequest,
  IssueCreateRequest,
  IssueDetail,
  IssueGetRequest,
  IssueListRequest
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
  readonly projects: readonly LinearDisplayItem[]
}

export interface LinearProfile {
  readonly id: string
  readonly name: string
  readonly viewer: LinearViewer
  readonly workspace: LinearWorkspace
  readonly teams: readonly LinearTeam[]
  readonly projects: readonly LinearDisplayItem[]
  readonly legacy?: boolean
}

export interface LinearSelection {
  readonly profileId: string
  readonly teamId?: string
  readonly projectId?: string
}

export interface LinearConfiguration {
  readonly profiles: readonly LinearProfile[]
  readonly repoDefault: LinearSelection | null
  readonly sessionOverride: LinearSelection | null
  readonly resolved: LinearSelection | null
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
  readonly projectId?: string
}

export type LinearListRequest = IssueListRequest
export type LinearGetRequest = IssueGetRequest
export type LinearCommentRequest = IssueAddCommentRequest
