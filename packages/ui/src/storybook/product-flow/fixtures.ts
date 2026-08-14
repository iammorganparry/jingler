import {
  CURRENT_RUNTIME_CONTRACTS,
  Environment,
  ManagedResource,
  ProviderCatalog,
  ResourceDetectionResult,
  RuntimeDiagnosticSnapshot,
  Session,
  type GitHubConnection,
  type Project,
  type Repo
} from "@jingler/core"
import { Schema } from "effect"

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value)

export const FLOW_REPOS: ReadonlyArray<Repo> = [
  {
    name: "jingler",
    path: "/Users/morgan/Code/jingler",
    defaultBranch: "main",
    currentBranch: "feat/pi-foundation",
    remoteUrl: "git@github.com:iammorganparry/jingler.git",
    githubSlug: "iammorganparry/jingler"
  },
  {
    name: "acme-web",
    path: "/Users/morgan/Code/acme-web",
    defaultBranch: "main",
    currentBranch: "main",
    remoteUrl: "git@github.com:acme/web.git",
    githubSlug: "acme/web"
  }
]

export const FLOW_PROJECTS: ReadonlyArray<Project> = [
  {
    id: "project-jingler",
    name: "jingler",
    path: FLOW_REPOS[0]!.path,
    availability: "available",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-13T14:00:00.000Z"
  },
  {
    id: "project-acme-web",
    environmentId: "cloud-storybook",
    name: "acme-web",
    path: FLOW_REPOS[1]!.path,
    availability: "available",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-13T14:00:00.000Z"
  }
]

const session = (value: Schema.Schema.Encoded<typeof Session>): Session =>
  Schema.decodeSync(Session)(value)

export const FLOW_SESSIONS: ReadonlyArray<Session> = [
  session({
    id: "session-pi-foundation",
    projectId: "project-jingler",
    repo: "jingler",
    repoPath: FLOW_REPOS[0]!.path,
    worktreePath: "/Users/morgan/Code/.worktrees/pi-foundation",
    branch: "feat/pi-foundation",
    baseBranch: "main",
    title: "Make PI the foundational runtime",
    status: "needs-input",
    connectionId: "claude-max",
    providerId: "anthropic",
    modelId: "anthropic/claude-sonnet-5",
    piSessionId: "pi-storybook-claude",
    executionLocation: "local",
    diff: { added: 428, removed: 117 },
    prNumber: 186,
    costUsd: 4.82,
    tokens: 286_400,
    contextTokens: 148_200,
    updatedAt: "2026-08-13T14:04:00.000Z",
    chats: [{
      id: "chat-pi-foundation",
      title: "Runtime migration",
      createdAt: "2026-08-13T09:00:00.000Z",
      updatedAt: "2026-08-13T14:04:00.000Z"
    }],
    activeChatId: "chat-pi-foundation",
    workspaceMode: "worktree",
    mode: "ask"
  }),
  session({
    id: "session-cloud-review",
    projectId: "project-acme-web",
    environmentId: "cloud-storybook",
    repo: "acme-web",
    repoPath: FLOW_REPOS[1]!.path,
    worktreePath: "/workspaces/acme-web",
    branch: "fix/checkout-recovery",
    baseBranch: "main",
    title: "Repair Cloud checkout recovery",
    status: "idle",
    connectionId: "codex-plus",
    providerId: "openai-codex",
    modelId: "openai-codex/gpt-5.6-sol",
    piSessionId: "pi-storybook-codex",
    executionLocation: "cloud",
    diff: { added: 73, removed: 21 },
    prNumber: null,
    costUsd: 1.37,
    tokens: 94_300,
    contextTokens: 51_900,
    updatedAt: "2026-08-13T13:40:00.000Z",
    chats: [{
      id: "chat-cloud-review",
      title: null,
      createdAt: "2026-08-13T11:00:00.000Z",
      updatedAt: "2026-08-13T13:40:00.000Z"
    }],
    activeChatId: "chat-cloud-review",
    workspaceMode: "worktree",
    mode: "accept-edits"
  })
]

export const FLOW_GITHUB: GitHubConnection = {
  mode: "connected",
  enabled: true,
  connected: true,
  user: {
    id: "storybook-user",
    login: "morganparry",
    name: "Morgan Parry",
    avatarUrl: null
  },
  installations: [{
    id: "storybook-installation",
    account: {
      id: "storybook-org",
      login: "iammorganparry",
      type: "User",
      avatarUrl: null
    },
    repositorySelection: "selected",
    permissions: { contents: "write", pull_requests: "write" },
    status: "active",
    suspendedAt: null
  }],
  lastRefreshedAt: "2026-08-13T14:00:00.000Z",
  error: null
}

export const FLOW_PROVIDER_CATALOG = decode(ProviderCatalog, {
  refreshedAt: "2026-08-13T14:00:00.000Z",
  stale: false,
  connections: [
    {
      connection: {
        id: "claude-max",
        providerId: "anthropic",
        authKind: "claude-setup-token",
        account: {
          fingerprint: "claude-storybook-a91f",
          displayLabel: "Claude Max · design account"
        },
        targetId: "local",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: "Max",
          expiresAt: null,
          quotaLabel: "Usage resets in 3h",
          rateLimitLabel: null,
          confirmedBillingRoute: "subscription"
        },
        createdAt: "2026-08-12T08:00:00.000Z",
        updatedAt: "2026-08-13T14:00:00.000Z"
      },
      models: [
        {
          providerId: "anthropic",
          id: "anthropic/claude-sonnet-5",
          label: "Claude Sonnet 5",
          capabilities: {
            contextWindow: 1_000_000,
            reasoning: ["minimal", "low", "medium", "high", "xhigh", "max"],
            reasoningCanDisable: true,
            reasoningDefault: "medium",
            vision: true
          },
          verification: "certified",
          selectable: true,
          certificationKey: "storybook-claude-sonnet-5"
        },
        {
          providerId: "anthropic",
          id: "anthropic/claude-opus-5",
          label: "Claude Opus 5",
          capabilities: {
            contextWindow: 1_000_000,
            reasoning: ["minimal", "low", "medium", "high", "xhigh", "max"],
            reasoningCanDisable: true,
            reasoningDefault: "medium",
            vision: true
          },
          verification: "unverified",
          selectable: false,
          certificationKey: null
        }
      ]
    },
    {
      connection: {
        id: "codex-plus",
        providerId: "openai-codex",
        authKind: "openai-codex-oauth",
        account: {
          fingerprint: "codex-storybook-f821",
          displayLabel: "ChatGPT Plus · design account"
        },
        targetId: "local",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: "Plus",
          expiresAt: "2026-08-13T15:00:00.000Z",
          quotaLabel: null,
          rateLimitLabel: "88% remaining",
          confirmedBillingRoute: "subscription"
        },
        createdAt: "2026-08-12T08:00:00.000Z",
        updatedAt: "2026-08-13T14:00:00.000Z"
      },
      models: [
        {
          providerId: "openai-codex",
          id: "openai-codex/gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          capabilities: {
            contextWindow: 1_000_000,
            reasoning: ["minimal", "low", "medium", "high", "xhigh", "max"],
            reasoningCanDisable: true,
            reasoningDefault: "medium",
            vision: true
          },
          verification: "certified",
          selectable: true,
          certificationKey: "storybook-gpt-5.6-sol"
        },
        {
          providerId: "openai-codex",
          id: "openai-codex/gpt-5.6-terra",
          label: "GPT-5.6 Terra",
          capabilities: {
            contextWindow: 1_000_000,
            reasoning: ["minimal", "low", "medium", "high", "xhigh", "max"],
            reasoningCanDisable: true,
            reasoningDefault: "medium",
            vision: true
          },
          verification: "stale",
          selectable: false,
          certificationKey: null
        }
      ]
    }
  ]
})

const EXTRA_RESOURCE_FIXTURES = [
  ["effect-services", "Effect services"],
  ["electron-qa", "Electron QA"],
  ["pi-runtime", "Pi runtime"],
  ["provider-auth", "Provider authentication"],
  ["diff-review", "Diff review"],
  ["cloud-handoff", "Cloud handoff"],
  ["storybook-flow", "Storybook flow"],
  ["accessibility-review", "Accessibility review"],
  ["release-evals", "Release evaluations"],
  ["runtime-diagnostics", "Runtime diagnostics"]
] as const

export const FLOW_RESOURCE_DETECTION = decode(ResourceDetectionResult, {
  candidates: [
    {
      id: "review-changes",
      kind: "skill",
      name: "Review changes",
      description: "Run the team's adversarial review workflow.",
      byteLength: 4_812,
      provenance: {
        origin: "shared",
        sourceRoot: "/Users/morgan/.agents/skills",
        sourcePath: "/Users/morgan/.agents/skills/review/SKILL.md",
        importedAt: null
      }
    },
    {
      id: "release-checklist",
      kind: "prompt",
      name: "Release checklist",
      description: "Verify release gates and prepare evidence.",
      byteLength: 1_942,
      provenance: {
        origin: "claude",
        sourceRoot: "/Users/morgan/.claude/prompts",
        sourcePath: "/Users/morgan/.claude/prompts/release.md",
        importedAt: null
      }
    },
    ...EXTRA_RESOURCE_FIXTURES.map(([id, name], index) => ({
      id,
      kind: "skill",
      name,
      description: `Mock ${name.toLowerCase()} workflow for the complete product flow.`,
      byteLength: 2_000 + index * 173,
      provenance: {
        origin: "shared",
        sourceRoot: "/Users/morgan/.agents/skills",
        sourcePath: `/Users/morgan/.agents/skills/${id}/SKILL.md`,
        importedAt: null
      }
    }))
  ],
  skipped: [{
    sourcePath: "/Users/morgan/.config/agents/legacy.json",
    kind: null,
    code: "unsupported",
    message: "Legacy executable resource definitions are not imported."
  }]
})

export const FLOW_RESOURCES = [
  decode(ManagedResource, {
    id: "review-changes",
    kind: "skill",
    name: "Review changes",
    description: "Run the team's adversarial review workflow.",
    enabled: true,
    trust: "operator-approved",
    scope: { kind: "portable", allowedTargets: [] },
    provenance: {
      origin: "shared",
      sourceRoot: "/Users/morgan/.agents/skills",
      sourcePath: "/Users/morgan/.agents/skills/review/SKILL.md",
      importedAt: "2026-08-13T12:00:00.000Z"
    },
    managedPath: "/Users/morgan/jingler/resources/review-changes/SKILL.md",
    byteLength: 4_812
  }),
  decode(ManagedResource, {
    id: "team-memory",
    kind: "mcp",
    name: "Team memory",
    enabled: true,
    trust: "operator-approved",
    scope: { kind: "portable", allowedTargets: ["local", "cloud-storybook"] },
    provenance: {
      origin: "jingler",
      sourceRoot: "/Users/morgan/jingler/connectors",
      sourcePath: "/Users/morgan/jingler/connectors/team-memory.json",
      importedAt: "2026-08-13T12:00:00.000Z"
    },
    availability: { state: "available", targetId: "local", reason: null },
    transport: "http",
    url: "https://api.jingler.dev/mcp/memory",
    headerKeys: ["authorization"]
  })
]

export const FLOW_ENVIRONMENTS = [
  decode(Environment, {
    kind: "managed",
    id: "cloud-storybook",
    name: "Cloud",
    platform: { os: "linux", arch: "x64" },
    capabilities: {
      version: 1,
      capabilities: ["session.start"],
      maxConcurrentSessions: 1,
      runtime: {
        versions: CURRENT_RUNTIME_CONTRACTS,
        toolIds: [
          "workspace_read",
          "workspace_search",
          "workspace_write",
          "question_ask",
          "plan_submit"
        ],
        resourceIds: ["review-changes", "team-memory"],
        targetId: "cloud-storybook"
      }
    },
    state: "online",
    agentVersion: null,
    lastSeenAt: Date.now(),
    region: "wnam",
    instanceType: "standard-1",
    generation: 4,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now()
  }),
  decode(Environment, {
    kind: "owned",
    id: "buildbox-storybook",
    name: "Buildbox",
    platform: { os: "linux", arch: "arm64" },
    capabilities: {
      version: 1,
      capabilities: ["session.start"],
      maxConcurrentSessions: 4
    },
    state: "online",
    agentVersion: "2.0.3",
    lastSeenAt: Date.now()
  })
]

export const FLOW_RUNTIME_DIAGNOSTIC = decode(RuntimeDiagnosticSnapshot, {
  runId: "run-storybook-pi",
  sessionId: "session-pi-foundation",
  connectionId: "claude-max",
  authRoute: "claude-setup-token",
  accountFingerprint: "claude-storybook-a91f",
  versions: CURRENT_RUNTIME_CONTRACTS,
  promptHash: "sha256:storybook-prompt-manifest",
  promptSections: [
    { id: "runtime-policy", hash: "policy-ae12", estimatedTokens: 1_240, truncated: false },
    { id: "tool-contract", hash: "tools-b719", estimatedTokens: 2_480, truncated: false },
    { id: "workspace", hash: "workspace-c220", estimatedTokens: 812, truncated: false }
  ],
  activeToolIds: [
    "workspace_read",
    "workspace_search",
    "workspace_write",
    "question_ask",
    "plan_submit",
    "mcp.team-memory"
  ],
  mode: "ask",
  retries: 0,
  mutations: [{
    callId: "tool-call-storybook",
    toolId: "workspace_write",
    targetCategory: "workspace",
    status: "settled",
    fileChangeSetIds: ["changes-storybook"]
  }],
  fileChangeStatuses: ["A", "M", "D", "R"],
  mcpHealth: [
    { name: "team-memory", status: "healthy" },
    { name: "open-connector", status: "healthy" }
  ],
  terminalCause: "completed",
  updatedAt: "2026-08-13T14:04:00.000Z"
})
