import { useEffect, useRef, useState } from "react"
import { Check, Forward, ImageIcon, Pencil, SendHorizontal, X } from "lucide-react"
import { cn } from "../lib/cn.js"

/**
 * One pending message in the composer's queue.
 *
 * The actions are ICON-ONLY on purpose. Four verbs (send now / hand off / edit /
 * remove) as words made a row that was mostly chrome and truncated the message
 * itself to nothing — and the message is the only part the operator cannot
 * reconstruct from memory. Each icon keeps a `title`, which is both the tooltip
 * and the accessible name the tests address rows by.
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
}

/**
 * Four 12px glyphs in a row are hard to tell apart at a glance, so each one
 * claims a 24px target (comfortable to hit without growing the row) and its own
 * hover colour — the colour is what makes "remove" unmistakably not "edit" in the
 * half-second before the tooltip appears.
 */
const ACTION =
  "flex size-6 flex-none items-center justify-center rounded text-dim outline-none transition-colors hover:bg-surface hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
const SEND = "text-blue hover:bg-blue/10 hover:text-blue"
const HANDOFF = "hover:bg-cyan/10 hover:text-cyan"
const REMOVE = "hover:bg-red/10 hover:text-red"

export function QueuedMessageRow({
  text,
  images,
  onSendNow,
  onHandoff,
  onEdit,
  onRemove,
  handoffHint
}: QueuedMessageRowProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)
  const inputRef = useRef<HTMLInputElement>(null)

  // Re-seed when the queue shifts a different message into this row: the row is
  // addressed positionally, so the same component can be handed new text.
  useEffect(() => {
    if (!editing) setValue(text)
  }, [text, editing])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = () => {
    const next = value.trim()
    setEditing(false)
    // An emptied message with no images has nothing left to send — that is a
    // remove, not an edit, and silently keeping the old text would read as the
    // edit having been ignored.
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
      className={cn(
        "flex items-center gap-2 rounded-lg border border-line bg-sunken/60 px-3 py-1.5 text-[12.5px] text-muted-foreground",
        editing && "border-blue/40"
      )}
    >
      <span className="flex-none font-mono text-[10px] uppercase tracking-wide text-dim">
        Queued
      </span>
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          value={value}
          aria-label="Edit queued message"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Stop Enter/Escape here: the composer and the view both bind them,
            // and an edit that also submitted the draft would be a nasty surprise.
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
          onBlur={commit}
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
      {/* One tight cluster rather than four evenly-spaced glyphs: the row's own
          `gap-2` would space them like separate controls, which reads as four
          unrelated buttons instead of this message's toolbar. */}
      <div className="-mr-1.5 flex flex-none items-center gap-0.5">
      {editing ? (
        <>
          <button
            type="button"
            onClick={commit}
            title="Save edit"
            className={cn(ACTION, "text-green hover:bg-green/10 hover:text-green")}
          >
            <Check size={13} />
          </button>
          {/*
            `onMouseDown` with `preventDefault`, not `onClick`: the input commits
            on blur, and mousedown on this button blurs it — so a plain click
            SAVED the edit it was meant to abandon, then unmounted before its own
            handler could run. Preventing the default stops the blur happening at all.
          */}
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault()
              cancel()
            }}
            title="Cancel edit"
            className={cn(ACTION, REMOVE)}
          >
            <X size={13} />
          </button>
        </>
      ) : (
        <>
          {onSendNow && (
            <button
              type="button"
              onClick={onSendNow}
              title="Send now — steer the agent immediately"
              className={cn(ACTION, SEND)}
            >
              <SendHorizontal size={13} />
            </button>
          )}
          {onHandoff && (
            <button
              type="button"
              onClick={onHandoff}
              title={handoffHint ?? "Hand off — run this in a new chat"}
              className={cn(ACTION, HANDOFF)}
            >
              <Forward size={13} />
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Edit queued message"
              className={ACTION}
            >
              <Pencil size={13} />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              title="Remove from queue"
              className={cn(ACTION, REMOVE)}
            >
              <X size={13} />
            </button>
          )}
        </>
      )}
      </div>
    </div>
  )
}
