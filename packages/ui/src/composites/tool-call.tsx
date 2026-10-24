import type { ReactNode } from "react"
import { Check, ChevronDown, ChevronRight, CircleStop, LoaderCircle, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Spin } from "../components/spin.js"
import { FileIcon } from "../components/file-icon.js"
import { Button } from "../components/button.js"
import { useOpenPath } from "../asset/open-asset-context.js"
import { ToolResultSurface } from "./beui/work.js"

export type ToolCallStatus = "success" | "running" | "error"

export interface ToolCallLabelInput {
  readonly toolName: string
  readonly args?: Record<string, unknown> | null
  readonly intent?: string | null
  readonly cwd?: string | null
}

export interface ToolCallLabelResult {
  readonly title: string
  readonly detail: string | null
}

/** The session's own cwd prefix on a Bash command is noise, not information. */
const stripCwdPrefix = (text: string, cwd?: string | null): string => {
  if (!cwd) return text
  const prefix = `cd ${cwd} && `
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

const TRAILING_SLASHES = /\/+$/
const WHITESPACE = /\s+/u

const baseName = (path: string): string => {
  const cut = path.replace(TRAILING_SLASHES, "").lastIndexOf("/")
  return cut < 0 ? path : path.slice(cut + 1)
}

const toolCallDetail = (
  args: Record<string, unknown> | null | undefined,
  cwd?: string | null
): string | null => {
  const raw = typeof args?.command === "string"
    ? args.command
    : typeof args?.path === "string"
      ? args.path
      : null
  return raw === null ? null : stripCwdPrefix(raw, cwd)
}

/**
 * A tool call's title and secondary line. `intent` (agent-written, present
 * tense) always wins the title when present; otherwise derive a label from
 * the tool name and its arguments so the row never shows a bare `cd … && …`.
 */
export function toolCallLabel({ toolName, args, intent, cwd }: ToolCallLabelInput): ToolCallLabelResult {
  const detail = toolCallDetail(args, cwd)
  if (intent) return { title: intent, detail }
  switch (toolName) {
    case "command_execute": {
      const command = typeof args?.command === "string" ? stripCwdPrefix(args.command, cwd) : ""
      const firstWord = command.trim().split(WHITESPACE)[0] ?? ""
      return { title: firstWord ? `Ran \`${firstWord}\`` : "Ran command", detail }
    }
    case "workspace_read_file": {
      const path = typeof args?.path === "string" ? args.path : ""
      return { title: path ? `Read \`${baseName(path)}\`` : "Read file", detail }
    }
    case "workspace_edit":
    case "workspace_write": {
      const path = typeof args?.path === "string" ? args.path : ""
      return { title: path ? `Edited \`${baseName(path)}\`` : "Edited file", detail }
    }
    case "jingler_set_work_mode": {
      const mode = args?.mode === "build" ? "Build" : "Plan"
      const reason = typeof args?.reason === "string" ? args.reason : ""
      return { title: reason ? `Switched to ${mode} — ${reason}` : `Switched to ${mode}`, detail: null }
    }
    default:
      return { title: toolName, detail }
  }
}

export interface ToolCallProps {
  status: ToolCallStatus
  /** Tool name, e.g. "Read", "Grep", "Bash". */
  name: string
  /** Primary target — file path or query. */
  target?: ReactNode
  /** Trailing meta, e.g. line count or "exit 1". */
  meta?: ReactNode
  /** Show a file-type glyph before the target (when `target` is a path). */
  filePath?: string | null
  /** Inline body under the header — e.g. a `DiffPeek` for an edit. */
  children?: ReactNode
  icon?: ReactNode
  /**
   * Make the header a toggle. The host owns the open state (so it can keep
   * rendering the right body); given this, the whole header becomes a button.
   */
  expanded?: boolean
  onToggle?: () => void
  /**
   * Interrupt a long-running tool (a Bash command can hang for minutes). Shown
   * as a stop button on the header only while `status` is "running".
   */
  onStop?: () => void
  /**
   * Second line under the header — the raw command/path once `target` is an
   * agent-written intent. Mono, dim, truncated; the full text still lives in
   * the expanded body below.
   */
  detail?: ReactNode
  /** A failed MCP call that needs auth: shows a sign-in action on the row. */
  signIn?: { readonly label: string; readonly onClick: () => void }
  className?: string
}

/**
 * Split a path for display: the directory, and the file itself.
 *
 * These paths are absolute inside a session's worktree, so the first ~60
 * characters are the same on every card and the only part anyone reads — the
 * filename — sits at the END. A plain `truncate` ellipsises the tail, which
 * throws away precisely that and leaves a row of identical prefixes.
 */
const splitPath = (path: string): { dir: string; base: string } => {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/")
  return cut <= 0
    ? { dir: "", base: path }
    : { dir: path.slice(0, cut), base: path.slice(cut + 1) }
}

/**
 * The target as a path: a directory that gives way, and a filename that never does.
 *
 * When the file is one we can show, the filename becomes a button that opens it
 * in the Preview dock. This is the highest-signal of the three click targets —
 * `filePath` is structured data straight off the tool call, so there is no
 * guessing involved, and a `Write` card is literally the moment the agent
 * created the thing you want to look at.
 *
 * The DIRECTORY stays inert on purpose. It is the part that truncates, so it is
 * routinely half a path, and making a fragment clickable would be a lie.
 */
function PathTarget({ path }: { path: string }) {
  const { dir, base } = splitPath(path)
  const open = useOpenPath(path)
  // `flex-none` so the directory is what shrinks; the filename is the point of
  // the card. It still truncates if it alone can't fit — better a cut filename
  // than one pushed out of the row entirely.
  const nameClass = "max-w-full flex-none truncate text-text-bright"
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      {dir && <span className="truncate text-dim">{dir}/</span>}
      {open ? (
        // A span with `role="button"`, NOT a real <button>. On an expandable
        // card the whole header already IS a <button>, and a nested one is
        // invalid HTML that browsers fix by hoisting it out of its parent —
        // the filename would jump out of the row it belongs to.
        <span
          role="button"
          tabIndex={0}
          title={`Open ${base}`}
          onClick={(e) => {
            // The header is a toggle; without this, opening the file would also
            // collapse the card underneath it.
            e.stopPropagation()
            open()
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return
            e.preventDefault()
            e.stopPropagation()
            open()
          }}
          className={cn(
            nameClass,
            "cursor-pointer rounded-[3px] underline-offset-2 outline-none hover:text-text-bright hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {base}
        </span>
      ) : (
        <span className={nameClass}>{base}</span>
      )}
    </span>
  )
}

/** A single agent tool invocation (success / running / error), with optional peek. */
export function ToolCall({
  status,
  name,
  target,
  meta,
  filePath,
  children,
  icon,
  expanded = false,
  onToggle,
  onStop,
  detail,
  signIn,
  className
}: ToolCallProps) {
         function renderToolHeading() {
           return (<>
      {status === "success" && <Check className="size-3 flex-none text-dim" />}
      {status === "error" && <X className="size-3 flex-none text-state-failed" />}
      {status === "running" && (
        <Spin active className="flex-none">
          <LoaderCircle className="size-3 text-muted-foreground" />
        </Spin>
      )}
      <span className="text-muted-foreground">{name}</span>
      {icon}
      {filePath && <FileIcon path={filePath} />}
      {filePath ? (
        <PathTarget path={filePath} />
      ) : (
        <span className="flex-1 truncate text-left text-text-bright">{target}</span>
      )}
      {meta && (
        <span className="shrink-0 text-dim">{meta}</span>
      )}
      {onToggle &&
        (expanded ? (
          <ChevronDown className="size-3 shrink-0 text-line-strong" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-line-strong" />
        ))}
    </>)
         }

  const header = (
    <>
      <div className={cn("flex items-center gap-[9px]", detail ? "font-sans text-text-bright" : "font-mono")}>
        {renderToolHeading()}
      </div>
      {detail && (
        <div className="truncate pl-[21px] font-mono text-[11px] text-dim">{detail}</div>
      )}
    </>
  )
  const headerClass = cn(
    "flex w-full flex-col gap-0.5 px-2.5 py-1 text-left text-[12px]",
    onToggle && "cursor-pointer transition-colors hover:bg-hover"
  )
  return (
    <ToolResultSurface
      className={cn(
        "rounded-[6px] border-hairline bg-transparent",
        className
      )}
      data-tool-status={status}
    >
      <div className="flex items-stretch">
        {onToggle ? (
          <Button
            variant="ghost"
            onClick={onToggle}
            aria-expanded={expanded}
            className={cn(headerClass, "h-auto min-w-0 flex-1 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring")}
          >
            {header}
          </Button>
        ) : (
          <div className={cn(headerClass, "min-w-0 flex-1")}>{header}</div>
        )}
        {signIn && status === "error" && (
          <Button variant="ghost" size="sm" onClick={signIn.onClick} className="my-auto mr-2 flex-none">
            {signIn.label}
          </Button>
        )}
        {onStop && status === "running" && (
          <Button
            variant="ghost"
            onClick={onStop}
            aria-label="Stop tool"
            title="Stop"
            className="h-auto flex-none rounded-none px-2.5 text-state-failed outline-none hover:bg-state-failed/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <CircleStop className="size-3.5" />
          </Button>
        )}
      </div>
      {/* While running with no peek yet, a shimmer bar signals live work. */}
      {status === "running" && children == null && (
        <div className="h-[22px] animate-shine bg-[length:220px_100%] bg-gradient-to-r from-transparent via-hover to-transparent" />
      )}
      {children}
    </ToolResultSurface>
  )
}
