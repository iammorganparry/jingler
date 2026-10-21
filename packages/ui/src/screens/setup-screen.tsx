import type { NativeEndpointLoginActions } from "../composites/native-endpoint-login.js"
import type {
  AgentEndpointCatalog,
  AuthKind,
  CodexLoginMethod,
  GitHubConnection,
  ProviderCatalog,
  ProviderLoginEvent,
  Repo
} from "@jingler/core"
import { ArrowRight, GitBranch } from "lucide-react"
import { Avatar } from "../components/avatar.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"
import { Stepper } from "../components/status-row.js"
import { GithubMark } from "../components/github-mark.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"
import { JinglerMark } from "../brand/jingler-mark.js"
import { ProjectsFolderStep } from "./setup/projects-folder-step.js"
import { ProviderSetupStep } from "./setup/provider-setup-step.js"

export interface SetupScreenProps {
  step: "workspace" | "github" | "provider" | "importSessions"
  github: GitHubConnection
  providerCatalog?: ProviderCatalog | null
  nativeEndpointLogin?: NativeEndpointLoginActions
  agentEndpointCatalog?: AgentEndpointCatalog | null
  providerLoginEvent?: ProviderLoginEvent | null
  providerPendingAuthKind?: AuthKind | null
  error?: string | null
  providerFailure?: "loadFailed" | "completionFailed" | null
  repos?: ReadonlyArray<Repo>
  busy?: boolean
  onChooseDir: () => void
  onContinue: () => void
  reposDir?: string | null
  selectedRepoPaths?: ReadonlyArray<string>
  onToggleRepo: (path: string) => void
  onToggleAllRepos: () => void
  onAddProjects: () => void
  onCloneRepository: () => void
  onConnectGithub: () => void
  onSkipGithub: () => void
  onRetryGithub?: () => void
  onConnectClaude: (token: string) => void
  onStartCodex: (method: CodexLoginMethod) => void
  onConnectApi: (providerId: string, apiKey: string) => void
  onContinueProvider: () => void
  onSkipProvider: () => void
  onCancelAuth: () => void
  onRetryProvider: () => void
  onSkipImportSessions: () => void
  onContinueImportSessions: () => void
}

const ONBOARDING_STEPS = ["Projects folder", "GitHub", "Agent"] as const

const githubLabel = (github: GitHubConnection): string => {
  switch (github.mode) {
    case "connecting":
      return "Waiting for GitHub"
    case "connected":
      return `Connected as @${github.user?.login ?? "user"}`
    case "partial-access":
      return `Connected as @${github.user?.login ?? "user"} · repository access needs attention`
    case "suspended":
      return "GitHub installation suspended"
    case "error":
      return "GitHub connection unavailable"
    default:
      return "GitHub is not connected"
  }
}

function GithubStatusCard({ github }: { github: GitHubConnection }) {
  const hasConnection = github.connected && github.user !== null
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-sunken px-3 py-3">
      {github.user ? (
        <Avatar
          initial={github.user.login.slice(0, 2).toUpperCase()}
          src={github.user.avatarUrl}
          size={32}
          label={github.user.login}
        />
      ) : (
        <GithubMark size={18} className="flex-none text-text-bright" />
      )}
      <StatusDot
        tone={github.mode === "error" ? "bg-red" : "bg-line-strong"}
        size={8}
        glow={hasConnection}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-text-body">
          {githubLabel(github)}
        </div>
        {github.installations.length > 0 && (
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
            {github.installations.length === 1
              ? "1 installation"
              : `${github.installations.length} installations`}
            {" · "}
            {github.installations.map((installation) => `@${installation.account.login}`).join(", ")}
          </div>
        )}
      </div>
    </div>
  )
}

function GithubErrorCallout({ github }: { github: GitHubConnection }) {
  if (github.mode !== "error") {
    return github.error ? <Callout tone="red">{github.error}</Callout> : null
  }
  return (
    <Callout tone="red">
      <div className="font-medium">GitHub didn't respond</div>
      {github.error && <div>{github.error}</div>}
    </Callout>
  )
}

/** First-run welcome. Side effects stay in the renderer's coordinated machines. */
export function SetupScreen({
  step,
  github,
  providerCatalog = null,
  agentEndpointCatalog = null,
  nativeEndpointLogin,
  providerLoginEvent = null,
  providerPendingAuthKind = null,
  error = null,
  providerFailure = null,
  repos = [],
  busy = false,
  onChooseDir,
  onContinue,
  reposDir = null,
  selectedRepoPaths = [],
  onToggleRepo,
  onToggleAllRepos,
  onAddProjects,
  onCloneRepository,
  onConnectGithub,
  onSkipGithub,
  onRetryGithub,
  onConnectClaude,
  onStartCodex,
  onConnectApi,
  onContinueProvider,
  onSkipProvider,
  onCancelAuth,
  onRetryProvider,
  onSkipImportSessions,
  onContinueImportSessions
}: SetupScreenProps) {
function renderGithubSetup() {
             return (<>
            <div className="flex flex-col gap-2.5">
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">
                Connect GitHub
              </h1>
              <p className="text-[13px] leading-[1.6] text-muted-foreground">
                Install the Jingler GitHub App, then choose which repositories it can access.
                Pull-request and review features stay unavailable for repositories you do not select.
              </p>
            </div>

            <GithubStatusCard github={github} />
            <GithubErrorCallout github={github} />
            <RepositorySummary repos={shownRepos} total={repos.length} overflow={overflow} />

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              {github.mode === "error" && onRetryGithub ? (
                <Button variant="primary" onClick={onRetryGithub}>
                  Try again
                </Button>
              ) : (
                <Button variant="primary" onClick={onConnectGithub} disabled={githubBusy}>
                  {githubBusy ? <Spinner size={13} /> : <GithubMark size={14} />}
                  {githubBusy
                    ? "Waiting for browser…"
                    : hasConnection
                      ? "Manage repositories"
                      : "Install / Connect GitHub"}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={onSkipGithub}
                disabled={busy && github.mode !== "connecting"}
              >
                Skip for now
              </Button>
            </div>
            <p className="text-[11px] leading-[1.55] text-dim">
              GitHub is optional during setup. You can connect later in Settings, but PR features
              remain off until an active installation can access the repository.
            </p>
          </>)
           }


function renderImportSessionsSetup() {
  return (<>
    <div className="flex flex-col gap-2.5">
      <Eyebrow>Setup complete</Eyebrow>
      <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">
        Import existing sessions?
      </h1>
      <p className="text-[13px] leading-[1.6] text-muted-foreground">
        Jingler can import sessions from Claude Code, Codex, Conductor, and T3 Code.
        This is optional and can be done later.
      </p>
    </div>
    <div className="flex items-center gap-2.5 pt-1">
      <Button variant="primary" onClick={onContinueImportSessions}>
        Continue
        <ArrowRight size={14} />
      </Button>
      <Button variant="ghost" onClick={onSkipImportSessions}>
        Skip for now
      </Button>
    </div>
  </>)
}
         function getStep() {




           switch (step) {
case "workspace": {
return (<ProjectsFolderStep
            reposDir={reposDir}
            repos={repos}
            selectedRepoPaths={selectedRepoPaths}
            error={error}
            busy={busy}
            onChooseDir={onChooseDir}
            onContinue={onContinue}
            onToggleRepo={onToggleRepo}
            onToggleAllRepos={onToggleAllRepos}
            onAddProjects={onAddProjects}
            onCloneRepository={onCloneRepository}
          />)
}
case "github": {
return (renderGithubSetup())
}
case "provider": {
return (<ProviderSetupStep
            catalog={providerCatalog}
            endpointCatalog={agentEndpointCatalog}
            nativeEndpointLogin={nativeEndpointLogin}
            loginEvent={providerLoginEvent}
            busy={busy}
            pendingAuthKind={providerPendingAuthKind}
            error={error}
            failure={providerFailure}
            onConnectClaude={onConnectClaude}
            onStartCodex={onStartCodex}
            onConnectApi={onConnectApi}
            onContinue={onContinueProvider}
            onSkip={onSkipProvider}
            onCancel={onCancelAuth}
            onRetry={onRetryProvider}
          />)
}
case "importSessions": {
return (renderImportSessionsSetup())
}
}
         }

  const shownRepos = repos.slice(0, 6)
  const overflow = repos.length - shownRepos.length
  const githubBusy = busy || github.mode === "connecting"
  const hasConnection = github.connected && github.user !== null

  return (
    <div className="flex h-full flex-1 justify-center overflow-auto bg-editor px-6 py-10">
      <div className="my-auto flex w-full max-w-[520px] flex-col gap-6">
        <div className="flex size-12 items-center justify-center rounded-xl bg-brand">
          <JinglerMark className="h-6 w-auto text-white" />
        </div>

        {(step === "workspace" || step === "github") && (
          <Stepper steps={ONBOARDING_STEPS} current={step === "workspace" ? 0 : 1} />
        )}
        {getStep()}
      </div>
    </div>
  )
}

function RepositorySummary({
  repos,
  total,
  overflow
}: {
  repos: ReadonlyArray<Repo>
  total: number
  overflow: number
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[12.5px] text-muted-foreground">
        Found <span className="font-semibold text-text-bright">{total}</span>{" "}
        {total === 1 ? "repository" : "repositories"}
      </span>
      {repos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {repos.map((repo) => (
            <span
              key={repo.path}
              title={repo.path}
              className="flex items-center gap-1.5 rounded-md border border-line bg-hover px-2 py-[3px] font-mono text-[10.5px] text-text"
            >
              <GitBranch size={11} className="text-cyan" />
              {repo.name}
            </span>
          ))}
          {overflow > 0 && (
            <span className="px-2 py-[3px] font-mono text-[10.5px] text-dim">+{overflow} more</span>
          )}
        </div>
      )}
    </div>
  )
}
