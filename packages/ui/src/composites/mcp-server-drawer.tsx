import * as React from "react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/dialog.js"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "../components/drawer.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { StatusDot } from "../components/status-dot.js"
import { Toggle } from "../components/toggle.js"
import type { McpConnectorRow } from "./mcp-connectors.js"
import { LogTail, ToolList } from "./mcp-server-detail-dialog.js"
import { McpBrand, McpServerForm, type McpSettingsProps } from "./mcp-settings.js"

export interface McpServerDrawerProps {
  readonly row: McpConnectorRow | null
  readonly onOpenChange: (open: boolean) => void
  readonly toolNames: ReadonlyArray<string>
  readonly disabledTools: ReadonlyArray<string>
  readonly onToggleTool: (name: string, enabled: boolean) => void
  readonly onEnabledChange: (enabled: boolean) => void
  readonly onReconnect: () => void
  readonly onTest: () => void
  readonly onRemove: () => void
  readonly logLines: ReadonlyArray<string>
  readonly logLoading?: boolean
  /** Last probe line, e.g. "POST /mcp → 401 Unauthorized"; never raw output. */
  readonly lastCheck?: string
  /** Clears a signed-in OAuth credential; absent hides Sign out. */
  readonly onSignOut?: () => void
  /** Last failed action (reconnect, test, remove); the page callout sits behind the drawer. */
  readonly error?: string | null
  /** Deletes the unsigned mcp.json copy a claude.ai row hides (`row.jinglerCopy`). */
  readonly onRemoveCopy?: (name: string) => void
}

type Tab = "overview" | "tools" | "logs"

const STATE_COPY = {
  "needs-auth": { tone: "bg-yellow", label: "Needs sign-in" },
  failed: { tone: "bg-red", label: "Failed" }
} as const

function DrawerOverview({
  row,
  native,
  onReconnect,
  lastCheck
}: {
  readonly row: McpConnectorRow
  readonly native: boolean
  readonly onReconnect: () => void
  readonly lastCheck: string | undefined
}) {
  const state = row.state === "needs-auth" || row.state === "failed" ? STATE_COPY[row.state] : { tone: "bg-green", label: "Connected" }
  const needsAuth = row.state === "needs-auth"
  return (
    <>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3.5 py-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={state.tone} size={6} />
          <span className="flex-1 text-[13px] font-medium text-text-bright">{state.label}</span>
          {needsAuth && <Button size="sm" onClick={onReconnect}>{native ? "Connect on claude.ai" : "Reconnect"}</Button>}
        </div>
        {needsAuth && (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {native
              ? "This connector signs in through claude.ai. Claude sessions pick it up once it's connected there."
              : "Reconnecting opens your browser for OAuth. Tokens go in the system keychain, never in mcp.json."}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.06em] text-dim">Available to</span>
        <span className="text-[12px] text-text-body">{row.agents}</span>
      </div>
      {lastCheck !== undefined && (
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-sunken px-3.5 py-3">
          <span className="text-[11px] uppercase tracking-[0.06em] text-dim">Last check</span>
          <span className="font-mono text-[11px] text-muted-foreground">{lastCheck}</span>
        </div>
      )}
    </>
  )
}

function JinglerCopyNotice({ name, onRemove }: { readonly name: string; readonly onRemove: (name: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <Callout>
        Your mcp.json also has an unsigned copy ({name}). Chats use this claude.ai connector instead, so the copy does nothing.
      </Callout>
      <Button variant="secondary" size="sm" className="self-start" onClick={() => onRemove(name)}>Remove Jingler copy</Button>
    </div>
  )
}

/** Board 25c: one server's auth, which agents use it, per-tool toggles and logs. */
export function McpServerDrawer({
  row,
  onOpenChange,
  toolNames,
  disabledTools,
  onToggleTool,
  onEnabledChange,
  onReconnect,
  onTest,
  onRemove,
  logLines,
  logLoading = false,
  lastCheck,
  onSignOut,
  error = null,
  onRemoveCopy
}: McpServerDrawerProps) {
  const [tab, setTab] = React.useState<Tab>("overview")
  const disabled = new Set(disabledTools)
  const on = toolNames.filter((name) => !disabled.has(name)).length
  // claude.ai connectors sign in on claude.ai; Jingler can only reconnect its own servers.
  const native = row?.source === "claude.ai"
  return (
    <Drawer open={row !== null} onOpenChange={onOpenChange}>
      {row !== null && (
        <DrawerContent className="w-[520px]">
          <div className="flex items-center gap-3 border-b border-line px-5 py-4 pr-14">
            <McpBrand server={row} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <DrawerTitle className="truncate text-[15px] font-semibold text-text-bright">{row.displayName}</DrawerTitle>
                <Badge size="xs">{row.source === "jingler" ? "Jingler" : row.source === "plugin" ? "Plugin" : "claude.ai"}</Badge>
              </div>
              <DrawerDescription className="truncate font-mono text-[11px] text-dim">{row.note ?? row.target}</DrawerDescription>
            </div>
            <Toggle checked={row.enabled} onCheckedChange={onEnabledChange} aria-label={`Enable ${row.displayName}`} />
          </div>
          <div className="border-b border-line px-5 py-2">
            <SegmentedControl<Tab>
              size="sm"
              aria-label="Server detail"
              value={tab}
              onChange={setTab}
              items={[
                { value: "overview", label: "Overview" },
                { value: "tools", label: toolNames.length > 0 ? `Tools ${on}/${toolNames.length}` : "Tools" },
                { value: "logs", label: "Logs" }
              ]}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            {error !== null && <div role="alert"><Callout tone="red">{error}</Callout></div>}
            {row.jinglerCopy !== undefined && onRemoveCopy && (
              <JinglerCopyNotice name={row.jinglerCopy} onRemove={onRemoveCopy} />
            )}
            {tab === "overview" && <DrawerOverview row={row} native={native} onReconnect={onReconnect} lastCheck={lastCheck} />}
            {tab === "tools" && <ToolList names={toolNames} disabled={disabled} onToggle={onToggleTool} />}
            {tab === "logs" && <LogTail lines={logLines} loading={logLoading} />}
          </div>
          <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
            <Button variant="ghost" size="sm" onClick={onRemove} disabled={native}>Remove server</Button>
            <div className="flex items-center gap-2">
              {onSignOut && <Button variant="ghost" size="sm" onClick={onSignOut}>Sign out</Button>}
              <Button variant="secondary" size="sm" onClick={onTest}>Test connection</Button>
            </div>
          </div>
        </DrawerContent>
      )}
    </Drawer>
  )
}

/** Board 25d: Add server, with the trust note and a way back to Discover. */
export function McpAddServerDialog({
  open,
  onOpenChange,
  add,
  setApiKey,
  onBrowse
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly add: McpSettingsProps["add"]
  readonly setApiKey?: McpSettingsProps["setApiKey"]
  readonly onBrowse?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>Saves to ~/jingler/mcp.json and works in every agent from the next turn.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <McpServerForm add={add} setApiKey={setApiKey} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
          <Callout>
            Only add servers from developers you trust. A server's tools can read and change data in the services you
            connect, and its tool descriptions go into every prompt.
          </Callout>
          {onBrowse && (
            <Button variant="ghost" size="sm" className="self-start" onClick={onBrowse}>Browse the registry instead</Button>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
