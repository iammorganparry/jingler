import type { McpServer } from "@jingler/core"
import * as React from "react"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Button } from "../components/button.js"
import { Toggle } from "../components/toggle.js"
import { McpBrand } from "./mcp-settings.js"

/** How many tools the server reported on its last connection test; null = not tested or failed. */
export function ToolCount({ count }: { readonly count: number | null }) {
  return (
    <p className="text-[12px] text-text-body">
      {count === null ? "Run Test connections to list tools." : `${count} tool${count === 1 ? "" : "s"} available`}
    </p>
  )
}

/** Per-tool enable toggles, shown once the probe has reported real tool names. */
export function ToolList({
  names,
  disabled,
  onToggle
}: {
  readonly names: ReadonlyArray<string>
  readonly disabled: ReadonlySet<string>
  readonly onToggle: (name: string, enabled: boolean) => void
}) {
  if (names.length === 0) return <ToolCount count={null} />
  return (
    <ul className="flex flex-col gap-1.5">
      {names.map((name) => (
        <li key={name} className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[12px] text-text-body">{name}</span>
          <Toggle
            checked={!disabled.has(name)}
            onCheckedChange={(checked) => onToggle(name, checked)}
            aria-label={`Enable tool ${name}`}
          />
        </li>
      ))}
    </ul>
  )
}

/** Recent stdio stderr lines for one server, refreshed when the dialog opens. */
export function LogTail({
  lines,
  loading
}: {
  readonly lines: ReadonlyArray<string>
  readonly loading: boolean
}) {
  return (
    <div
      role="log"
      aria-label="Server log"
      aria-busy={loading}
      className="max-h-48 min-h-[3rem] overflow-y-auto rounded-md border border-line bg-surface p-2 font-mono text-[11px] text-dim"
    >
      {loading && lines.length === 0 ? (
        <span>Loading…</span>
      ) : lines.length === 0 ? (
        <span>No log output.</span>
      ) : (
        lines.map((line, index) => <div key={index}>{line}</div>)
      )}
    </div>
  )
}

/** "OAuth · Signed in as …" row for an OAuth-authenticated server, with a real Sign out action. */
export function OAuthRow({
  account,
  onSignOut
}: {
  readonly account: string
  readonly onSignOut?: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-text-body">
      <span className="text-dim">OAuth</span>
      <span className="text-dim">·</span>
      <span>Signed in as {account}</span>
      {onSignOut !== undefined && (
        <>
          <span className="text-dim">·</span>
          <Button variant="danger" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </>
      )}
    </div>
  )
}

export interface McpServerDetailDialogProps {
  readonly server: McpServer | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly toolCount: number | null
  /** Real tool names from the last probe; empty until the server has been tested. */
  readonly toolNames?: ReadonlyArray<string>
  readonly logLines: ReadonlyArray<string>
  readonly logLoading: boolean
  readonly oauthAccount: string | null
  /** Tool names the operator has turned off for this server. */
  readonly disabledTools?: ReadonlyArray<string>
  /** Persist a per-tool toggle; absent hides the toggles (e.g. before `disabledTools` is known). */
  readonly onToggleTool?: (name: string, enabled: boolean) => void
  /** Clears the server's stored OAuth credential only. Absent hides the Sign out control. */
  readonly onSignOut?: () => void
}

/** Settings › MCP servers › one server's detail: tools, log tail, OAuth session. */
export function McpServerDetailDialog({
  server,
  open,
  onOpenChange,
  toolCount,
  toolNames = [],
  logLines,
  logLoading,
  oauthAccount,
  disabledTools = [],
  onToggleTool,
  onSignOut
}: McpServerDetailDialogProps) {
  if (server === null) return null
  const disabledSet = new Set(disabledTools)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <McpBrand server={server} compact />
            <DialogTitle>{server.displayName}</DialogTitle>
          </div>
          <DialogDescription>{server.target}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            {oauthAccount !== null ? <OAuthRow account={oauthAccount} onSignOut={onSignOut} /> : null}
            <div>
              <h4 className="mb-1.5 text-[12px] font-semibold text-text-bright">Tools</h4>
              {toolNames.length > 0 && onToggleTool !== undefined ? (
                <ToolList names={toolNames} disabled={disabledSet} onToggle={onToggleTool} />
              ) : (
                <ToolCount count={toolCount} />
              )}
            </div>
            <div>
              <h4 className="mb-1.5 text-[12px] font-semibold text-text-bright">Log</h4>
              <LogTail lines={logLines} loading={logLoading} />
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
