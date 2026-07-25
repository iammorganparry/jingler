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
  /**
   * This message is being handed to the running turn right now.
   *
   * It stays in the list — it has not been confirmed yet — but it stops being the
   * operator's to act on, because the agent already has the text. Acting on it
   * would run the same prompt twice: hand-off in particular would start it again
   * in a fresh chat.
   */
  readonly sending?: boolean
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
  handoffHint,
  sending = false
}: QueuedMessageRowProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

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
        {sending ? "Sending" : "Queued"}
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
          /*
            Commit when focus leaves the ROW, not merely the input. Tab moves it
            to Save and then Cancel, and committing on that first move made both
            buttons unreachable from the keyboard: the row left edit mode before
            either could be activated, so a keyboard-only operator reaching for the
            visible Cancel control SAVED the edit instead. Escape was the only
            cancel that worked, and nothing on screen said so.
          */
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
      {/* One tight cluster rather than four evenly-spaced glyphs: the row's own
          `gap-2` would space them like separate controls, which reads as four
          unrelated buttons instead of this message's toolbar. */}
      <div className="-mr-1.5 flex flex-none items-center gap-0.5">
      {sending ? (
        // No actions at all while it is in flight. Not disabled buttons: there is
        // nothing to re-enable, because the next state is the row disappearing.
        // Anything offered here would act on a message the agent already has.
        null
      ) : editing ? (
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
            Both handlers, because they cover different inputs. `onMouseDown` with
            `preventDefault` stops the blur ever happening for a pointer — some
            browsers do not focus a button on click, so the relatedTarget check
            above cannot be relied on there. `onClick` is what Enter and Space fire.
            Whichever runs first wins; the second is a no-op on a row that has
            already left edit mode.
          */}
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault()
              cancel()
            }}
            onClick={cancel}
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
