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
  DialogHeader,
  DialogTitle
} from "@jingler/ui"
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
        <DialogHeader>
          <DialogTitle>Import your MCP servers?</DialogTitle>
          <DialogDescription>
            Found {candidates.length} server{candidates.length === 1 ? "" : "s"} in Claude,
            Codex/OpenAI, or opencode. They will be available to local sessions.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="max-h-64 overflow-auto rounded-md border border-line bg-sunken">
            {candidates.map((candidate) => (
              <div key={`${candidate.source}:${candidate.name}`} className="border-b border-line px-3 py-2 last:border-b-0">
                <div className="text-xs font-medium text-text-bright">{candidate.name}</div>
                <div className="truncate font-mono text-[10px] text-dim">{candidate.source} · {candidate.target}</div>
              </div>
            ))}
          </div>
          {error ? <div role="alert"><Callout tone="red">{error}</Callout></div> : null}
          <div className="flex items-center gap-2">
            <AsyncButton pendingLabel="Importing…" onClick={importAll}>
              Import all
            </AsyncButton>
            <button type="button" onClick={dismiss} className="text-xs text-dim hover:underline">
              Skip import
            </button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
