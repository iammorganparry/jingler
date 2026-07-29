import { sanitizePlanHtml } from "@jingler/core"
import type { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { Heading2, List, ListOrdered, ListTree, SquareCheck, Workflow } from "lucide-react"
import { useEffect, useRef } from "react"
import { cn } from "../../lib/cn.js"
import { planDocExtensions } from "./plan-doc-extensions.js"

/**
 * Full-document WYSIWYG editor for an HTML plan, rendered as a Notion-like doc.
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
  className
}: {
  value: string
  onChange?: (html: string) => void
  editable?: boolean
  className?: string
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
    <div className={cn("flex min-h-0 flex-col", className)}>
      {editable && editor && <PlanDocToolbar editor={editor} />}
      <EditorContent
        editor={editor}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto text-[13px] leading-[1.65] text-text-body [&_.ProseMirror]:outline-none",
          !editable && "opacity-95"
        )}
      />
    </div>
  )
}

/** Count nodes of a type in the document, for deriving the next widget id. */
const countType = (editor: Editor, typeName: string): number => {
  let n = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) n++
  })
  return n
}

const pad = (n: number): string => String(n).padStart(2, "0")

interface ToolButton {
  readonly label: string
  readonly icon: typeof Heading2
  readonly run: () => void
  readonly isActive?: () => boolean
}

/**
 * The insert toolbar — the reliable path to every widget. Prose toggles (H2,
 * lists) reuse StarterKit commands; the plan widgets (stage, acceptance,
 * diagram) are inserted as fully-formed nodes at the cursor, with a derived,
 * document-unique id so the result stays a valid plan.
 */
function PlanDocToolbar({ editor }: { editor: Editor }) {
  const insertStage = () => {
    const id = pad(countType(editor, "planStage") + 1)
    editor
      .chain()
      .focus()
      .insertContent({
        type: "planStage",
        attrs: { id, title: "New stage" },
        content: [
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Intent" }] },
          { type: "paragraph", content: [{ type: "text", text: "Why this stage exists." }] },
          {
            type: "planAcceptance",
            attrs: { id: `${id}.1`, status: "pending" },
            content: [{ type: "text", text: "Observable assertion that proves this stage." }]
          }
        ]
      })
      .run()
  }

  const insertAcceptance = () => {
    const n = countType(editor, "planAcceptance") + 1
    editor
      .chain()
      .focus()
      .insertContent({
        type: "planAcceptance",
        attrs: { id: `c${n}`, status: "pending" },
        content: [{ type: "text", text: "New acceptance criterion." }]
      })
      .run()
  }

  const insertDiagram = () => {
    editor
      .chain()
      .focus()
      .insertContent({ type: "planDiagram", attrs: { source: "graph TD; A-->B" } })
      .run()
  }

  const buttons: ReadonlyArray<ToolButton> = [
    {
      label: "Heading",
      icon: Heading2,
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      isActive: () => editor.isActive("heading", { level: 2 })
    },
    {
      label: "Bullet list",
      icon: List,
      run: () => editor.chain().focus().toggleBulletList().run(),
      isActive: () => editor.isActive("bulletList")
    },
    {
      label: "Numbered list",
      icon: ListOrdered,
      run: () => editor.chain().focus().toggleOrderedList().run(),
      isActive: () => editor.isActive("orderedList")
    },
    { label: "Stage", icon: ListTree, run: insertStage },
    { label: "Acceptance", icon: SquareCheck, run: insertAcceptance },
    { label: "Flow diagram", icon: Workflow, run: insertDiagram }
  ]

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
      {buttons.map((b) => {
        const Icon = b.icon
        const active = b.isActive?.() ?? false
        return (
          <button
            key={b.label}
            type="button"
            // Keep the selection: toolbar mousedown must not blur the editor.
            onMouseDown={(event) => event.preventDefault()}
            onClick={b.run}
            aria-label={`Insert ${b.label}`}
            aria-pressed={active}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-text-body outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-surface text-text-bright"
            )}
          >
            <Icon className="size-3.5" />
            <span>{b.label}</span>
          </button>
        )
      })}
    </div>
  )
}
