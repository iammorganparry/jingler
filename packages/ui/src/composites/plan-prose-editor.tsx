import type { Editor, Extensions } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { EditorContent, useEditor } from "@tiptap/react"
import { Markdown } from "tiptap-markdown"
import { useEffect, useRef } from "react"
import { cn } from "../lib/cn.js"

/**
 * The Tiptap extension set behind inline plan editing.
 *
 * Exported so the markdown round-trip can be exercised headlessly in tests
 * (`new Editor({ extensions: planProseExtensions() })`) with the exact same
 * schema the live editor uses — a divergence there would let a round-trip test
 * pass while the real editor corrupts source.
 *
 * `tiptap-markdown` is what makes the editor bidirectional: `content` is parsed
 * FROM markdown and `getEditorMarkdown(editor)` serializes back TO
 * markdown. `html: false` keeps the safe-MDX invariant — raw HTML/JSX is never
 * emitted, so a serialized section can only ever be plain markdown (the caller
 * still re-validates the whole document through `parsePlanMdx` before saving).
 */
/**
 * Read the editor's content back as markdown. `tiptap-markdown` installs a
 * `markdown` storage slot with a `getMarkdown()` method but ships no type for
 * it, so this narrows the access in one place instead of casting at each call.
 */
export const getEditorMarkdown = (editor: Editor): string =>
  (editor.storage as { markdown?: { getMarkdown(): string } }).markdown?.getMarkdown() ?? ""

export const planProseExtensions = (): Extensions => [
  StarterKit,
  Markdown.configure({
    html: false,
    linkify: false,
    breaks: false,
    transformPastedText: true,
    transformCopiedText: true
  })
]

/**
 * WYSIWYG editor for ONE plan-prose fragment (a section body). Renders markdown
 * as rich text you edit in place and emits fresh markdown on every change.
 *
 * The editor is created once; `onChange` is read through a ref so its latest
 * closure fires without tearing down and recreating the ProseMirror instance
 * (which would drop selection and focus on each parent render). An external
 * `value` change (a remote revision, a conflict resolution) is pushed in with
 * `emitUpdate: false` so syncing down never loops back as a fake edit.
 */
export function PlanProseEditor({
  value,
  onChange,
  disabled = false,
  className,
  ariaLabel
}: {
  value: string
  onChange?: (markdown: string) => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    editable: !disabled,
    extensions: planProseExtensions(),
    content: value,
    editorProps: {
      attributes: {
        class: "sb-md min-h-[2rem] px-1 py-1 outline-none",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {})
      }
    },
    onUpdate: ({ editor }) => onChangeRef.current?.(getEditorMarkdown(editor))
  })

  useEffect(() => {
    if (!editor) return
    const current = getEditorMarkdown(editor)
    if (value.trim() !== current.trim()) {
      editor.commands.setContent(value, { emitUpdate: false })
    }
  }, [editor, value])

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  return (
    <EditorContent
      editor={editor}
      className={cn(
        "text-[13px] leading-[1.65] text-text-body [&_.ProseMirror]:outline-none",
        disabled && "pointer-events-none opacity-70",
        className
      )}
    />
  )
}
