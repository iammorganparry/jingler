import type {
  McpConfigEntry,
  McpImportCandidateView,
  McpImportResolution,
  McpImportSourceId,
  McpRemoteAuth,
  McpServer,
  McpServerStatus
} from "@jingler/core"
import { Schema } from "effect"
import * as React from "react"
import { AsyncButton } from "../components/async-button.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Checkbox } from "../components/checkbox.js"
import { Field } from "../components/field.js"
import { Input } from "../components/input.js"
import { Textarea } from "../components/textarea.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/select.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"
import { StatusRow } from "../components/status-row.js"
import { Toggle } from "../components/toggle.js"
import { McpServerDetailDialog } from "./mcp-server-detail-dialog.js"

/**
 * Settings › MCP servers — the operator's `~/jingler/mcp.json`.
 *
 * PRESENTATIONAL: renders from props and calls back; the desktop renderer wires
 * `useMcpSettings()` in. `servers` is the REDACTED view (header/env names only)
 * — secret values are typed into the add form and travel inbound once.
 */
export interface McpSettingsProps {
  readonly servers: ReadonlyArray<McpServer>
  /** Why mcp.json could not be parsed; the list is empty then. */
  readonly parseError: string | null
  readonly loading: boolean
  /** Live probe results by server name, or null until Test is pressed. */
  readonly statuses: ReadonlyArray<McpServerStatus> | null
  readonly probing: boolean
  readonly probe: () => void
  readonly setEnabled: (name: string, enabled: boolean) => Promise<void>
  readonly setAuth: (name: string, auth: McpRemoteAuth) => Promise<void>
  /** Persist a per-tool toggle; the runtime skips disabled tools when registering MCP tools. */
  readonly setDisabledTools: (name: string, disabledTools: ReadonlyArray<string>) => Promise<void>
  /** Clears the server's stored OAuth credential only, not the server config. */
  readonly signOut: (name: string) => Promise<void>
  readonly remove: (name: string) => Promise<void>
  readonly add: (name: string, entry: McpConfigEntry) => Promise<void>
  readonly setApiKey: (name: string, apiKey: string) => Promise<void>
  readonly startAuthorization: (name: string) => Promise<void>
  readonly reveal: () => Promise<void>
  /** Last stderr lines for one server; refreshed each time its detail dialog opens. */
  readonly logTail: (name: string) => Promise<{ readonly lines: ReadonlyArray<string> }>
  /** Import flow: load candidates from one source, then apply a selection. */
  readonly importCandidates: (
    source: McpImportSourceId,
    connectors?: boolean
  ) => Promise<ReadonlyArray<McpImportCandidateView>>
  readonly applyImport: (
    source: McpImportSourceId,
    names: ReadonlyArray<string>,
    resolutions?: Readonly<Record<string, McpImportResolution>>,
    connectors?: boolean
  ) => Promise<ReadonlyArray<string>>
}

export const MCP_ORIGIN_LABELS: Record<McpImportCandidateView["origin"], string> = {
  user: "User",
  "user-settings": "User settings",
  managed: "Managed",
  "claude.ai": "claude.ai",
  plugin: "Plugin"
}

const IMPORT_SOURCES: ReadonlyArray<{ id: McpImportSourceId; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "opencode" }
]

const statusFor = (
  statuses: ReadonlyArray<McpServerStatus> | null,
  name: string
): McpServerStatus | null =>
  statuses?.find((status) => status.name === name) ?? null

/** Parse "KEY=value" lines into a record; used for headers and environment. */
const parsePairs = (raw: string): Record<string, string> =>
  Object.fromEntries(raw.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    if (trimmed === "") return []
    const at = trimmed.indexOf("=")
    if (at < 1) throw new Error(`Invalid KEY=value line: ${trimmed}`)
    return [[trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim()]]
  }))

const decodeCommand = Schema.decodeUnknownSync(
  Schema.Array(Schema.String.pipe(Schema.minLength(1))).pipe(Schema.minItems(1))
)

const parseCommand = (raw: string): ReadonlyArray<string> => decodeCommand(JSON.parse(raw))

const formEntry = (
  kind: "remote" | "local",
  target: string,
  pairs: string,
  authKind: "none" | "api-key" | "oauth",
  apiKeyHeader: string,
  apiKeyPrefix: string
): McpConfigEntry => {
  if (kind === "local") {
    return {
      type: "local",
      command: parseCommand(target.trim()),
      environment: parsePairs(pairs),
      enabled: true
    }
  }
  return {
    type: "remote",
    url: target.trim(),
    headers: parsePairs(pairs),
    ...(authKind === "api-key"
      ? { auth: { type: "api-key" as const, header: apiKeyHeader.trim(), prefix: apiKeyPrefix } }
      : authKind === "oauth" ? { auth: { type: "oauth" as const } } : {}),
    enabled: true
  }
}

export function McpServerForm({
  add,
  setApiKey,
  onDone,
  onCancel
}: {
  readonly add: McpSettingsProps["add"]
  readonly setApiKey?: McpSettingsProps["setApiKey"]
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [name, setName] = React.useState("")
  const [kind, setKind] = React.useState<"remote" | "local">("remote")
  const [target, setTarget] = React.useState("")
  const [authKind, setAuthKind] = React.useState<"none" | "api-key" | "oauth">("none")
  const [apiKey, setApiKeyValue] = React.useState("")
  const [apiKeyHeader, setApiKeyHeader] = React.useState("Authorization")
  const [apiKeyPrefix, setApiKeyPrefix] = React.useState("Bearer ")
  const [pairs, setPairs] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  const submit = async () => {
    setError(null)
    try {
      const serverName = name.trim()
      await add(serverName, formEntry(kind, target, pairs, authKind, apiKeyHeader, apiKeyPrefix))
      if (authKind === "api-key" && apiKey.length > 0) {
        if (setApiKey === undefined) throw new Error("API-key storage is unavailable")
        await setApiKey(serverName, apiKey)
      }
      onDone()
      setName("")
      setTarget("")
      setPairs("")
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save the server"
      setError(message)
      throw new Error(message)
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="grid grid-cols-[1fr_auto] items-start gap-3">
        <Field label="Server name">
          {(c) => <Input {...c} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. context7" />}
        </Field>
        <Field label="Server type">
          {() => (
            <Select value={kind} onValueChange={(v) => setKind(v === "local" ? "local" : "remote")}>
              <SelectTrigger aria-label="Server type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="remote">Remote (URL)</SelectItem>
                <SelectItem value="local">Local (command)</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>
      <Field label={kind === "remote" ? "Server URL" : "Server command"}>
        {(c) => (
          <Input
            {...c}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={kind === "remote" ? "https://mcp.example.com/mcp" : '["npx", "-y", "some-mcp"]'}
          />
        )}
      </Field>
      {kind === "remote" && (
        <Field label="Authentication">
          {() => (
            <Select value={authKind} onValueChange={(v) => setAuthKind(v as typeof authKind)}>
              <SelectTrigger aria-label="Authentication"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No authentication</SelectItem>
                <SelectItem value="api-key">API key</SelectItem>
                <SelectItem value="oauth">OAuth</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
      )}
      {kind === "remote" && authKind === "api-key" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="API key header">
            {(c) => <Input {...c} value={apiKeyHeader} onChange={(event) => setApiKeyHeader(event.target.value)} placeholder="Header" />}
          </Field>
          <Field label="API key prefix" help="Optional">
            {(c) => <Input {...c} value={apiKeyPrefix} onChange={(event) => setApiKeyPrefix(event.target.value)} placeholder="Prefix" />}
          </Field>
          <Field label="API key" className="col-span-2">
            {(c) => <Input {...c} type="password" value={apiKey} onChange={(event) => setApiKeyValue(event.target.value)} placeholder="API key" />}
          </Field>
        </div>
      )}
      <Field
        label={kind === "remote" ? "Headers" : "Environment variables"}
        help={`One KEY=value per line. Use {env:VAR} to read a value from the environment.`}
      >
        {(c) => <Textarea {...c} value={pairs} onChange={(e) => setPairs(e.target.value)} rows={2} className="min-h-16 font-mono text-[12px]" />}
      </Field>
      {error ? <div role="alert"><Callout tone="red">{error}</Callout></div> : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <AsyncButton pendingLabel="Saving…" onClick={submit}>
          Save server
        </AsyncButton>
      </div>
    </div>
  )
}

function AddServerForm({
  add,
  setApiKey
}: Pick<McpSettingsProps, "add" | "setApiKey">) {
  const [open, setOpen] = React.useState(false)
  return open ? (
    <McpServerForm add={add} setApiKey={setApiKey} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
  ) : (
    <Button variant="secondary" size="sm" className="self-start" onClick={() => setOpen(true)}>
      Add server
    </Button>
  )
}

export function McpServerDialog({
  open,
  onOpenChange,
  add,
  setApiKey
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly add: McpSettingsProps["add"]
  readonly setApiKey?: McpSettingsProps["setApiKey"]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect MCP server</DialogTitle>
          <DialogDescription>
            Saves to ~/jingler/mcp.json and becomes available to local sessions on their next turn.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <McpServerForm
            add={add}
            setApiKey={setApiKey}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function ConnectorsButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <Button variant="secondary" size="sm" disabled={loading} onClick={onClick}>
      {loading ? "Checking claude.ai…" : "Include claude.ai connectors & plugins"}
    </Button>
  )
}

function ImportFlow({
  importCandidates,
  applyImport
}: Pick<McpSettingsProps, "importCandidates" | "applyImport">) {
  const [source, setSource] = React.useState<McpImportSourceId | null>(null)
  const [candidates, setCandidates] = React.useState<ReadonlyArray<McpImportCandidateView> | null>(null)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [connectors, setConnectors] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  const load = async (next: McpImportSourceId, withConnectors = false) => {
    setError(null)
    setMessage(null)
    setLoading(true)
    try {
      const found = await importCandidates(next, withConnectors)
      setConnectors(withConnectors)
      setSource(next)
      setCandidates(found)
      setSelected(new Set(found.filter((c) => c.problem === null).map((c) => c.name)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not read the ${next} config`)
    } finally {
      setLoading(false)
    }
  }

  const apply = async () => {
    if (source === null) return
    setError(null)
    try {
      const imported = await applyImport(source, [...selected], undefined, connectors)
      setCandidates(null)
      setSource(null)
      setMessage(
        imported.length === 0
          ? "Nothing imported — the selected servers already exist."
          : `Imported ${imported.join(", ")}.`
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed")
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Import from</span>
        {IMPORT_SOURCES.map(({ id, label }) => (
          <Button key={id} variant="secondary" size="sm" onClick={() => void load(id)}>
            {label}
          </Button>
        ))}
      </div>
      {error ? <div role="alert"><Callout tone="red">{error}</Callout></div> : null}
      {message ? <Callout tone="blue">{message}</Callout> : null}
      {candidates !== null ? (
        candidates.length === 0 ? (
          <Callout tone="blue">No MCP servers found in the {source} config.</Callout>
        ) : (
          <div className="flex max-w-xl flex-col gap-1 rounded-md border border-line bg-panel p-3">
            {candidates.map((candidate) => (
              <label key={candidate.name} className="flex items-center gap-2 text-[12px]">
                <Checkbox
                  disabled={candidate.problem !== null}
                  checked={selected.has(candidate.name)}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected)
                    if (checked) next.add(candidate.name)
                    else next.delete(candidate.name)
                    setSelected(next)
                  }}
                />
                <span className="text-text-body">{candidate.name}</span>
                <span className="flex-none rounded-md border border-hairline bg-panel px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-dim">
                  {MCP_ORIGIN_LABELS[candidate.origin]}
                </span>
                <span className="min-w-0 truncate font-mono text-[10px] text-dim">
                  {candidate.problem ?? candidate.target}
                </span>
              </label>
            ))}
            <div className="mt-2 flex items-center gap-2">
              {source === "claude" && !connectors ? (
                <ConnectorsButton loading={loading} onClick={() => void load("claude", true)} />
              ) : null}
              <AsyncButton pendingLabel="Importing…" onClick={apply} disabled={selected.size === 0}>
                Import {selected.size} server{selected.size === 1 ? "" : "s"}
              </AsyncButton>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCandidates(null)
                  setSource(null)
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}

interface McpAuthSetupDialogProps {
  readonly server: McpServer | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly setAuth: McpSettingsProps["setAuth"]
  readonly setApiKey: McpSettingsProps["setApiKey"]
  readonly startAuthorization: McpSettingsProps["startAuthorization"]
}

export function McpAuthSetupDialog(props: McpAuthSetupDialogProps) {
  return <McpAuthSetupDialogContent key={`${props.server?.name ?? "closed"}:${props.open}`} {...props} />
}

function McpAuthSetupDialogContent({
  server,
  open,
  onOpenChange,
  setAuth,
  setApiKey,
  startAuthorization
}: McpAuthSetupDialogProps) {
  const [kind, setKind] = React.useState<"oauth" | "api-key">("oauth")
  const [apiKey, setApiKeyValue] = React.useState("")
  const [header, setHeader] = React.useState("Authorization")
  const [prefix, setPrefix] = React.useState("Bearer ")
  if (server === null) return null
  const submit = async () => {
    if (kind === "oauth") {
      await setAuth(server.name, { type: "oauth" })
      await startAuthorization(server.name)
    } else {
      await setAuth(server.name, { type: "api-key", header: header.trim(), prefix })
      await setApiKey(server.name, apiKey)
    }
    setApiKeyValue("")
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure authentication for {server.displayName}</DialogTitle>
          <DialogDescription>Choose the authentication method required by this MCP server.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <Field label="Authentication method">
              {() => (
                <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger aria-label="Authentication method"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="oauth">OAuth</SelectItem>
                <SelectItem value="api-key">API key</SelectItem>
              </SelectContent>
            </Select>
              )}
            </Field>
            {kind === "api-key" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="API key header">{(c) => <Input {...c} value={header} onChange={(event) => setHeader(event.target.value)} />}</Field>
                  <Field label="API key prefix">{(c) => <Input {...c} value={prefix} onChange={(event) => setPrefix(event.target.value)} />}</Field>
                </div>
                <Field label={`API key for ${server.displayName}`}>{(c) => <Input {...c} type="password" value={apiKey} onChange={(event) => setApiKeyValue(event.target.value)} />}</Field>
              </>
            )}
            <AsyncButton disabled={kind === "api-key" && (apiKey.length === 0 || header.trim().length === 0)} pendingLabel={kind === "oauth" ? "Opening…" : "Saving…"} onClick={submit}>
              {kind === "oauth" ? "Continue with OAuth" : "Save API key"}
            </AsyncButton>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function McpApiKeyDialog({
  server,
  open,
  onOpenChange,
  setApiKey
}: {
  readonly server: McpServer | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly setApiKey: McpSettingsProps["setApiKey"]
}) {
  const [apiKey, setApiKeyValue] = React.useState("")
  if (server === null) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{server.authState === "ready" ? "Replace" : "Add"} {server.displayName} API key</DialogTitle>
          <DialogDescription>The key is encrypted by the OS credential vault and never written to mcp.json.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            <Field label={`API key for ${server.displayName}`}>{(c) => <Input {...c} type="password" value={apiKey} onChange={(event) => setApiKeyValue(event.target.value)} autoFocus />}</Field>
            <AsyncButton
              disabled={apiKey.length === 0}
              pendingLabel="Saving…"
              onClick={() => setApiKey(server.name, apiKey).then(() => {
                setApiKeyValue("")
                onOpenChange(false)
              })}
            >Save key</AsyncButton>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function McpBrand({ server, compact = false }: { readonly server: McpServer; readonly compact?: boolean }) {
  return (
    <span className={`relative grid flex-none place-items-center overflow-hidden border border-line bg-surface font-semibold text-text-bright ${compact ? "size-6 rounded-md text-[10px]" : "size-8 rounded-lg text-[12px]"}`}>
      {server.displayName.slice(0, 1).toLocaleUpperCase()}
      {server.iconUrl !== null && (
        <img src={server.iconUrl} alt="" className="absolute inset-0 size-full object-cover" />
      )}
    </span>
  )
}

export function McpSettings({
  servers,
  parseError,
  loading,
  statuses,
  probing,
  probe,
  setEnabled,
  setAuth,
  setDisabledTools,
  signOut,
  remove,
  add,
  setApiKey,
  startAuthorization,
  reveal,
  logTail,
  importCandidates,
  applyImport
}: McpSettingsProps) {
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [authSetupServer, setAuthSetupServer] = React.useState<McpServer | null>(null)
  const [detailServer, setDetailServer] = React.useState<McpServer | null>(null)
  const [logLines, setLogLines] = React.useState<ReadonlyArray<string>>([])
  const [logLoading, setLogLoading] = React.useState(false)

  const openDetail = (server: McpServer) => {
    setDetailServer(server)
    setLogLines([])
    setLogLoading(true)
    void logTail(server.name)
      .then((result) => setLogLines(result.lines))
      .finally(() => setLogLoading(false))
  }


  const run = (action: () => Promise<void>) => {
    setActionError(null)
    void action().catch((cause) =>
      setActionError(cause instanceof Error ? cause.message : "MCP action failed")
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[13px] font-semibold text-text-bright">MCP servers</h3>
        <p className="mt-0.5 text-[11px] text-dim">
          Servers from <code className="font-mono">~/jingler/mcp.json</code> are available to
          local sessions. Edit the file directly or manage entries here — same file either way.
        </p>
      </div>

      {parseError ? (
        <Callout tone="red">
          mcp.json could not be read: {parseError}. Sessions run without these servers until
          it parses again.
        </Callout>
      ) : null}
      {actionError ? <div role="alert"><Callout tone="red">{actionError}</Callout></div> : null}

      {servers.length === 0 && !loading && parseError === null ? (
        <p className="text-[12px] text-dim">No servers configured yet.</p>
      ) : (
        <SettingsCard>
          {servers.map((server) => {
            const status = statusFor(statuses, server.name)
            const failed = status?.state === "failed"
            const toolCount = status?.toolCount ?? 0
            
            return (
              <SettingsRow
                key={server.name}
                label={
                  <div className="flex min-w-0 items-center gap-2">
                    <McpBrand server={server} compact />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-text-bright">{server.displayName}</div>
                      <div className="truncate font-mono text-[11px] text-dim">{server.target}</div>
                    </div>
                  </div>
                }
                help={
                  <div className="mt-1 flex flex-col gap-1">
                    {status ? (
                      <StatusRow failed={failed}>
                        {failed ? (status.error ?? "Connection failed") : `${toolCount} tool${toolCount === 1 ? "" : "s"}`}
                      </StatusRow>
                    ) : null}
                    {server.authState === "needs-auth" && (
                      <StatusRow>
                        Needs sign-in · <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => run(() => startAuthorization(server.name))}
                          className="inline h-auto px-0 py-0 hover:bg-transparent hover:underline"
                        >
                          Connect
                        </Button>
                      </StatusRow>
                    )}
                  </div>
                }
                control={
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => openDetail(server)}>
                      Details
                    </Button>
                    <Toggle
                      checked={server.enabled}
                      onCheckedChange={(checked) => run(() => setEnabled(server.name, checked))}
                      aria-label={`Enable ${server.name}`}
                    />
                    <Button variant="ghost" size="sm" onClick={() => run(() => remove(server.name))}>
                      Remove
                    </Button>
                  </div>
                }
              />
            )
          })}
        </SettingsCard>
      )}

      <div className="flex items-center gap-2">
        <AddServerForm add={add} setApiKey={setApiKey} />
        <Button variant="secondary" size="sm" onClick={probe} disabled={probing || servers.length === 0}>
          {probing ? "Testing…" : "Test connections"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => run(reveal)}>
          Reveal mcp.json
        </Button>
      </div>

      <ImportFlow importCandidates={importCandidates} applyImport={applyImport} />
      <McpAuthSetupDialog
        server={authSetupServer}
        open={authSetupServer !== null}
        onOpenChange={(open) => { if (!open) setAuthSetupServer(null) }}
        setAuth={setAuth}
        setApiKey={setApiKey}
        startAuthorization={startAuthorization}
      />
      <McpServerDetailDialog
        server={detailServer}
        open={detailServer !== null}
        onOpenChange={(open) => { if (!open) setDetailServer(null) }}
        toolCount={detailServer === null ? null : (statusFor(statuses, detailServer.name)?.toolCount ?? null)}
        toolNames={detailServer === null ? [] : (statusFor(statuses, detailServer.name)?.toolNames ?? [])}
        logLines={logLines}
        logLoading={logLoading}
        oauthAccount={
          detailServer !== null && detailServer.authKind === "oauth" && detailServer.authState === "ready"
            ? detailServer.displayName
            : null
        }
        disabledTools={detailServer?.disabledTools ?? []}
        onToggleTool={(toolName, enabled) => {
          if (detailServer === null) return
          const current = new Set(detailServer.disabledTools ?? [])
          if (enabled) current.delete(toolName)
          else current.add(toolName)
          const next = [...current]
          setDetailServer({ ...detailServer, disabledTools: next })
          run(() => setDisabledTools(detailServer.name, next))
        }}
        onSignOut={
          detailServer === null
            ? undefined
            : () => {
                const target = detailServer
                run(async () => {
                  await signOut(target.name)
                  setDetailServer(null)
                })
              }
        }
      />
    </div>
  )
}
