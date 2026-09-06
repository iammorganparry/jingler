import type { GitHubCloneRepository, ProjectDirectoryListing } from "@jingler/core"
import { useMachine } from "@xstate/react"
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Folder,
  FolderGit2,
  LoaderCircle,
  Plus,
  Search
} from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react"
import { Button } from "../components/button.js"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from "../components/command.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { GithubMark } from "../components/github-mark.js"
import { Input } from "../components/input.js"
import {
  addProjectMachine,
  type AddProjectDeps,
  type AddProjectMethod
} from "./add-project-machine.js"

export interface AddProjectDialogProps extends AddProjectDeps {
  open: boolean
}

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

const METHODS: ReadonlyArray<{
  id: AddProjectMethod
  label: string
  description: string
  icon: ComponentType<{ size?: number; className?: string }>
}> = [
  { id: "existing", label: "Search for directory", description: "Find a directory on this computer", icon: Search },
  { id: "browse", label: "Browse", description: "Open Finder and choose an existing Git repository", icon: Folder },
  { id: "clone", label: "Clone from GitHub", description: "Choose from repositories available to your GitHub App", icon: GithubMark },
  { id: "new", label: "New directory", description: "Create and initialise an empty Git repository", icon: FolderGit2 }
]

const isAbsolutePath = (value: string): boolean =>
  value.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(value)

function MethodPicker({ onSelect }: { onSelect: (method: AddProjectMethod) => void }) {
  return (
    <Command loop>
      <CommandInput autoFocus placeholder="Search project methods…" />
      <CommandList className="max-h-[360px]">
        <CommandEmpty>No project methods match.</CommandEmpty>
        {METHODS.map((item) => {
          const Icon = item.icon
          return (
            <CommandItem
              key={item.id}
              value={`${item.label} ${item.description}`}
              onSelect={() => onSelect(item.id)}
              className="min-h-14 gap-3 px-3 py-2.5"
            >
              <span aria-hidden="true" className="flex-none text-muted-foreground"><Icon size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-text-bright">{item.label}</span>
                <span className="block text-[11px] text-muted-foreground">{item.description}</span>
              </span>
              <ChevronRight size={14} className="flex-none text-dim" aria-hidden="true" />
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}

function DirectoryBrowser(props: {
  listing: ProjectDirectoryListing | null
  loading: boolean
  error: string | null
  onOpen: (path?: string) => void
}) {
  const [query, setQuery] = useState("")
  return (
    <Command loop>
      <CommandInput
        autoFocus
        placeholder="Search folders or enter an absolute path…"
        value={query}
        onValueChange={setQuery}
        onKeyDown={(event) => {
          const requestedPath = query.trim()
          if (event.key !== "Enter" || !isAbsolutePath(requestedPath)) return
          event.preventDefault()
          props.onOpen(requestedPath)
        }}
      />
      <CommandList className="max-h-[360px] min-h-[240px]">
        {props.loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-muted-foreground">
            <LoaderCircle size={14} className="animate-spin" /> Loading folders…
          </div>
        )}
        {!props.loading && props.error && (
          <p role="alert" className="px-3 py-8 text-center text-[12px] text-red">{props.error}</p>
        )}
        {!(props.loading || props.error) && <CommandEmpty>No folders match.</CommandEmpty>}
        {!props.loading && props.listing?.parentPath && (
          <DirectoryItem
            name="Parent directory"
            path={props.listing.parentPath}
            icon={ArrowUp}
            onSelect={props.onOpen}
          />
        )}
        {!props.loading && props.listing?.directories.map((entry) => (
          <DirectoryItem
            key={entry.path}
            name={entry.name}
            path={entry.path}
            icon={entry.isGitRepository ? FolderGit2 : Folder}
            repository={entry.isGitRepository}
            onSelect={props.onOpen}
          />
        ))}
      </CommandList>
    </Command>
  )
}

function DirectoryItem(props: {
  name: string
  path: string
  icon: ComponentType<{ size?: number; className?: string }>
  repository?: boolean
  onSelect: (path: string) => void
}) {
  const Icon = props.icon
  return (
    <CommandItem value={`${props.name} ${props.path}`} onSelect={() => props.onSelect(props.path)}>
      <Icon size={16} className={props.repository ? "flex-none text-blue" : "flex-none text-muted-foreground"} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-text-bright">{props.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{props.path}</span>
      </span>
      <ChevronRight size={14} className="flex-none text-dim" aria-hidden="true" />
    </CommandItem>
  )
}

function ProjectForm(props: {
  path: string
  name: string
  error: string | null
  onPath: (path: string) => void
  onName: (name: string) => void
}) {
  return (
    <div className="space-y-4 p-5">
      <Input autoFocus aria-label="Project directory" placeholder="/Users/you/Projects/repository" value={props.path} onChange={(event) => props.onPath(event.currentTarget.value)} />
      <Input aria-label="Project name" placeholder="Project name (optional)" value={props.name} onChange={(event) => props.onName(event.currentTarget.value)} />
      {props.error && <p role="alert" className="text-[11px] text-red">{props.error}</p>}
    </div>
  )
}

function GitHubRepositoryPicker(props: {
  repositories: ReadonlyArray<GitHubCloneRepository>
  loading: boolean
  error: string | null
  onSelect: (repository: GitHubCloneRepository) => void
}) {
  return (
    <Command loop>
      <CommandInput autoFocus placeholder="Search GitHub repositories…" />
      <CommandList className="max-h-[420px] min-h-[260px]">
        {props.loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-muted-foreground">
            <LoaderCircle size={14} className="animate-spin" /> Loading repositories from GitHub…
          </div>
        )}
        {!props.loading && props.error && (
          <div className="px-5 py-10 text-center">
            <p role="alert" className="text-[12px] text-red">{props.error}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Check the GitHub connection in Settings, then try again.</p>
          </div>
        )}
        {!(props.loading || props.error) && (
          <CommandEmpty>No repositories are available to this GitHub App.</CommandEmpty>
        )}
        {!props.loading && props.repositories.map((repository) => {
          const [owner, name] = repository.fullName.split("/")
          return (
            <CommandItem
              key={`${repository.installationId}:${repository.repositoryId}`}
              value={repository.fullName}
              onSelect={() => props.onSelect(repository)}
              className="min-h-12 gap-3 px-3 py-2"
            >
              <span aria-hidden="true" className="flex-none text-muted-foreground"><GithubMark size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-text-bright">{name ?? repository.fullName}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{owner ? `${owner} on GitHub` : "GitHub repository"}</span>
              </span>
              <ChevronRight size={14} className="flex-none text-dim" aria-hidden="true" />
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}

function CloneConfirmation(props: {
  repository: GitHubCloneRepository
  destination: string
  name: string
  error: string | null
  onName: (name: string) => void
}) {
  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start gap-3 rounded-lg bg-hover px-3 py-3">
        <span aria-hidden="true" className="mt-0.5 flex-none text-muted-foreground"><GithubMark size={18} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-text-bright">{props.repository.fullName}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">Authenticated through your GitHub App connection</span>
        </span>
      </div>
      <label className="block space-y-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Clone destination</span>
        <div className="flex min-h-10 items-center gap-2 rounded-md bg-hover px-3 text-[12px] text-text">
          <Folder size={15} className="flex-none text-muted-foreground" />
          <span className="truncate">{props.destination}</span>
        </div>
      </label>
      <Input aria-label="Project name" placeholder="Project name (optional)" value={props.name} onChange={(event) => props.onName(event.currentTarget.value)} />
      {props.error && <p role="alert" className="text-[11px] text-red">{props.error}</p>}
    </div>
  )
}

const titleFor = (directory: boolean, github: boolean, cloneReady: boolean, form: boolean, method: AddProjectMethod | null): string => {
  if (directory) return "Search for directory"
  if (github) return "Clone from GitHub"
  if (cloneReady) return "Ready to clone"
  if (!form) return "Add project"
  if (method === "clone") return "Clone from GitHub"
  if (method === "new") return "New directory"
  return "Add project"
}

export function AddProjectDialog(props: AddProjectDialogProps) {
         function renderDialogHeader() {
           return (<DialogHeader>
          {(directory || github) && <Button variant="ghost" size="icon" aria-label="Back" onClick={() => send({ type: "BACK" })}><ArrowLeft size={15} /></Button>}
          <DialogTitle>{titleFor(directory, github, cloneReady, form, method)}</DialogTitle>
          {directoryListing && directory && <span className="max-w-[55%] truncate text-[11px] font-normal text-muted-foreground">{directoryListing.path}</span>}
        </DialogHeader>)
         }

         function getDirectory() {
           if (directory) return (<DirectoryBrowser key={directoryListing?.path ?? "loading"} listing={directoryListing} loading={directoryLoading} error={directoryError} onOpen={(nextPath) => send({ type: "OPEN_DIRECTORY", ...(nextPath === undefined ? {} : { path: nextPath }) })} />)
           if (github) return (<GitHubRepositoryPicker repositories={githubRepositories} loading={githubLoading} error={githubError} onSelect={(repository) => send({ type: "SELECT_GITHUB_REPOSITORY", repository })} />)
           if (cloneReady && selectedGitHubRepository) return (<CloneConfirmation repository={selectedGitHubRepository} destination={path} name={name} error={error} onName={(value) => send({ type: "SET_NAME", name: value })} />)
           if (form) return (<ProjectForm path={path} name={name} error={error} onPath={(value) => send({ type: "SET_PATH", path: value })} onName={(value) => send({ type: "SET_NAME", name: value })} />)
           return (<MethodPicker onSelect={(value) => send({ type: "SELECT", method: value })} />)
         }

  const depsRef = useRef<AddProjectDeps>(props)
  depsRef.current = props
  const getDeps = useCallback(() => depsRef.current, [])
  const [state, send] = useMachine(addProjectMachine, { input: { getDeps } })
  useEffect(() => {
    send({ type: props.open ? "OPEN" : "CLOSE" })
  }, [props.open, send])
  const { method, path, name, error, directoryListing, directoryError, githubRepositories, selectedGitHubRepository, githubError } = state.context
  const submitting = state.matches("submitting")
  const cloneReady = state.matches("cloneReady") || (submitting && method === "clone")
  const form = state.matches("form") || (submitting && method !== "clone")
  const directory = state.matches("directory") || state.matches("directoryLoading")
  const directoryLoading = state.matches("directoryLoading")
  const github = state.matches("githubRepositories") || state.matches("githubRepositoriesLoading") || state.matches("cloneDestinationBrowsing")
  const githubLoading = state.matches("githubRepositoriesLoading")
  const canSubmit = method === "clone" ? selectedGitHubRepository !== null && path.trim().length > 0 : path.trim().length > 0

  return (
    <Dialog open={props.open} onOpenChange={(open) => send({ type: open ? "OPEN" : "CLOSE" })}>
      <DialogContent className="max-w-[720px]">
        {renderDialogHeader()}
        <DialogBody className="p-0">
          {getDirectory()}
        </DialogBody>
        {directory && directoryListing && !directoryLoading && (
          <DialogFooter className="justify-between">
            <span className="text-[10px] text-dim">Enter opens a folder · paste a path to jump</span>
            <Button onClick={() => send({ type: "CHOOSE_DIRECTORY", path: directoryListing.path })}><FolderGit2 size={14} /> Choose current folder</Button>
          </DialogFooter>
        )}
        {form && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => send({ type: "BACK" })}>Back</Button>
            <Button disabled={!canSubmit || submitting} onClick={() => send({ type: "SUBMIT" })}><Plus size={14} /> {submitting ? "Adding…" : "Add project"}</Button>
          </DialogFooter>
        )}
        {cloneReady && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => send({ type: "BACK" })}>Back</Button>
            <Button disabled={!canSubmit || submitting} onClick={() => send({ type: "SUBMIT" })}><span aria-hidden="true"><GithubMark size={14} /></span> {submitting ? "Cloning…" : "Clone project"}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
