import type {
  McpConfigEntry,
  McpImportCandidateView,
  McpImportSourceId,
  McpRemoteAuth,
  McpServer,
  McpServerStatus
} from "@jingler/core"
import { Schema } from "effect"
import * as React from "react"
import { AsyncButton } from "../components/async-button.js"
import { Callout } from "../components/callout.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Input } from "../components/input.js"
import { Toggle } from "../components/toggle.js"

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
  readonly remove: (name: string) => Promise<void>
  readonly add: (name: string, entry: McpConfigEntry) => Promise<void>
  readonly setApiKey: (name: string, apiKey: string) => Promise<void>
  readonly startAuthorization: (name: string) => Promise<void>
  readonly reveal: () => Promise<void>
  /** Import flow: load candidates from one source, then apply a selection. */
  readonly importCandidates: (
    source: McpImportSourceId
  ) => Promise<ReadonlyArray<McpImportCandidateView>>
  readonly applyImport: (
    source: McpImportSourceId,
    names: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<string>>
}

const IMPORT_SOURCES: ReadonlyArray<{ id: McpImportSourceId; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "opencode" }
]

function renderMcpStatus(status: McpServerStatus | null) {
  return (status ? (
                    <span
                      className={`text-[10px] ${
                        status.state === "connected"
                          ? "text-green"
                          : status.state === "failed"
                            ? "text-red"
                            : "text-dim"
                      }`}
                    >
                      {status.state === "connected"
                        ? `connected — ${status.toolCount ?? 0} tools`
                        : status.state === "failed"
                          ? status.error ?? "failed"
                          : status.state}
                    </span>
                  ) : null)
}

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
    <div className="flex max-w-xl flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, e.g. context7"
          aria-label="Server name"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value === "local" ? "local" : "remote")}
          aria-label="Server type"
          className="h-11 rounded-xl border border-line bg-panel px-3.5 text-base text-text"
        >
          <option value="remote">Remote (URL)</option>
          <option value="local">Local (command)</option>
        </select>
      </div>
      <Input
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder={kind === "remote" ? "https://mcp.example.com/mcp" : '["npx", "-y", "some-mcp"]'}
        aria-label={kind === "remote" ? "Server URL" : "Server command"}
      />
      {kind === "remote" && (
        <div className="flex items-center gap-2">
          <select
            value={authKind}
            onChange={(event) => setAuthKind(event.target.value as typeof authKind)}
            aria-label="Authentication"
            className="h-11 rounded-xl border border-line bg-panel px-3.5 text-base text-text"
          >
            <option value="none">No authentication</option>
            <option value="api-key">API key</option>
            <option value="oauth">OAuth</option>
          </select>
          {authKind === "api-key" && (
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
              <Input
                value={apiKeyHeader}
                onChange={(event) => setApiKeyHeader(event.target.value)}
                placeholder="Header"
                aria-label="API key header"
              />
              <Input
                value={apiKeyPrefix}
                onChange={(event) => setApiKeyPrefix(event.target.value)}
                placeholder="Prefix (optional)"
                aria-label="API key prefix"
              />
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKeyValue(event.target.value)}
                placeholder="API key"
                aria-label="API key"
                className="col-span-2"
              />
            </div>
          )}
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">
          {kind === "remote" ? "Headers" : "Environment"} — one KEY=value per line.
          Use {"{env:VAR}"} to read a value from the environment.
        </span>
        <textarea
          value={pairs}
          onChange={(e) => setPairs(e.target.value)}
          rows={2}
          className="rounded-xl border border-line bg-panel px-3.5 py-2.5 font-mono text-[11px] text-text outline-none focus:border-text-bright/40 focus:ring-2 focus:ring-ring/40"
          aria-label={kind === "remote" ? "Headers" : "Environment variables"}
        />
      </label>
      {error ? <div role="alert"><Callout tone="red">{error}</Callout></div> : null}
      <div className="flex items-center gap-2">
        <AsyncButton pendingLabel="Saving…" onClick={submit}>
          Save server
        </AsyncButton>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-dim hover:underline"
        >
          Cancel
        </button>
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
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="self-start rounded-md border border-line bg-panel px-3 py-1.5 text-[12px] text-text hover:bg-surface"
    >
      Add server
    </button>
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

function ImportFlow({
  importCandidates,
  applyImport
}: Pick<McpSettingsProps, "importCandidates" | "applyImport">) {
  const [source, setSource] = React.useState<McpImportSourceId | null>(null)
  const [candidates, setCandidates] = React.useState<ReadonlyArray<McpImportCandidateView> | null>(null)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = async (next: McpImportSourceId) => {
    setError(null)
    setMessage(null)
    try {
      const found = await importCandidates(next)
      setSource(next)
      setCandidates(found)
      setSelected(new Set(found.filter((c) => c.problem === null).map((c) => c.name)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not read the ${next} config`)
    }
  }

  const apply = async () => {
    if (source === null) return
    setError(null)
    try {
      const imported = await applyImport(source, [...selected])
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
          <button
            key={id}
            type="button"
            onClick={() => void load(id)}
            className="rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-text hover:bg-surface"
          >
            {label}
          </button>
        ))}
      </div>
      {error ? <div role="alert"><Callout tone="red">{error}</Callout></div> : null}
      {message ? <Callout tone="green">{message}</Callout> : null}
      {candidates !== null ? (
        candidates.length === 0 ? (
          <Callout tone="blue">No MCP servers found in the {source} config.</Callout>
        ) : (
          <div className="flex max-w-xl flex-col gap-1 rounded-md border border-line bg-panel p-3">
            {candidates.map((candidate) => (
              <label key={candidate.name} className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  disabled={candidate.problem !== null}
                  checked={selected.has(candidate.name)}
                  onChange={(e) => {
                    const next = new Set(selected)
                    if (e.target.checked) next.add(candidate.name)
                    else next.delete(candidate.name)
                    setSelected(next)
                  }}
                />
                <span className="text-text-body">{candidate.name}</span>
                <span className="min-w-0 truncate font-mono text-[10px] text-dim">
                  {candidate.problem ?? candidate.target}
                </span>
              </label>
            ))}
            <div className="mt-2 flex items-center gap-2">
              <AsyncButton pendingLabel="Importing…" onClick={apply} disabled={selected.size === 0}>
                Import {selected.size} server{selected.size === 1 ? "" : "s"}
              </AsyncButton>
              <button
                type="button"
                onClick={() => {
                  setCandidates(null)
                  setSource(null)
                }}
                className="text-[11px] text-dim hover:underline"
              >
                Cancel
              </button>
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
          <div className="flex flex-col gap-3">
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} aria-label="Authentication method" className="h-11 rounded-xl border border-line bg-panel px-3.5 text-base text-text">
              <option value="oauth">OAuth</option>
              <option value="api-key">API key</option>
            </select>
            {kind === "api-key" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Input value={header} onChange={(event) => setHeader(event.target.value)} aria-label="API key header" />
                  <Input value={prefix} onChange={(event) => setPrefix(event.target.value)} aria-label="API key prefix" />
                </div>
                <Input type="password" value={apiKey} onChange={(event) => setApiKeyValue(event.target.value)} aria-label={`API key for ${server.displayName}`} />
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
            <Input type="password" value={apiKey} onChange={(event) => setApiKeyValue(event.target.value)} aria-label={`API key for ${server.displayName}`} autoFocus />
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

function McpAuthAction({
  server,
  setApiKey,
  startAuthorization,
  onConfigure,
  onError
}: {
  readonly server: McpServer
  readonly setApiKey: McpSettingsProps["setApiKey"]
  readonly startAuthorization: McpSettingsProps["startAuthorization"]
  readonly onConfigure: (server: McpServer) => void
  readonly onError: (message: string) => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [apiKey, setApiKeyValue] = React.useState("")
  if (server.authKind === "none") {
    return server.transport === "http" ? (
      <button type="button" onClick={() => onConfigure(server)} className="text-[11px] text-blue hover:underline">
        Set up auth
      </button>
    ) : null
  }
  if (server.authKind === "oauth") {
    return (
      <AsyncButton
        pendingLabel="Opening…"
        onClick={() => startAuthorization(server.name).catch((cause) => {
          const message = cause instanceof Error ? cause.message : "Authorization failed"
          onError(message)
          throw cause
        })}
      >
        {server.authState === "ready" ? "Reauthorize" : "Authorize"}
      </AsyncButton>
    )
  }
  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-[11px] text-blue hover:underline">
        {server.authState === "ready" ? "Replace key" : "Add key"}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="password"
        value={apiKey}
        onChange={(event) => setApiKeyValue(event.target.value)}
        aria-label={`API key for ${server.displayName}`}
        className="h-8 w-36"
      />
      <AsyncButton
        disabled={apiKey.length === 0}
        pendingLabel="Saving…"
        onClick={() => setApiKey(server.name, apiKey).then(() => {
          setApiKeyValue("")
          setEditing(false)
        }).catch((cause) => {
          const message = cause instanceof Error ? cause.message : "Could not save API key"
          onError(message)
          throw cause
        })}
      >Save</AsyncButton>
    </div>
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
  remove,
  add,
  setApiKey,
  startAuthorization,
  reveal,
  importCandidates,
  applyImport
}: McpSettingsProps) {
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [authSetupServer, setAuthSetupServer] = React.useState<McpServer | null>(null)
  const run = (action: () => Promise<void>) => {
    setActionError(null)
    void action().catch((cause) =>
      setActionError(cause instanceof Error ? cause.message : "MCP action failed")
    )
  }

  const renderMcpServer = ((server) => {
          const status = statusFor(statuses, server.name)
          return (
            <div
              key={server.name}
              className="flex max-w-xl items-center gap-3 rounded-md border border-line bg-panel px-3 py-2"
            >
              <McpBrand server={server} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-medium text-text-body">{server.name}</span>
                  <span className="text-[10px] uppercase text-dim">{server.transport}</span>
                  {renderMcpStatus(status)}
                </div>
                <div className="truncate font-mono text-[10px] text-dim">{server.target}</div>
              </div>
              <McpAuthAction
                server={server}
                setApiKey={setApiKey}
                startAuthorization={startAuthorization}
                onConfigure={setAuthSetupServer}
                onError={setActionError}
              />
              <Toggle
                checked={server.enabled}
                onCheckedChange={(checked) => run(() => setEnabled(server.name, checked))}
                aria-label={`Enable ${server.name}`}
              />
              <button
                type="button"
                onClick={() => run(() => remove(server.name))}
                className="text-[11px] text-red hover:underline"
              >
                Remove
              </button>
            </div>
          )
        }) satisfies  Parameters<typeof servers.map>[0]

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

      <div className="flex flex-col gap-1">
        {servers.length === 0 && !loading && parseError === null ? (
          <p className="text-[12px] text-dim">No servers configured yet.</p>
        ) : null}
        {servers.map(renderMcpServer)}
      </div>

      <div className="flex items-center gap-2">
        <AddServerForm add={add} setApiKey={setApiKey} />
        <button
          type="button"
          onClick={probe}
          disabled={probing || servers.length === 0}
          className="rounded-md border border-line bg-panel px-3 py-1.5 text-[12px] text-text hover:bg-surface disabled:opacity-50"
        >
          {probing ? "Testing…" : "Test connections"}
        </button>
        <button
          type="button"
          onClick={() => run(reveal)}
          className="text-[11px] text-blue hover:underline"
        >
          Reveal mcp.json
        </button>
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
    </div>
  )
}
