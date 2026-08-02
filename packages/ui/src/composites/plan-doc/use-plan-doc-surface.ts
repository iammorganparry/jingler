import type { Editor, EditorEvents } from "@tiptap/core"
import { useEffect, useRef } from "react"

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

interface SurfaceCallbacks {
  readonly onOutlineChange?: (outline: ReadonlyArray<PlanDocOutlineEntry>) => void
  readonly onViewportChange?: (viewport: PlanDocViewport) => void
}

interface SurfaceInput {
  readonly callbacks: React.MutableRefObject<SurfaceCallbacks>
}

const sameOutline = (
  left: ReadonlyArray<PlanDocOutlineEntry>,
  right: ReadonlyArray<PlanDocOutlineEntry>
): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.id === right[index]?.id &&
      entry.title === right[index]?.title &&
      entry.kind === right[index]?.kind
  )

const sameViewport = (
  left: PlanDocViewport | null,
  right: PlanDocViewport
): boolean =>
  left !== null &&
  left.activeId === right.activeId &&
  left.start === right.start &&
  left.size === right.size

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

const outlineFrom = (
  editor: Editor
): {
  readonly elements: ReadonlyArray<HTMLElement>
  readonly outline: ReadonlyArray<PlanDocOutlineEntry>
} => {
  const elements = Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>("h1, h2, [data-plan-stage-id]")
  )
  let headingIndex = 0
  const outline = elements.map((element) => {
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
  return { elements, outline }
}

class PlanDocSurfaceController {
  private frame = 0
  private rebuildOutline = true
  private elements: ReadonlyArray<HTMLElement> = []
  private outline: ReadonlyArray<PlanDocOutlineEntry> = []
  private viewport: PlanDocViewport | null = null

  constructor(
    private readonly editor: Editor,
    private readonly input: SurfaceInput,
    private readonly scrollElement: HTMLElement
  ) {}

  attach = (): (() => void) => {
    this.scheduleUpdate()
    this.editor.on("transaction", this.onTransaction)
    this.scrollElement.addEventListener("scroll", this.onViewportInput, {
      passive: true
    })
    window.addEventListener("resize", this.onViewportInput)
    return this.detach
  }

  private detach = (): void => {
    window.cancelAnimationFrame(this.frame)
    this.editor.off("transaction", this.onTransaction)
    this.scrollElement.removeEventListener("scroll", this.onViewportInput)
    window.removeEventListener("resize", this.onViewportInput)
  }

  private onTransaction = ({ transaction }: EditorEvents["transaction"]): void => {
    if (!transaction.docChanged) return
    this.scheduleUpdate(true)
  }

  private onViewportInput = (): void => this.scheduleUpdate()

  private scheduleUpdate = (outlineChanged = false): void => {
    this.rebuildOutline ||= outlineChanged
    window.cancelAnimationFrame(this.frame)
    this.frame = window.requestAnimationFrame(this.publishSurface)
  }

  private publishSurface = (): void => {
    if (this.rebuildOutline) {
      const next = outlineFrom(this.editor)
      this.elements = next.elements
      this.rebuildOutline = false
      if (!sameOutline(this.outline, next.outline)) {
        this.input.callbacks.current.onOutlineChange?.(next.outline)
      }
      this.outline = next.outline
    }
    const viewportRect = this.scrollElement.getBoundingClientRect()
    const active = [...this.elements]
      .reverse()
      .find((element) => element.getBoundingClientRect().top <= viewportRect.top + 96)
    const next = {
      activeId: active?.dataset.planMinimapId ?? this.outline[0]?.id ?? null,
      ...planDocViewportFractions(this.scrollElement)
    }
    if (!sameViewport(this.viewport, next)) {
      this.viewport = next
      this.input.callbacks.current.onViewportChange?.(next)
    }
  }
}

const attachSurface = (editor: Editor | null, input: SurfaceInput): (() => void) | void => {
  if (editor === null) return
  return new PlanDocSurfaceController(
    editor,
    input,
    editor.view.dom.parentElement ?? editor.view.dom
  ).attach()
}

const blockTarget = (editor: Editor, targetBlockId: string): HTMLElement | null =>
  targetBlockId === "title"
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

const revealStage = (
  editor: Editor,
  stageId: string,
  consumed?: () => void
): boolean => {
  const target = Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>("[data-plan-stage-id]")
  ).find((element) => element.dataset.planStageId === stageId)
  if (!target) return false
  target.scrollIntoView({ behavior: "auto", block: "start" })
  target.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true })
  consumed?.()
  return true
}

interface NavigationInput {
  readonly editor: Editor | null
  readonly targetStageId?: string | null
  readonly targetBlockId?: string | null
  readonly onTargetStageConsumed?: () => void
  readonly onTargetBlockConsumed?: () => void
  readonly onViewportChange?: (viewport: PlanDocViewport) => void
}

const navigate = (input: NavigationInput): (() => void) | void => {
  const { editor, targetStageId, targetBlockId } = input
  if (editor === null) return
  if (targetStageId) {
    if (revealStage(editor, targetStageId, input.onTargetStageConsumed)) return
    const retry = window.setTimeout(
      () => revealStage(editor, targetStageId, input.onTargetStageConsumed),
      0
    )
    return () => window.clearTimeout(retry)
  }
  if (!targetBlockId) return
  const target = blockTarget(editor, targetBlockId)
  if (target === null) return
  target.scrollIntoView({ behavior: "auto", block: "start" })
  target.focus({ preventScroll: true })
  const scrollElement = editor.view.dom.parentElement
  if (scrollElement !== null) {
    input.onViewportChange?.({
      activeId: targetBlockId,
      ...planDocViewportFractions(scrollElement)
    })
  }
  input.onTargetBlockConsumed?.()
}

export const usePlanDocSurface = ({
  editor,
  value,
  targetStageId,
  targetBlockId,
  onTargetStageConsumed,
  onTargetBlockConsumed,
  onOutlineChange,
  onViewportChange
}: NavigationInput &
  SurfaceCallbacks & {
    readonly value: string
  }): void => {
  const callbacks = useRef<SurfaceCallbacks>({})
  callbacks.current = { onOutlineChange, onViewportChange }
  const navigation = useRef<NavigationInput>({ editor: null })
  navigation.current = {
    editor,
    targetStageId,
    targetBlockId,
    onTargetStageConsumed,
    onTargetBlockConsumed,
    onViewportChange
  }

  useEffect(() => attachSurface(editor, { callbacks }), [editor])
  useEffect(() => navigate(navigation.current), [editor, targetStageId, targetBlockId, value])
}
