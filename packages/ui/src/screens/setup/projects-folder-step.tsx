import type { Repo } from "@jingler/core"
import { ArrowRight, FolderSearch, GitBranch } from "lucide-react"
import { Button } from "../../components/button.js"
import { Checkbox } from "../../components/checkbox.js"
import { EmptyState, InlineError } from "../../components/feedback.js"
import { Spinner } from "../../components/loading.js"

export interface ProjectsFolderStepProps {
  reposDir: string | null
  repos: ReadonlyArray<Repo>
  selectedRepoPaths: ReadonlyArray<string>
  error: string | null
  busy: boolean
  onChooseDir: () => void
  onContinue: () => void
  onToggleRepo: (path: string) => void
  onToggleAllRepos: () => void
  onAddProjects: () => void
  onCloneRepository: () => void
}

function RepoChecklist({
  repos,
  selectedRepoPaths,
  onToggleRepo,
  onToggleAllRepos
}: Pick<ProjectsFolderStepProps, "repos" | "selectedRepoPaths" | "onToggleRepo" | "onToggleAllRepos">) {
  const selected = selectedRepoPaths.length
  return (
    <div className="flex flex-col gap-2">
      <Checkbox
        label={`Select all ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`}
        checked={selected === repos.length}
        indeterminate={selected > 0 && selected < repos.length}
        onCheckedChange={onToggleAllRepos}
      />
      <ul aria-label="Repositories" className="flex max-h-64 flex-col overflow-auto rounded-lg border border-line bg-sunken">
        {repos.map((repo) => (
          <li key={repo.path} title={repo.path} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
            <Checkbox
              label={repo.name}
              checked={selectedRepoPaths.includes(repo.path)}
              onCheckedChange={() => onToggleRepo(repo.path)}
            />
            <GitBranch size={11} className="ml-auto flex-none text-cyan" />
            <span className="max-w-[45%] truncate font-mono text-[10.5px] text-dim">{repo.currentBranch ?? repo.path}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Onboarding step 1: pick the projects folder, tick the repositories to add. */
export function ProjectsFolderStep(props: ProjectsFolderStepProps) {
  const { reposDir, repos, selectedRepoPaths, error, busy, onChooseDir, onContinue, onAddProjects, onCloneRepository } = props
  const failed = error !== null && !busy
  const scanned = reposDir !== null && !failed
  const count = selectedRepoPaths.length
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">Set up your workspace</h1>
        <p className="text-[13px] leading-[1.6] text-muted-foreground">
          Choose the folder that holds your git repositories. Jingler scans it locally and runs sessions in isolated worktrees.
        </p>
      </div>

      {failed && <InlineError message={error} onRetry={onChooseDir} retryLabel="Choose another folder" />}
      {reposDir === null && !failed && (
        <Button variant="primary" onClick={onChooseDir} disabled={busy} className="self-start">
          {busy ? <Spinner size={13} /> : <FolderSearch size={14} />}
          {busy ? "Scanning…" : "Choose repos folder"}
        </Button>
      )}
      {scanned && (
        <>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5">
            <FolderSearch size={14} className="flex-none text-blue" />
            <span className="truncate font-mono text-[12px] text-text-body">{reposDir}</span>
          </div>
          {repos.length === 0 ? (
            <EmptyState
              title={`No git repositories in ${reposDir}`}
              description="Clone one, or choose a different folder."
              action={<Button variant="secondary" onClick={onCloneRepository}>Clone a repository</Button>}
            />
          ) : (
            <RepoChecklist {...props} />
          )}
          <div className="flex items-center gap-2.5 pt-1">
            {count > 0 ? (
              <Button variant="primary" onClick={onAddProjects}>
                Add {count} {count === 1 ? "project" : "projects"}
                <ArrowRight size={14} />
              </Button>
            ) : (
              <Button variant="primary" onClick={onContinue}>
                Continue
                <ArrowRight size={14} />
              </Button>
            )}
            <Button variant="ghost" onClick={onChooseDir} disabled={busy}>
              {busy ? "Scanning…" : "Choose a different folder"}
            </Button>
          </div>
        </>
      )}
    </>
  )
}
