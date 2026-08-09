import * as React from "react"
import type { ComponentType } from "react"
import { useMachine } from "@xstate/react"
import { Folder, FolderGit2, Plus, Search } from "lucide-react"
import { GithubMark } from "../components/github-mark.js"
import { Button } from "../components/button.js"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog.js"
import { Input } from "../components/input.js"
import { addProjectMachine, type AddProjectDeps, type AddProjectMethod } from "./add-project-machine.js"

export interface AddProjectDialogProps extends AddProjectDeps {
  open: boolean
}

const METHODS: ReadonlyArray<{
  id: AddProjectMethod
  label: string
  description: string
  icon: ComponentType<{ size?: number; className?: string }>
}> = [
  { id: "existing", label: "Search for directory", description: "Register an existing Git repository by path", icon: Search },
  { id: "browse", label: "Browse", description: "Choose a repository in Finder", icon: Folder },
  { id: "clone", label: "Clone from GitHub", description: "Clone a repository URL into a new directory", icon: GithubMark },
  { id: "new", label: "New directory", description: "Create and initialise an empty Git repository", icon: FolderGit2 }
]

export function AddProjectDialog(props: AddProjectDialogProps) {
  const depsRef = React.useRef<AddProjectDeps>(props)
  depsRef.current = props
  const getDeps = React.useCallback(() => depsRef.current, [])
  const [state, send] = useMachine(addProjectMachine, { input: { getDeps } })

  React.useEffect(() => {
    send({ type: props.open ? "OPEN" : "CLOSE" })
  }, [props.open, send])

  const { method, path, url, name, error } = state.context
  const form = state.matches("form") || state.matches("submitting")
  const submitting = state.matches("submitting")
  const canSubmit = method === "clone"
    ? url.trim().length > 0 && path.trim().length > 0
    : path.trim().length > 0

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) send({ type: "CLOSE" }) }}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{form ? "Add project" : "Add project"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="p-0">
          {!form ? (
            <div className="py-2">
              {METHODS.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => send({ type: "SELECT", method: item.id })}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left outline-none hover:bg-surface focus-visible:bg-surface"
                  >
                    <Icon size={18} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-text-bright">{item.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{item.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="space-y-4 p-5">
              {method === "clone" && (
                <Input
                  autoFocus
                  aria-label="Repository URL"
                  placeholder="https://github.com/owner/repository.git"
                  value={url}
                  onChange={(event) => send({ type: "SET_URL", url: event.currentTarget.value })}
                />
              )}
              <Input
                autoFocus={method !== "clone"}
                aria-label={method === "clone" ? "Clone destination" : "Project directory"}
                placeholder={method === "clone" ? "/Users/you/Projects/repository" : "/Users/you/Projects/repository"}
                value={path}
                onChange={(event) => send({ type: "SET_PATH", path: event.currentTarget.value })}
              />
              <Input
                aria-label="Project name"
                placeholder="Project name (optional)"
                value={name}
                onChange={(event) => send({ type: "SET_NAME", name: event.currentTarget.value })}
              />
              {error && <p role="alert" className="text-[11px] text-red">{error}</p>}
            </div>
          )}
        </DialogBody>
        {form && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => send({ type: "BACK" })}>Back</Button>
            <Button disabled={!canSubmit || submitting} onClick={() => send({ type: "SUBMIT" })}>
              <Plus size={14} /> {submitting ? "Adding…" : "Add project"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
