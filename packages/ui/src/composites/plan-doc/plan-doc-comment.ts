import { buildPlanAnchor, resolvePlanAnchor } from "@jingler/core"
import { Extension, type Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

/**
 * Turn a text selection into an anchored comment: a `planAnnotation` block
 * carrying the comment body and a W3C TextQuote anchor (quote + prefix + suffix)
 * derived from the selection.
 *
 * The anchor is built from the document's plain text, not ProseMirror positions:
 * `textBetween(0, pos)` collapses node boundaries to real characters, so the
 * offsets we hand `buildPlanAnchor` index the same string `resolvePlanAnchor`
 * later searches. The annotation serializes to `<aside data-annotation …>`.
 * Highlighting is derived from those anchors as a ProseMirror decoration, so it
 * survives reloads without adding duplicate state to the persisted document and
 * disappears automatically when its annotation is deleted.
 */

/** The smallest free `aN` id, so a second comment never collides with the first. */
export const nextAnnotationId = (editor: Editor): string => {
  const used = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === "planAnnotation") {
      const id = node.attrs.id as string
      if (id.length > 0) used.add(id)
    }
  })
  let n = 1
  while (used.has(`a${n}`)) n++
  return `a${n}`
}

export interface PlanCommentInput {
  readonly from: number
  readonly to: number
  readonly body: string
}

export interface PlanCommentRange {
  readonly from: number
  readonly to: number
}

interface PlanCommentAnchor {
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
}

const textLengthAt = (doc: ProseMirrorNode, position: number): number =>
  doc.textBetween(0, position, "\n", "\n").length

/**
 * Invert `doc.textBetween(0, position)`: TextQuote anchors use plain-text
 * offsets, while ProseMirror decorations and coordinates use document
 * positions. The text length is monotonic, so a binary search avoids walking
 * every character of a large plan.
 */
const positionAtTextOffset = (doc: ProseMirrorNode, offset: number): number => {
  let low = 0
  let high = doc.content.size
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (textLengthAt(doc, middle) < offset) low = middle + 1
    else high = middle
  }
  return low
}

/** Resolve a persisted TextQuote anchor to the live ProseMirror document. */
export const resolvePlanCommentRange = (
  doc: ProseMirrorNode,
  anchor: PlanCommentAnchor
): PlanCommentRange | null => {
  const fullText = doc.textBetween(0, doc.content.size, "\n", "\n")
  const range = resolvePlanAnchor(fullText, anchor)
  if (range === null) return null
  const from = positionAtTextOffset(doc, range.start)
  const to = positionAtTextOffset(doc, range.end)
  if (from >= to || doc.resolve(from).parent.type.name === "planAnnotation") return null
  return { from, to }
}

const commentDecorations = (doc: ProseMirrorNode): DecorationSet => {
  const decorations: Array<Decoration> = []
  doc.descendants((node) => {
    if (node.type.name !== "planAnnotation") return
    const quote = typeof node.attrs.quote === "string" ? node.attrs.quote : ""
    if (quote.length === 0) return
    const range = resolvePlanCommentRange(doc, {
      quote,
      prefix: typeof node.attrs.prefix === "string" ? node.attrs.prefix : "",
      suffix: typeof node.attrs.suffix === "string" ? node.attrs.suffix : ""
    })
    if (range === null) return
    const id = typeof node.attrs.id === "string" ? node.attrs.id : ""
    const resolved = node.attrs.status === "resolved"
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: resolved
          ? "rounded bg-yellow/10 px-0.5 text-text-bright"
          : "rounded bg-yellow/25 px-0.5 text-text-bright",
        "data-plan-comment-highlight": id,
        "data-plan-comment-status": resolved ? "resolved" : "open"
      })
    )
  })
  return DecorationSet.create(doc, decorations)
}

const planCommentDecorationsKey = new PluginKey<DecorationSet>("planCommentDecorations")

/**
 * Editor-only chrome derived entirely from canonical annotation nodes.
 * Recomputing after a document change keeps moved quotes, resolution status,
 * highlights, and deletion in lock-step.
 */
export const PlanCommentDecorations = Extension.create({
  name: "planCommentDecorations",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: planCommentDecorationsKey,
        state: {
          init: (_, state) => commentDecorations(state.doc),
          apply: (transaction, decorations) =>
            transaction.docChanged ? commentDecorations(transaction.doc) : decorations
        },
        props: {
          decorations: (state) => planCommentDecorationsKey.getState(state) ?? null
        }
      })
    ]
  }
})

/** Remove one annotation by identity; its derived highlight disappears with it. */
export const removePlanComment = (editor: Editor, annotationId: string): boolean => {
  let range: PlanCommentRange | null = null
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== "planAnnotation" || node.attrs.id !== annotationId) return
    range = { from: position, to: position + node.nodeSize }
    return false
  })
  if (range === null) return false
  return editor.chain().focus().deleteRange(range).run()
}

/**
 * Apply a comment over `[from, to]`: insert the annotation block immediately
 * after the enclosing block, with author "user" and status "open". The
 * decoration extension derives its highlight from the stored anchor. Returns
 * the generated annotation id.
 */
export const applyPlanComment = (editor: Editor, { from, to, body }: PlanCommentInput): string => {
  const { doc } = editor.state
  const textStart = doc.textBetween(0, from, "\n", "\n").length
  const textEnd = doc.textBetween(0, to, "\n", "\n").length
  const fullText = doc.textBetween(0, doc.content.size, "\n", "\n")
  const anchor = buildPlanAnchor(fullText, textStart, textEnd)
  const id = nextAnnotationId(editor)

  // Land the annotation as a sibling right after the block the selection ends
  // in, so it stays inside a stage rather than splitting a paragraph.
  const $to = doc.resolve(to)
  const insertAt = $to.after($to.depth)

  editor
    .chain()
    .focus()
    .setTextSelection({ from, to })
    .insertContentAt(insertAt, {
      type: "planAnnotation",
      attrs: {
        id,
        author: "user",
        status: "open",
        quote: anchor.quote,
        prefix: anchor.prefix,
        suffix: anchor.suffix
      },
      content: body.length > 0 ? [{ type: "text", text: body }] : []
    })
    .run()

  return id
}
