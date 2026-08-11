import { Schema } from "effect"

const GitSha = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{40,64}$/iu, { identifier: "ExactGitSha" })
)

const GitHubSlug = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, {
    identifier: "GitHubRepositorySlug"
  })
)

const GitBranch = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(512),
  Schema.filter(
    (branch) =>
      !((((((branch.startsWith("-") ||branch.startsWith("/") ) ||branch.endsWith("/") ) ||branch.endsWith(".") ) ||branch.includes("..") ) ||branch.includes("//") ) ||branch.includes("@{") ) &&
      Array.from(branch).every(
        (character) =>
          character.charCodeAt(0) > 0x20 && !"~^:?*[\\".includes(character)
      ),
    { message: () => "Invalid Git branch name" }
  )
)

export const WorkspaceProvisioningSource = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("new") }),
  Schema.Struct({
    kind: Schema.Literal("pull-request"),
    pullRequestNumber: Schema.Int.pipe(Schema.positive())
  }),
  Schema.Struct({
    kind: Schema.Literal("resume"),
    sourceSessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
  }),
  Schema.Struct({
    kind: Schema.Literal("handoff"),
    sourceSessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
    checkpointId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
    eventCursor: Schema.Int.pipe(Schema.nonNegative())
  })
)
export type WorkspaceProvisioningSource = Schema.Schema.Type<
  typeof WorkspaceProvisioningSource
>

/** Secret-free, provider-neutral instructions for recreating one exact workspace. */
export const WorkspaceProvisioningPlan = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.Struct({
    provider: Schema.Literal("github"),
    slug: GitHubSlug
  }),
  headSha: GitSha,
  branch: GitBranch,
  baseBranch: GitBranch,
  createBranch: Schema.Boolean,
  source: WorkspaceProvisioningSource
})
export type WorkspaceProvisioningPlan = Schema.Schema.Type<
  typeof WorkspaceProvisioningPlan
>

const WorkspaceTransferFile = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  contentBase64: Schema.String.pipe(Schema.maxLength(5_600_000))
})

/** Bounded, provider-neutral working-tree state used for verified handoff. */
export const WorkspaceTransferCheckpoint = Schema.Struct({
  version: Schema.Literal(1),
  checkpointId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  sourceSessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  repositorySlug: Schema.NullOr(GitHubSlug),
  headSha: GitSha,
  branch: Schema.NullOr(GitBranch),
  stagedPatch: Schema.String.pipe(Schema.maxLength(5_600_000)),
  unstagedPatch: Schema.String.pipe(Schema.maxLength(5_600_000)),
  untrackedFiles: Schema.Array(WorkspaceTransferFile).pipe(Schema.maxItems(2_000)),
  eventCursor: Schema.Int.pipe(Schema.nonNegative())
})
export type WorkspaceTransferCheckpoint = Schema.Schema.Type<
  typeof WorkspaceTransferCheckpoint
>

export interface WorkspaceProvisioningInput {
  readonly githubSlug: string
  readonly headSha: string
  readonly branch: string
  readonly baseBranch: string
  readonly createBranch: boolean
  readonly source: WorkspaceProvisioningSource
}

export const createWorkspaceProvisioningPlan = (
  input: WorkspaceProvisioningInput
): WorkspaceProvisioningPlan =>
  Schema.decodeUnknownSync(WorkspaceProvisioningPlan)({
    version: 1,
    repository: { provider: "github", slug: input.githubSlug },
    headSha: input.headSha,
    branch: input.branch,
    baseBranch: input.baseBranch,
    createBranch: input.createBranch,
    source: input.source
  }, { onExcessProperty: "error" })
