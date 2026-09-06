import type {
  AuthKind,
  CodexLoginMethod,
  DetectedResourceCandidate,
  GitHubConnection,
  ProviderCatalog,
  ProviderLoginEvent,
  Repo,
  ResourceDetectionResult
} from "@jingler/core"
import { ArrowRight, FolderSearch, GitBranch } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Eyebrow } from "../components/eyebrow.js"
import { GithubMark } from "../components/github-mark.js"
import { Spinner } from "../components/loading.js"
import { StatusDot } from "../components/status-dot.js"
import { JinglerMark } from "../brand/jingler-mark.js"
import { ProviderSetupStep } from "./setup/provider-setup-step.js"
import { ResourceSetupStep } from "./setup/resource-setup-step.js"

export interface SetupScreenProps {
  step: "workspace" | "github" | "provider" | "resources"
  github: GitHubConnection
  providerCatalog?: ProviderCatalog | null
  providerLoginEvent?: ProviderLoginEvent | null
  providerPendingAuthKind?: AuthKind | null
  resourceDetection?: ResourceDetectionResult | null
  error?: string | null
  repos?: ReadonlyArray<Repo>
  busy?: boolean
  onChooseDir: () => void
  onContinue: () => void
  reposDir?: string | null
  onConnectGithub: () => void
  onSkipGithub: () => void
  onConnectClaude: (token: string) => void
  onStartCodex: (method: CodexLoginMethod) => void
  onConnectApi: (providerId: string, apiKey: string) => void
  onContinueProvider: () => void
  onSkipProvider: () => void
  onCancelAuth: () => void
  onRetryProvider: () => void
  onImportResources: (candidates: ReadonlyArray<DetectedResourceCandidate>) => void
  onSkipResources: () => void
  onCancelResourceImport: () => void
  onRetryResources: () => void
}

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

/** First-run welcome. Side effects stay in the renderer's coordinated machines. */
export function SetupScreen({
  step,
  github,
  providerCatalog = null,
  providerLoginEvent = null,
  providerPendingAuthKind = null,
  resourceDetection = null,
  error = null,
  repos = [],
  busy = false,
  onChooseDir,
  onContinue,
  reposDir = null,
  onConnectGithub,
  onSkipGithub,
  onConnectClaude,
  onStartCodex,
  onConnectApi,
  onContinueProvider,
  onSkipProvider,
  onCancelAuth,
  onRetryProvider,
  onImportResources,
  onSkipResources,
  onCancelResourceImport,
  onRetryResources
}: SetupScreenProps) {
function renderWorkspaceSetup() {
             return (<>
            <div className="flex flex-col gap-2.5">
              <Eyebrow>Welcome · 1 of 2</Eyebrow>
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">
                Set up your workspace
              </h1>
              <p className="text-[13px] leading-[1.6] text-muted-foreground">
                Choose the folder that holds your git repositories. Jingler scans it locally and
                runs sessions in isolated worktrees.
              </p>
            </div>

            {!chosen ? (
              <Button variant="primary" onClick={onChooseDir} disabled={busy} className="self-start">
                {busy ? <Spinner size={13} /> : <FolderSearch size={14} />}
                {busy ? "Scanning…" : "Choose repos folder"}
              </Button>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5">
                  <FolderSearch size={14} className="flex-none text-blue" />
                  <span className="truncate font-mono text-[12px] text-text-body">{reposDir}</span>
                </div>
                <RepositorySummary repos={shownRepos} total={repos.length} overflow={overflow} />
                <div className="flex items-center gap-2.5 pt-1">
                  <Button variant="primary" onClick={onContinue}>
                    Continue
                    <ArrowRight size={14} />
                  </Button>
                  <Button variant="ghost" onClick={onChooseDir} disabled={busy}>
                    {busy ? "Scanning…" : "Choose a different folder"}
                  </Button>
                </div>
              </>
            )}
          </>)
           }

function renderGithubSetup() {
             return (<>
            <div className="flex flex-col gap-2.5">
              <Eyebrow>Welcome · 2 of 2</Eyebrow>
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">
                Connect GitHub
              </h1>
              <p className="text-[13px] leading-[1.6] text-muted-foreground">
                Install the Jingler GitHub App, then choose which repositories it can access.
                Pull-request and review features stay unavailable for repositories you do not select.
              </p>
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-line bg-sunken px-3 py-3">
              <GithubMark size={18} className="flex-none text-text-bright" />
              <StatusDot
                tone={hasConnection ? "bg-green" : github.mode === "error" ? "bg-red" : "bg-line-strong"}
                size={8}
                glow={hasConnection}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-text-body">
                  {githubLabel(github)}
                </div>
                {github.installations.length > 0 && (
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                    {github.installations.map((installation) => `@${installation.account.login}`).join(", ")}
                  </div>
                )}
              </div>
            </div>

            {github.error && <Callout tone="red">{github.error}</Callout>}
            <RepositorySummary repos={shownRepos} total={repos.length} overflow={overflow} />

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <Button variant="primary" onClick={onConnectGithub} disabled={githubBusy}>
                {githubBusy ? <Spinner size={13} /> : <GithubMark size={14} />}
                {githubBusy
                  ? "Waiting for browser…"
                  : hasConnection
                    ? "Manage repositories"
                    : "Install / Connect GitHub"}
              </Button>
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

         function getStep() {




           switch (step) {
case "workspace": {
return (renderWorkspaceSetup())
}
case "github": {
return (renderGithubSetup())
}
case "provider": {
return (<ProviderSetupStep
            catalog={providerCatalog}
            loginEvent={providerLoginEvent}
            busy={busy}
            pendingAuthKind={providerPendingAuthKind}
            error={error}
            onConnectClaude={onConnectClaude}
            onStartCodex={onStartCodex}
            onConnectApi={onConnectApi}
            onContinue={onContinueProvider}
            onSkip={onSkipProvider}
            onCancel={onCancelAuth}
            onRetry={onRetryProvider}
          />)
}
}
           return (<ResourceSetupStep
            detection={resourceDetection}
            busy={busy}
            error={error}
            onImport={onImportResources}
            onSkip={onSkipResources}
            onCancel={onCancelResourceImport}
            onRetry={onRetryResources}
          />)
         }

  const chosen = reposDir !== null
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
