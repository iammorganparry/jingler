import type { Editor } from "@tiptap/core"
import { EditorContent } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { Bold, Code, Italic, MessageSquarePlus } from "lucide-react"
import type { ComponentType, MouseEvent as ReactMouseEvent } from "react"
import { useCallback, useRef, useState } from "react"
import { HoverCard } from "../../components/hover-card.js"
import { cn } from "../../lib/cn.js"
import { applyPlanComment } from "./plan-doc-comment.js"
import {
  PlanCommentComposer,
  type PlanCommentThreadControls,
  PlanCommentThreadControlsProvider,
  usePlanCommentThreadControls
} from "./plan-comment-thread.js"
import {
  type PlanFileEvidence,
  PlanFileControlsProvider
} from "./plan-file-controls.js"
import {
  type PlanWorkerControls,
  PlanWorkerControlsProvider
} from "./plan-worker-controls.js"
import { usePlanDocController } from "./use-plan-doc-controller.js"
import {
  type PlanDocOutlineEntry,
  type PlanDocViewport,
  usePlanDocSurface
} from "./use-plan-doc-surface.js"

/**
 * Full-document WYSIWYG editor for an HTML plan, rendered as a Notion-like doc.
 *
 * There is no insert toolbar: blocks and plan widgets are added through the `/`
 * command menu (see `plan-doc-slash.tsx`), and selecting text raises a bubble
 * menu for inline formatting and anchored comments (see below). The editor
 * therefore renders as just the document.
 *
 * Editor lifecycle and external-value reconciliation live in
 * `usePlanDocController`; minimap and navigation side effects live in
 * `usePlanDocSurface`. Structural plan widgets are Tiptap node views, so this
 * component remains a declarative composition layer and parent renders do not
 * replace the active ProseMirror selection.
 */
export function PlanDocEditor({
  value,
  onChange,
  editable = true,
  className,
  workerControls,
  commentControls,
  targetStageId,
  onTargetStageConsumed,
  targetBlockId,
  onTargetBlockConsumed,
  onOutlineChange,
  onViewportChange,
  fileEvidence,
  knownFiles,
  onOpenFile
}: {
  value: string
  onChange?: (html: string) => void
  editable?: boolean
  className?: string
  workerControls?: PlanWorkerControls
  commentControls?: PlanCommentThreadControls
  /** Stable stage id to reveal after the Plan view opens from the progress dock. */
  targetStageId?: string | null
  /** Retire the one-shot target once its stage is on screen. */
  onTargetStageConsumed?: () => void
  /** Minimap navigation target (`title`, `heading:N`, or `stage:<id>`). */
  targetBlockId?: string | null
  onTargetBlockConsumed?: () => void
  onOutlineChange?: (outline: ReadonlyArray<PlanDocOutlineEntry>) => void
  onViewportChange?: (viewport: PlanDocViewport) => void
  /** Live worktree diff stats keyed by repository-relative path. */
  fileEvidence?: ReadonlyMap<string, PlanFileEvidence>
  /** Worktree paths that the asset viewer can currently open. */
  knownFiles?: ReadonlySet<string>
  onOpenFile?: (path: string) => void
}) {
  const controller = usePlanDocController({
    value,
    editable,
    onChange,
    workerControls,
    commentControls
  })
  usePlanDocSurface({
    editor: controller.editor,
    value,
    targetStageId,
    targetBlockId,
    onTargetStageConsumed,
    onTargetBlockConsumed,
    onOutlineChange,
    onViewportChange
  })

  return (
    <PlanCommentThreadControlsProvider controls={controller.commentControls}>
      <PlanWorkerControlsProvider controls={controller.workerControls}>
        <PlanFileControlsProvider
          evidence={fileEvidence}
          knownFiles={knownFiles}
          open={onOpenFile}
        >
          <div className={cn("flex min-h-0 flex-col", className)}>
            {editable && controller.editor && (
              <CommentBubbleMenu editor={controller.editor} />
            )}
            <EditorContent
              editor={controller.editor}
              className={cn(
                "min-h-0 flex-1 overflow-y-auto text-[13px] leading-[1.65] text-text-body [&_.ProseMirror]:outline-none [&_[data-files]]:my-2.5 [&_[data-files]]:pl-0 [&_[data-files]>li]:list-none",
                !editable && "opacity-95"
              )}
            />
          </div>
        </PlanFileControlsProvider>
      </PlanWorkerControlsProvider>
    </PlanCommentThreadControlsProvider>
  )
}

export {
  planDocViewportFractions,
  type PlanDocOutlineEntry,
  type PlanDocViewport
} from "./use-plan-doc-surface.js"
export type { PlanFileEvidence } from "./plan-file-controls.js"

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
  const range = useRef<{ from: number; to: number } | null>(null)
  const composingRef = useRef(false)
  composingRef.current = composing
  const { participants } = usePlanCommentThreadControls()
  const shouldShow = useCallback(({ editor: current }: { editor: Editor }) => {
    const { from, to } = current.state.selection
    return composingRef.current || (current.isEditable && from < to)
  }, [])

  const startComment = () => {
    const { from, to } = editor.state.selection
    range.current = { from, to }
    setComposing(true)
  }

  const cancel = () => {
    setComposing(false)
    range.current = null
  }

  const submit = (
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => {
    const captured = range.current
    if (captured && captured.from !== captured.to) {
      applyPlanComment(editor, {
        from: captured.from,
        to: captured.to,
        body,
        mentionedParticipantIds
      })
    }
    cancel()
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={shouldShow}
    >
      <div className="flex items-center gap-1 rounded-[10px] border border-line bg-panel p-1 shadow-lg">
        {composing ? (
          <div className="w-80 p-1">
            <PlanCommentComposer
              participants={participants}
              placeholder="Add a comment…"
              autoFocus
              onSubmit={submit}
              onCancel={cancel}
            />
          </div>
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
