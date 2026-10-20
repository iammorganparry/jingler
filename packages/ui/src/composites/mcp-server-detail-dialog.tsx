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
import { McpBrand } from "./mcp-settings.js"

/** How many tools the server reported on its last connection test; null = not tested or failed. */
export function ToolCount({ count }: { readonly count: number | null }) {
  return (
    <p className="text-[12px] text-text-body">
      {count === null ? "Run Test connections to list tools." : `${count} tool${count === 1 ? "" : "s"} available`}
    </p>
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

/** "OAuth · Signed in as …" row for an OAuth-authenticated server. */
export function OAuthRow({ account }: { readonly account: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-text-body">
      <span className="text-dim">OAuth</span>
      <span className="text-dim">·</span>
      <span>Signed in as {account}</span>
    </div>
  )
}

export interface McpServerDetailDialogProps {
  readonly server: McpServer | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly toolCount: number | null
  readonly logLines: ReadonlyArray<string>
  readonly logLoading: boolean
  readonly oauthAccount: string | null
}

/** Settings › MCP servers › one server's detail: tools, log tail, OAuth session. */
export function McpServerDetailDialog({
  server,
  open,
  onOpenChange,
  toolCount,
  logLines,
  logLoading,
  oauthAccount
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
            {oauthAccount !== null ? <OAuthRow account={oauthAccount} /> : null}
            <div>
              <h4 className="mb-1.5 text-[12px] font-semibold text-text-bright">Tools</h4>
              <ToolCount count={toolCount} />
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
