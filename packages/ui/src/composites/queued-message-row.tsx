import { useEffect, useRef, useState } from "react"
import { Check, Forward, ImageIcon, Pencil, SendHorizontal, X } from "lucide-react"
import { cn } from "../lib/cn.js"
import { Button } from "../components/button.js"
import { Tooltip } from "../components/tooltip.js"

/**
 * One pending message in the composer's queue.
 *
 * The actions are icon buttons with tooltips. Each action shows its purpose
 * on hover and has an accessible label for screen readers and test automation.
 */
export interface QueuedMessageRowProps {
  /** The queued text; empty means an image-only message. */
  readonly text: string
  /** How many images ride along with it. */
  readonly images: number
  /** Steer the running agent with this message now. Omit to hide the action. */
  readonly onSendNow?: () => void
  /** Fork this message into a fresh chat instead of this one. */
  readonly onHandoff?: () => void
  /** Rewrite the message in place, before it is ever sent. */
  readonly onEdit?: (text: string) => void
  /** Drop it from the queue. */
  readonly onRemove?: () => void
  /** What the hand-off will actually do, for the tooltip (the target model). */
  readonly handoffHint?: string
  /**
   * This message is being handed to the running turn right now.
   *
   * It stays in the list — it has not been confirmed yet — but it stops being the
   * operator's to act on, because the agent already has the text. Acting on it
   * would run the same prompt twice: hand-off in particular would start it again
   * in a fresh chat.
   */
  readonly sending?: boolean
  /** Held back because the device is offline; it sends on reconnect. */
  readonly waiting?: boolean
}

function EditActions({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }) {
  return (
    <>
      <Tooltip label="Save edit">
        <Button size="icon" variant="ghost" onClick={onSave} title="Save edit" aria-label="Save edit">
          <Check size={13} />
        </Button>
      </Tooltip>
      <Tooltip label="Cancel edit">
        <Button
          size="icon"
          variant="ghost"
          onMouseDown={(e) => {
            e.preventDefault()
            onCancel()
          }}
          onClick={onCancel}
          title="Cancel edit"
          aria-label="Cancel edit"
        >
          <X size={13} />
        </Button>
      </Tooltip>
    </>
  )
}

function IdleActions({
  onSendNow,
  onHandoff,
  onEdit,
  onRemove,
  handoffHint
}: {
  onSendNow?: () => void
  onHandoff?: () => void
  onEdit?: () => void
  onRemove?: () => void
  handoffHint?: string
}) {
  return (
    <>
      {onSendNow && (
        <Tooltip label="Send now — steer the agent immediately">
          <Button
            size="icon"
            variant="ghost"
            onClick={onSendNow}
            title="Send now — steer the agent immediately"
            aria-label="Send now — steer the agent immediately"
          >
            <SendHorizontal size={13} />
          </Button>
        </Tooltip>
      )}
      {onHandoff && (
        <Tooltip label={handoffHint ?? "Hand off — run this in a new chat"}>
          <Button
            size="icon"
            variant="ghost"
            onClick={onHandoff}
            title={handoffHint ?? "Hand off — run this in a new chat"}
            aria-label={handoffHint ?? "Hand off — run this in a new chat"}
          >
            <Forward size={13} />
          </Button>
        </Tooltip>
      )}
      {onEdit && (
        <Tooltip label="Edit queued message">
          <Button
            size="icon"
            variant="ghost"
            onClick={onEdit}
            title="Edit queued message"
            aria-label="Edit queued message"
          >
            <Pencil size={13} />
          </Button>
        </Tooltip>
      )}
      {onRemove && (
        <Tooltip label="Remove from queue">
          <Button
            size="icon"
            variant="ghost"
            onClick={onRemove}
            title="Remove from queue"
            aria-label="Remove from queue"
          >
            <X size={13} />
          </Button>
        </Tooltip>
      )}
    </>
  )
}

export function QueuedMessageRow({
  text,
  images,
  onSendNow,
  onHandoff,
  onEdit,
  onRemove,
  handoffHint,
  sending = false,
  waiting = false
}: QueuedMessageRowProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editing) setValue(text)
  }, [text, editing])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = () => {
    const next = value.trim()
    setEditing(false)
    if (next.length === 0 && images === 0) {
      setValue(text)
      onRemove?.()
      return
    }
    if (next === text) return
    onEdit?.(next)
  }

  const cancel = () => {
    setValue(text)
    setEditing(false)
  }

  return (
    <div
      ref={rowRef}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-line bg-sunken/60 px-3 py-1.5 text-[12.5px] text-muted-foreground",
        editing && "border-blue/40",
        sending && "border-blue/30"
      )}
    >
      <span
        className={cn(
          "flex-none font-mono text-[10px] uppercase tracking-wide",
          sending ? "text-blue" : "text-dim"
        )}
      >
        {sending ? "Sending" : waiting ? "Waiting for connection" : "Queued"}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          value={value}
          aria-label="Edit queued message"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
            if (e.key === "Escape") {
              e.preventDefault()
              cancel()
            }
          }}
          onBlur={(e) => {
            const next = e.relatedTarget
            if (next instanceof Node && rowRef.current?.contains(next)) return
            commit()
          }}
          className="min-w-0 flex-1 rounded bg-transparent text-text-bright outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-text-body">
          {text || <span className="text-dim">(image only)</span>}
        </span>
      )}
      {images > 0 && (
        <span className="flex flex-none items-center gap-1 font-mono text-[10.5px] text-cyan">
          <ImageIcon size={11} />
          {images}
        </span>
      )}
      <div className="-mr-1.5 flex flex-none items-center gap-0.5">
        {sending ? null : editing ? (
          <EditActions onSave={commit} onCancel={cancel} />
        ) : (
          <IdleActions
            onSendNow={onSendNow}
            onHandoff={onHandoff}
            onEdit={onEdit ? () => setEditing(true) : undefined}
            onRemove={onRemove}
            handoffHint={handoffHint}
          />
        )}
      </div>
    </div>
  )
}
