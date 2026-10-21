import { MCP_ORIGIN_LABELS } from "@jingler/ui"
import type {
  McpImportCandidateView,
  McpImportResolution,
  McpImportSourceId,
  McpServer,
  McpServerStatus
} from "@jingler/core"
import { mcpImportMachine } from "@jingler/core"
import {
  Button,
  Callout,
  ConflictBadge,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  McpImportResult,
  McpServerDetailDialog,
  type McpImportResultRow,
  NeedsSecretsRow,
  NeedsSignInRow
} from "@jingler/ui"
import { useMachine } from "@xstate/react"
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

type Candidate = McpImportCandidateView & { readonly conflict: boolean }

type ResultProps = Pick<Parameters<typeof McpImportPrompt>[0], "startAuthorization" | "logTail">

/** View log / Connect handlers for the result step. */
function useResultActions(startAuthorization: ResultProps["startAuthorization"], logTail: ResultProps["logTail"]) {
  const [logName, setLogName] = useState<string | null>(null)
  const [logLines, setLogLines] = useState<ReadonlyArray<string>>([])
  const [logLoading, setLogLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const viewLog = (name: string) => {
    setLogName(name)
    setLogLines([])
    setLogLoading(true)
    void logTail(name)
      .then((result) => setLogLines(result.lines))
      .finally(() => setLogLoading(false))
  }
  const connect = (name: string) => {
    setActionError(null)
    void startAuthorization(name).catch((cause) =>
      setActionError(cause instanceof Error ? cause.message : "Could not start sign-in")
    )
  }
  return { logName, setLogName, logLines, logLoading, actionError, viewLog, connect }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: UI maps mutually exclusive machine states (review, importing, failed, result) to their controls.
export function McpImportPrompt({
  ready,
  servers,
  load,
  apply,
  probe,
  startAuthorization,
  logTail
}: {
  readonly ready: boolean
  readonly servers: ReadonlyArray<McpServer>
  readonly load: (source: McpImportSourceId) => Promise<ReadonlyArray<McpImportCandidateView>>
  readonly apply: (
    source: McpImportSourceId,
    names: ReadonlyArray<string>,
    resolutions?: Readonly<Record<string, McpImportResolution>>
  ) => Promise<ReadonlyArray<string>>
  readonly probe: () => Promise<ReadonlyArray<McpServerStatus>>
  readonly startAuthorization: (name: string) => Promise<void>
  readonly logTail: (name: string) => Promise<{ readonly lines: ReadonlyArray<string> }>
}) {
  const started = useRef(false)
  const serversRef = useRef(servers)
  serversRef.current = servers
  const [rows, setRows] = useState<ReadonlyArray<McpImportResultRow>>([])
  const { logName, setLogName, logLines, logLoading, actionError, viewLog, connect } = useResultActions(
    startAuthorization,
    logTail
  )

  const [state, send] = useMachine(mcpImportMachine, {
    input: {
      detect: async () => {
        const existing = new Set(serversRef.current.map(({ name }) => name))
        const results = await Promise.all(SOURCES.map((source) => load(source).catch(() => [])))
        const found = new Map<string, Candidate>()
        for (const candidate of results.flat()) {
          if (candidate.problem === null && !found.has(candidate.name)) {
            found.set(candidate.name, { ...candidate, conflict: existing.has(candidate.name) })
          }
        }
        return [...found.values()]
      },
      apply: async (candidates, resolutions) => {
        const imported: string[] = []
        for (const source of SOURCES) {
          const names = candidates
            .filter((candidate) => candidate.source === source)
            .map((candidate) => candidate.name)
          if (names.length > 0) imported.push(...(await apply(source, names, resolutions)))
        }
        // The import RPC returns only names; derive each row's status from the existing probe.
        const statuses = await probe().catch(() => [] as ReadonlyArray<McpServerStatus>)
        setRows(
          imported.map((name) => {
            const state = statuses.find((status) => status.name === name)?.state
            return { name, status: state === "failed" ? "failed" : state === "needs-auth" ? "needs-auth" : "imported" }
          })
        )
      }
    }
  })
  const candidates = state.context.candidates as ReadonlyArray<Candidate>

  useEffect(() => {
    if (!ready || started.current || completed()) return
    started.current = true
    send({ type: "START" })
  }, [ready, send])

  const open = state.matches("reviewing") || state.matches("detectFailed") || state.matches("importing") || state.matches("importFailed") || state.matches("done")
  const done = state.matches("done")


  const dismiss = () => {
    markCompleted()
    send({ type: "DISMISS" })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent>
        <DialogHeader className="items-start gap-3 px-5 py-4 pr-14">
          <div className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg border border-line bg-sunken text-muted-foreground">
            <ServerCog size={15} aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <DialogTitle className="text-[14px] leading-5">{done ? "Import complete" : "Import MCP servers"}</DialogTitle>
            {!state.matches("detectFailed") && !done && (
              <DialogDescription>
                Found {candidates.length} server{candidates.length === 1 ? "" : "s"} in Claude,
                Codex/OpenAI, and OpenCode. Import them for on-demand use in local sessions.
              </DialogDescription>
            )}
          </div>
        </DialogHeader>
        <DialogBody className="px-5 py-4">
          {state.matches("detectFailed") ? (
            <div role="alert">
              <Callout tone="red">{state.context.error}</Callout>
            </div>
          ) : done ? (
            <McpImportResult rows={rows} onConnect={connect} onViewLog={viewLog} />
          ) : (
            <div className="max-h-64 overflow-auto rounded-xl border border-line bg-sunken">
              {candidates.map((candidate) => (
                <div key={`${MCP_ORIGIN_LABELS[candidate.origin ?? "user"]}:${candidate.name}`} className="border-b border-line px-3.5 py-2.5 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-xs font-medium text-text-bright">{candidate.name}</div>
                    <div className="flex-none rounded-md border border-hairline bg-panel px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-dim">
                      {MCP_ORIGIN_LABELS[candidate.origin ?? "user"]}
                    </div>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-dim">{candidate.target}</div>
                  {candidate.needsSignIn && (
                    <div className="mt-1">
                      <NeedsSignInRow host={candidate.target} />
                    </div>
                  )}
                  {candidate.needsSecrets && (
                    <div className="mt-1">
                      <NeedsSecretsRow />
                    </div>
                  )}
                  {candidate.conflict && (
                    <div className="mt-1.5">
                      <ConflictBadge
                        value={state.context.resolutions[candidate.name] ?? "keep-mine"}
                        onChange={(resolution) =>
                          send({ type: "RESOLVE", name: candidate.name, resolution })
                        }
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {actionError !== null ? <div role="alert" className="mt-3"><Callout tone="red">{actionError}</Callout></div> : null}
          {state.matches("importFailed") ? <div role="alert" className="mt-3"><Callout tone="red">{state.context.error}</Callout></div> : null}
        </DialogBody>
        <DialogFooter className="justify-between px-5">
          {done ? <span /> : <Button variant="ghost" size="sm" onClick={dismiss}>Not now</Button>}
          {done ? (
            <Button onClick={dismiss}>Done</Button>
          ) : state.matches("detectFailed") ? (
            <Button onClick={() => send({ type: "RETRY" })}>Retry</Button>
          ) : state.matches("importFailed") ? (
            <Button onClick={() => send({ type: "RETRY" })}>Retry import</Button>
          ) : (
            <Button disabled={state.matches("importing")} onClick={() => send({ type: "IMPORT" })}>
              {state.matches("importing")
                ? "Importing…"
                : `Import ${candidates.length} server${candidates.length === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      <McpServerDetailDialog
        server={servers.find((server) => server.name === logName) ?? null}
        open={logName !== null}
        onOpenChange={(next) => { if (!next) setLogName(null) }}
        toolCount={null}
        logLines={logLines}
        logLoading={logLoading}
        oauthAccount={null}
      />
    </Dialog>
  )
}
