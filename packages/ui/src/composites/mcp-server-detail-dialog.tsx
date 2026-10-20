import type { McpServer } from "@jingler/core"
import * as React from "react"
import { Button } from "../components/button.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Toggle } from "../components/toggle.js"
import { McpBrand } from "./mcp-settings.js"

export interface McpToolToggle {
  readonly name: string
  readonly enabled: boolean
}

/** Per-tool enable/disable list for one MCP server. */
export function ToolList({
  tools,
  onToggle
}: {
  readonly tools: ReadonlyArray<McpToolToggle>
  readonly onToggle: (tool: string, enabled: boolean) => void
}) {
  if (tools.length === 0) {
    return <p className="text-[12px] text-dim">No tools reported yet.</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {tools.map((tool) => (
        <li key={tool.name} className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[12px] text-text-body">{tool.name}</span>
          <Toggle
            checked={tool.enabled}
            onCheckedChange={(checked) => onToggle(tool.name, checked)}
            aria-label={`Enable tool ${tool.name}`}
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

/** "OAuth · Signed in as … · Sign out" row for an OAuth-authenticated server. */
export function OAuthRow({
  account,
  onSignOut
}: {
  readonly account: string
  readonly onSignOut: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-text-body">
      <span className="text-dim">OAuth</span>
      <span className="text-dim">·</span>
      <span>Signed in as {account}</span>
      <span className="text-dim">·</span>
      <Button variant="ghost" size="sm" onClick={onSignOut} className="h-auto px-0 py-0 hover:bg-transparent hover:underline">
        Sign out
      </Button>
    </div>
  )
}

export interface McpServerDetailDialogProps {
  readonly server: McpServer | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly tools: ReadonlyArray<McpToolToggle>
  readonly onToggleTool: (tool: string, enabled: boolean) => void
  readonly logLines: ReadonlyArray<string>
  readonly logLoading: boolean
  readonly oauthAccount: string | null
  readonly onSignOut: () => void
}

/** Settings › MCP servers › one server's detail: tools, log tail, OAuth session. */
export function McpServerDetailDialog({
  server,
  open,
  onOpenChange,
  tools,
  onToggleTool,
  logLines,
  logLoading,
  oauthAccount,
  onSignOut
}: McpServerDetailDialogProps) {
  if (server === null) return null
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
              <ToolList tools={tools} onToggle={onToggleTool} />
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
