import { type PlanCommentMessage, sanitizePlanHtml } from "@jingler/core"
import type { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { Bold, Code, Italic, MessageSquarePlus } from "lucide-react"
import type { ComponentType, MouseEvent as ReactMouseEvent } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HoverCard } from "../../components/hover-card.js"
import { cn } from "../../lib/cn.js"
import { applyPlanComment } from "./plan-doc-comment.js"
import {
  PlanCommentComposer,
  type PlanCommentThreadControls,
  PlanCommentThreadControlsProvider,
  usePlanCommentThreadControls
} from "./plan-comment-thread.js"
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
  workerControls,
  commentControls,
  targetStageId,
  onTargetStageConsumed,
  targetBlockId,
  onTargetBlockConsumed,
  onOutlineChange,
  onViewportChange
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
}) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onTargetStageConsumedRef = useRef(onTargetStageConsumed)
  onTargetStageConsumedRef.current = onTargetStageConsumed
  const onTargetBlockConsumedRef = useRef(onTargetBlockConsumed)
  onTargetBlockConsumedRef.current = onTargetBlockConsumed
  const onOutlineChangeRef = useRef(onOutlineChange)
  onOutlineChangeRef.current = onOutlineChange
  const onViewportChangeRef = useRef(onViewportChange)
  onViewportChangeRef.current = onViewportChange
  const workerControlsRef = useRef(workerControls)
  workerControlsRef.current = workerControls
  const commentControlsRef = useRef(commentControls)
  commentControlsRef.current = commentControls
  const extensions = useMemo(planDocExtensions, [])
  const canStopWorker = workerControls?.stop !== undefined
  const canRetryWorker = workerControls?.retry !== undefined
  const stableWorkerControls = useMemo<PlanWorkerControls>(
    () => ({
      ...(!canStopWorker
        ? {}
        : {
            stop: (agentId: string) =>
              workerControlsRef.current?.stop?.(agentId)
          }),
      ...(!canRetryWorker
        ? {}
        : {
            retry: (agentId: string) =>
              workerControlsRef.current?.retry?.(agentId)
          })
    }),
    [canStopWorker, canRetryWorker]
  )
  const canReply = commentControls?.onReply !== undefined
  const canRetryReply = commentControls?.onRetry !== undefined
  const canSetResolved = commentControls?.onSetResolved !== undefined
  const stableCommentControls = useMemo<PlanCommentThreadControls>(
    () => ({
      participants: commentControls?.participants ?? [],
      disabled: commentControls?.disabled,
      ...(!canReply
        ? {}
        : {
            onReply: (
              annotationId: string,
              body: string,
              mentionedParticipantIds: ReadonlyArray<string>
            ) =>
              commentControlsRef.current?.onReply?.(
                annotationId,
                body,
                mentionedParticipantIds
              )
          }),
      ...(!canRetryReply
        ? {}
        : {
            onRetry: (annotationId: string, message: PlanCommentMessage) =>
              commentControlsRef.current?.onRetry?.(annotationId, message)
          }),
      ...(!canSetResolved
        ? {}
        : {
            onSetResolved: (annotationId: string, resolved: boolean) =>
              commentControlsRef.current?.onSetResolved?.(
                annotationId,
                resolved
              )
          })
    }),
    [
      commentControls?.participants,
      commentControls?.disabled,
      canReply,
      canRetryReply,
      canSetResolved
    ]
  )

  const editor = useEditor({
    editable,
    // Extension instances own node-view factories. Recreating them on every
    // outline/viewport render makes Tiptap rebuild every atom node view.
    extensions,
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

  useEffect(() => {
    if (!editor || !targetStageId) return
    const reveal = () => {
      const target = Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>("[data-plan-stage-id]")
      ).find((element) => element.dataset.planStageId === targetStageId)
      if (!target) return false
      target.scrollIntoView({ behavior: "auto", block: "start" })
      target.querySelector<HTMLButtonElement>("button")?.focus({
        preventScroll: true
      })
      onTargetStageConsumedRef.current?.()
      return true
    }
    if (reveal()) return
    const retry = window.setTimeout(reveal, 0)
    return () => window.clearTimeout(retry)
  }, [editor, targetStageId, value])

  useEffect(() => {
    if (!editor || !targetBlockId) return
    const target = targetBlockId === "title"
      ? editor.view.dom.querySelector<HTMLElement>("h1")
      : targetBlockId.startsWith("heading:")
        ? Array.from(editor.view.dom.querySelectorAll<HTMLElement>("h2"))[
            Number(targetBlockId.slice("heading:".length))
          ] ?? null
        : targetBlockId.startsWith("stage:")
          ? Array.from(
              editor.view.dom.querySelectorAll<HTMLElement>("[data-plan-stage-id]")
            ).find(
              (element) =>
                element.dataset.planStageId === targetBlockId.slice("stage:".length)
            ) ?? null
          : null
    if (target === null) return
    target.scrollIntoView({ behavior: "auto", block: "start" })
    target.focus({ preventScroll: true })
    const scrollElement = editor.view.dom.parentElement
    if (scrollElement !== null) {
      onViewportChangeRef.current?.({
        activeId: targetBlockId,
        ...planDocViewportFractions(scrollElement)
      })
    }
    onTargetBlockConsumedRef.current?.()
  }, [editor, targetBlockId, value])

  useEffect(() => {
    if (!editor) return
    const scrollElement = editor.view.dom.parentElement
    if (scrollElement === null) return

    let frame = 0
    let rebuildOutline = true
    let elements: ReadonlyArray<HTMLElement> = []
    let outline: ReadonlyArray<PlanDocOutlineEntry> = []
    const update = (outlineChanged = false) => {
      rebuildOutline ||= outlineChanged
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        if (rebuildOutline) {
          elements = Array.from(
            editor.view.dom.querySelectorAll<HTMLElement>(
              "h1, h2, [data-plan-stage-id]"
            )
          )
          let headingIndex = 0
          outline = elements.map((element) => {
            const stageId = element.dataset.planStageId
            const id =
              stageId !== undefined
                ? `stage:${stageId}`
                : element.tagName === "H1"
                  ? "title"
                  : `heading:${headingIndex++}`
            element.dataset.planMinimapId = id
            if (!element.hasAttribute("tabindex")) element.tabIndex = -1
            return {
              id,
              title:
                stageId !== undefined
                  ? element.getAttribute("data-plan-stage-title") ??
                    element.querySelector("h3")?.textContent ??
                    stageId
                  : element.textContent?.trim() ?? id,
              kind:
                stageId !== undefined
                  ? "stage"
                  : element.tagName === "H1"
                    ? "title"
                    : "section"
            } satisfies PlanDocOutlineEntry
          })
          rebuildOutline = false
          onOutlineChangeRef.current?.(outline)
        }

        const viewportRect = scrollElement.getBoundingClientRect()
        const active = [...elements]
          .reverse()
          .find((element) => element.getBoundingClientRect().top <= viewportRect.top + 96)
        onViewportChangeRef.current?.({
          activeId: active?.dataset.planMinimapId ?? outline[0]?.id ?? null,
          ...planDocViewportFractions(scrollElement)
        })
      })
    }
    update()
    const updateOutline = () => update(true)
    const updateViewport = () => update()
    editor.on("transaction", updateOutline)
    scrollElement.addEventListener("scroll", updateViewport, { passive: true })
    window.addEventListener("resize", updateViewport)
    return () => {
      window.cancelAnimationFrame(frame)
      editor.off("transaction", updateOutline)
      scrollElement.removeEventListener("scroll", updateViewport)
      window.removeEventListener("resize", updateViewport)
    }
  }, [editor, value])

  return (
    <PlanCommentThreadControlsProvider controls={stableCommentControls}>
      <PlanWorkerControlsProvider controls={stableWorkerControls}>
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
    </PlanCommentThreadControlsProvider>
  )
}

export interface PlanDocOutlineEntry {
  readonly id: string
  readonly title: string
  readonly kind: "title" | "section" | "stage"
}

export interface PlanDocViewport {
  readonly activeId: string | null
  readonly start: number
  readonly size: number
}

export const planDocViewportFractions = ({
  scrollTop,
  clientHeight,
  scrollHeight
}: {
  readonly scrollTop: number
  readonly clientHeight: number
  readonly scrollHeight: number
}): Pick<PlanDocViewport, "start" | "size"> => ({
  start: Math.max(0, Math.min(1, scrollTop / Math.max(1, scrollHeight))),
  size: Math.max(0, Math.min(1, clientHeight / Math.max(1, scrollHeight)))
})

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
