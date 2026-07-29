import { sanitizePlanHtml } from "@jingler/core"
import type { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { Bold, Code, Italic, MessageSquarePlus, Send } from "lucide-react"
import type { ComponentType, MouseEvent as ReactMouseEvent } from "react"
import { useEffect, useRef, useState } from "react"
import { HoverCard } from "../../components/hover-card.js"
import { cn } from "../../lib/cn.js"
import { applyPlanComment } from "./plan-doc-comment.js"
import { planDocExtensions } from "./plan-doc-extensions.js"
import {
  type PlanWorkerControls,
  PlanWorkerControlsProvider
} from "./plan-worker-controls.js"

/**
 * Full-document WYSIWYG editor for an HTML plan, rendered as a Notion-like doc.
 *
 * There is no insert toolbar: blocks and plan widgets are added through the `/`
 * command menu (see `plan-doc-slash.tsx`), and selecting text raises a bubble
 * menu for inline formatting and anchored comments (see below). The editor
 * therefore renders as just the document.
 *
 * The editor is created once; `onChange` is read through a ref so its latest
 * closure fires without tearing down and recreating the ProseMirror instance
 * (which would drop selection and focus on each parent render). On every edit
 * the HTML is serialized and re-run through `sanitizePlanHtml` as
 * defense-in-depth before it leaves the component — the persisted string is
 * always the safe subset, never raw editor output.
 *
 * An external `value` change (a remote revision, a conflict resolution) is
 * pushed in with `emitUpdate: false` so syncing down never loops back as a fake
 * edit; the guard compares sanitized forms so cosmetic serializer differences
 * don't trigger a needless reset that would drop the cursor.
 */
export function PlanDocEditor({
  value,
  onChange,
  editable = true,
  className,
  workerControls
}: {
  value: string
  onChange?: (html: string) => void
  editable?: boolean
  className?: string
  workerControls?: PlanWorkerControls
}) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    editable,
    extensions: planDocExtensions(),
    content: value,
    editorProps: {
      attributes: {
        class: "sb-md min-h-[8rem] px-4 py-3 outline-none",
        "aria-label": "Plan document"
      }
    },
    onUpdate: ({ editor }) => onChangeRef.current?.(sanitizePlanHtml(editor.getHTML()))
  })

  useEffect(() => {
    if (!editor) return
    if (sanitizePlanHtml(value) !== sanitizePlanHtml(editor.getHTML())) {
      editor.commands.setContent(value, { emitUpdate: false })
    }
  }, [editor, value])

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  return (
    <PlanWorkerControlsProvider controls={workerControls}>
      <div className={cn("flex min-h-0 flex-col", className)}>
        {editable && editor && <CommentBubbleMenu editor={editor} />}
        <EditorContent
          editor={editor}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto text-[13px] leading-[1.65] text-text-body [&_.ProseMirror]:outline-none",
            !editable && "opacity-95"
          )}
        />
      </div>
    </PlanWorkerControlsProvider>
  )
}

/**
 * The selection bubble menu: inline formatting (Bold/Italic/Code) plus a
 * primary **Comment** action that opens an inline composer. Submitting the
 * composer highlights the selection and drops an anchored `planAnnotation`
 * (see `applyPlanComment`).
 *
 * The selection is captured the moment **Comment** is clicked, not read at
 * submit time: focusing the composer input blurs the editor, and reading the
 * live selection then would be empty. `shouldShow` keeps the menu up while the
 * composer is open even though the DOM selection has moved into the input.
 */
function CommentBubbleMenu({ editor }: { editor: Editor }) {
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState("")
  const range = useRef<{ from: number; to: number } | null>(null)
  const composingRef = useRef(false)
  composingRef.current = composing
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (composing) inputRef.current?.focus()
  }, [composing])

  const startComment = () => {
    const { from, to } = editor.state.selection
    range.current = { from, to }
    setDraft("")
    setComposing(true)
  }

  const cancel = () => {
    setComposing(false)
    setDraft("")
    range.current = null
  }

  const submit = () => {
    const captured = range.current
    if (captured && captured.from !== captured.to) {
      applyPlanComment(editor, { from: captured.from, to: captured.to, body: draft.trim() })
    }
    cancel()
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor }) => {
        const { from, to } = editor.state.selection
        return composingRef.current || (editor.isEditable && from < to)
      }}
    >
      <div className="flex items-center gap-1 rounded-[10px] border border-line bg-panel p-1 shadow-lg">
        {composing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancel()
              }}
              placeholder="Add a comment…"
              aria-label="Comment"
              className="h-10 w-56 rounded-md border border-line bg-editor px-2 text-[12px] text-text-body outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-ring"
            />
            <CommentIconButton
              label="Send comment"
              icon={Send}
              type="submit"
              className="bg-brand text-white hover:bg-brand-hover"
            />
          </form>
        ) : (
          <>
            <CommentIconButton
              label="Comment"
              icon={MessageSquarePlus}
              onMouseDown={(event) => event.preventDefault()}
              onClick={startComment}
              className="bg-surface text-text-bright hover:bg-line"
            />
            <span className="mx-0.5 h-4 w-px bg-line" />
            <BubbleToggle
              label="Bold"
              icon={Bold}
              active={editor.isActive("bold")}
              onRun={() => editor.chain().focus().toggleBold().run()}
            />
            <BubbleToggle
              label="Italic"
              icon={Italic}
              active={editor.isActive("italic")}
              onRun={() => editor.chain().focus().toggleItalic().run()}
            />
            <BubbleToggle
              label="Code"
              icon={Code}
              active={editor.isActive("code")}
              onRun={() => editor.chain().focus().toggleCode().run()}
            />
          </>
        )}
      </div>
    </BubbleMenu>
  )
}

function BubbleToggle({
  label,
  icon: Icon,
  active,
  onRun
}: {
  label: string
  icon: typeof Bold
  active: boolean
  onRun: () => void
}) {
  return (
    <CommentIconButton
      label={label}
      icon={Icon}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
      active={active}
    />
  )
}

function CommentIconButton({
  label,
  icon: Icon,
  type = "button",
  active = false,
  className,
  onClick,
  onMouseDown
}: {
  label: string
  icon: ComponentType<{ className?: string }>
  type?: "button" | "submit"
  active?: boolean
  className?: string
  onClick?: () => void
  onMouseDown?: (event: ReactMouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <HoverCard content={label} side="top" delayMs={250}>
      <button
        type={type}
        onMouseDown={onMouseDown}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active || undefined}
        className={cn(
          "flex size-10 items-center justify-center rounded-md text-text-body outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]",
          active && "bg-surface text-text-bright",
          className
        )}
      >
        <Icon className="size-3.5" />
      </button>
    </HoverCard>
  )
}
