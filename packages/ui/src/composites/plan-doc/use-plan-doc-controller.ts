import { type PlanCommentMessage, sanitizePlanHtml } from "@jingler/core"
import type { Editor } from "@tiptap/core"
import { useEditor } from "@tiptap/react"
import { useEffect, useMemo, useRef } from "react"
import type { PlanCommentThreadControls } from "./plan-comment-thread.js"
import { planDocExtensions } from "./plan-doc-extensions.js"
import type { PlanWorkerControls } from "./plan-worker-controls.js"

export interface PlanDocControllerInput {
  readonly value: string
  readonly editable: boolean
  readonly onChange?: (html: string) => void
  readonly workerControls?: PlanWorkerControls
  readonly commentControls?: PlanCommentThreadControls
}

export interface PlanDocController {
  readonly editor: Editor | null
  readonly workerControls: PlanWorkerControls
  readonly commentControls: PlanCommentThreadControls
}

const syncExternalValue = (
  editor: Editor | null,
  value: string,
  pending: React.MutableRefObject<string | null>
): void => {
  if (editor === null) return
  if (sanitizePlanHtml(value) === sanitizePlanHtml(editor.getHTML())) {
    pending.current = null
  } else if (editor.isFocused) {
    pending.current = value
  } else {
    pending.current = null
    editor.commands.setContent(value, { emitUpdate: false })
  }
}

export const usePlanDocController = ({
  value,
  editable,
  onChange,
  workerControls,
  commentControls
}: PlanDocControllerInput): PlanDocController => {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const workerControlsRef = useRef(workerControls)
  workerControlsRef.current = workerControls
  const commentControlsRef = useRef(commentControls)
  commentControlsRef.current = commentControls
  const pendingExternalValueRef = useRef<string | null>(null)
  const extensions = useMemo(planDocExtensions, [])

  const editor = useEditor({
    editable,
    extensions,
    content: value,
    editorProps: {
      attributes: {
        class: "sb-md min-h-[8rem] px-4 py-3 outline-none",
        "aria-label": "Plan document"
      }
    },
    onUpdate: ({ editor: activeEditor }) =>
      onChangeRef.current?.(sanitizePlanHtml(activeEditor.getHTML())),
    onBlur: ({ editor: activeEditor }) => {
      const pending = pendingExternalValueRef.current
      pendingExternalValueRef.current = null
      if (
        pending !== null &&
        sanitizePlanHtml(pending) !== sanitizePlanHtml(activeEditor.getHTML())
      ) {
        activeEditor.commands.setContent(pending, { emitUpdate: false })
      }
    }
  })

  useEffect(
    () => syncExternalValue(editor, value, pendingExternalValueRef),
    [editor, value]
  )
  useEffect(() => editor?.setEditable(editable), [editor, editable])

  const canStopWorker = workerControls?.stop !== undefined
  const canRetryWorker = workerControls?.retry !== undefined
  const stableWorkerControls = useMemo<PlanWorkerControls>(
    () => ({
      ...(!canStopWorker
        ? {}
        : { stop: (agentId: string) => workerControlsRef.current?.stop?.(agentId) }),
      ...(!canRetryWorker
        ? {}
        : { retry: (agentId: string) => workerControlsRef.current?.retry?.(agentId) })
    }),
    [canStopWorker, canRetryWorker]
  )

  const canReply = commentControls?.onReply !== undefined
  const canRetryReply = commentControls?.onRetry !== undefined
  const canSetResolved = commentControls?.onSetResolved !== undefined
  const stableCommentControls = useMemo<PlanCommentThreadControls>(
    () => ({
      participants: commentControlsRef.current?.participants ?? [],
      disabled: commentControlsRef.current?.disabled,
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
              commentControlsRef.current?.onSetResolved?.(annotationId, resolved)
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

  return {
    editor,
    workerControls: stableWorkerControls,
    commentControls: stableCommentControls
  }
}
