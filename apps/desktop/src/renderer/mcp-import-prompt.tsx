import type {
  McpImportCandidateView,
  McpImportSourceId,
  McpServer
} from "@jingler/core"
import {
  AsyncButton,
  Callout,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@jingler/ui"
import { ServerCog } from "lucide-react"
import { useEffect, useRef, useState } from "react"

const COMPLETED_KEY = "jingler:mcp-import-prompt:v1"
const SOURCES: ReadonlyArray<McpImportSourceId> = ["claude", "codex", "opencode"]

const completed = (): boolean => {
  try {
    return localStorage.getItem(COMPLETED_KEY) === "done"
  } catch {
    return false
  }
}

const markCompleted = (): void => {
  try {
    localStorage.setItem(COMPLETED_KEY, "done")
  } catch {
    // The prompt may repeat when storage is unavailable; imports still work.
  }
}

export function McpImportPrompt({
  ready,
  servers,
  load,
  apply
}: {
  readonly ready: boolean
  readonly servers: ReadonlyArray<McpServer>
  readonly load: (source: McpImportSourceId) => Promise<ReadonlyArray<McpImportCandidateView>>
  readonly apply: (
    source: McpImportSourceId,
    names: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<string>>
}) {
  const started = useRef(false)
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<ReadonlyArray<McpImportCandidateView>>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready || started.current || completed()) return
    started.current = true
    const existing = new Set(servers.map(({ name }) => name))
    Promise.all(SOURCES.map((source) => load(source).catch(() => []))).then((results) => {
      const found = new Map<string, McpImportCandidateView>()
      for (const candidate of results.flat()) {
        if (candidate.problem === null && !existing.has(candidate.name) && !found.has(candidate.name)) {
          found.set(candidate.name, candidate)
        }
      }
      const discovered = [...found.values()]
      setCandidates(discovered)
      setOpen(discovered.length > 0)
    })
  }, [load, ready, servers])

  const dismiss = () => {
    markCompleted()
    setOpen(false)
  }

  const importAll = async () => {
    setError(null)
    try {
      for (const source of SOURCES) {
        const names = candidates
          .filter((candidate) => candidate.source === source)
          .map((candidate) => candidate.name)
        if (names.length > 0) await apply(source, names)
      }
      dismiss()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not import MCP servers"
      setError(message)
      throw new Error(message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent>
        <DialogHeader className="items-start gap-3 px-5 py-4 pr-14">
          <div className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg border border-line bg-sunken text-muted-foreground">
            <ServerCog size={15} aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <DialogTitle className="text-[14px] leading-5">Import MCP servers</DialogTitle>
            <DialogDescription>
              Found {candidates.length} server{candidates.length === 1 ? "" : "s"} in Claude,
              Codex/OpenAI, and OpenCode. Import them for on-demand use in local sessions.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="px-5 py-4">
          <div className="max-h-64 overflow-auto rounded-xl border border-line bg-sunken">
            {candidates.map((candidate) => (
              <div key={`${candidate.source}:${candidate.name}`} className="border-b border-line px-3.5 py-2.5 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate text-xs font-medium text-text-bright">{candidate.name}</div>
                  <div className="flex-none rounded-md border border-hairline bg-panel px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-dim">
                    {candidate.source}
                  </div>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-dim">{candidate.target}</div>
              </div>
            ))}
          </div>
          {error ? <div role="alert" className="mt-3"><Callout tone="red">{error}</Callout></div> : null}
        </DialogBody>
        <DialogFooter className="justify-between px-5">
          <button type="button" onClick={dismiss} className="rounded-md px-2 py-1.5 text-xs text-dim outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring">
            Not now
          </button>
          <AsyncButton pendingLabel="Importing…" onClick={importAll}>
            Import {candidates.length} server{candidates.length === 1 ? "" : "s"}
          </AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
