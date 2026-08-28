import { act, cleanup, render } from "@testing-library/react"
import { jinglerDark, toTokens } from "@jingler/themes"
import type { CodeViewItem, FileContents } from "@pierre/diffs"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PierreAnnotationMetadata } from "./pierre-annotations.js"
import { PierreEditor, PierreProvider } from "./pierre-provider.js"

interface MockEditorOptions {
  readonly onChange: (file: FileContents) => void
}

interface MockCodeViewProps {
  readonly items: readonly CodeViewItem<PierreAnnotationMetadata>[]
  readonly createEditor?: (options: MockEditorOptions) => unknown
  readonly onItemEditChange?: (
    item: CodeViewItem<PierreAnnotationMetadata>,
    file: FileContents
  ) => void
  readonly onItemEditComplete?: (
    item: CodeViewItem<PierreAnnotationMetadata>,
    file: FileContents
  ) => void
  readonly selectedLines?: {
    readonly id: string
    readonly range: {
      readonly start: number
      readonly end: number
      readonly side: "additions" | "deletions"
      readonly endSide: "additions" | "deletions"
    }
  } | null
  readonly onSelectedLinesChange?: (selection: {
    readonly id: string
    readonly range: {
      readonly start: number
      readonly end: number
      readonly side: "additions" | "deletions"
      readonly endSide: "additions" | "deletions"
    }
  } | null) => void
  readonly options?: {
    readonly layout?: {
      readonly paddingTop: number
      readonly paddingBottom: number
      readonly gap: number
    }
    readonly onTokenEnter?: (...args: never[]) => void
    readonly onTokenLeave?: (...args: never[]) => void
  }
  readonly renderCodeViewFooter?: () => ReactNode
}

const pierre = vi.hoisted<{
  codeViewProps?: MockCodeViewProps
  editProviderCreateEditor?: (options: MockEditorOptions) => unknown
  editorOptions: MockEditorOptions[]
}>(() => ({ editorOptions: [] }))

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: MockCodeViewProps) => {
    pierre.codeViewProps = props
    return (
      <div data-testid="mock-pierre-code-view">
        {props.renderCodeViewFooter?.()}
      </div>
    )
  },
  // The REAL EditProvider is the only channel the runtime reads the editor
  // factory from (CodeView's `createEditor` prop is declared in the d.ts but
  // ignored by the implementation) — mirror that contract here so a
  // regression back to prop-passing fails this suite instead of black-
  // screening the app the first time the file editor opens.
  EditProvider: ({
    children,
    createEditor
  }: {
    readonly children: ReactNode
    readonly createEditor: (options: MockEditorOptions) => unknown
  }) => {
    pierre.editProviderCreateEditor = createEditor
    return children
  },
  File: () => null,
  FileDiff: () => null,
  Virtualizer: ({ children }: { readonly children: ReactNode }) => children,
  WorkerPoolContextProvider: ({
    children
  }: {
    readonly children: ReactNode
  }) => children,
  useWorkerPool: () => undefined
}))

vi.mock("@pierre/diffs/edit", () => ({
  Editor: class {
    constructor(options: MockEditorOptions) {
      pierre.editorOptions.push(options)
    }
  }
}))

afterEach(() => {
  cleanup()
  pierre.codeViewProps = undefined
  pierre.editProviderCreateEditor = undefined
  pierre.editorOptions.length = 0
})

describe("PierreEditor", () => {
  it("contains the beta editor and translates dirty, change, completion, and selection callbacks", () => {
    const item = {
      id: "src/example.ts",
      type: "file",
      file: {
        name: "src/example.ts",
        contents: "before\n",
        cacheKey: "example-before"
      }
    } satisfies CodeViewItem<PierreAnnotationMetadata>
    const onDirtyChange = vi.fn()
    const onChange = vi.fn()
    const onComplete = vi.fn()
    const onSelectionChange = vi.fn()
    const onTokenEnter = vi.fn()
    const onTokenLeave = vi.fn()

    render(
      <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
        <PierreEditor
          label="Example editor"
          items={[item]}
          onDirtyChange={onDirtyChange}
          onChange={onChange}
          onComplete={onComplete}
          selection={{
            path: item.file.name,
            side: "new",
            startLine: 2,
            endLine: 4,
            endSide: "new"
          }}
          onSelectionChange={onSelectionChange}
          onTokenEnter={onTokenEnter}
          onTokenLeave={onTokenLeave}
        />
      </PierreProvider>
    )

    const props = pierre.codeViewProps
    expect(props).toBeDefined()
    if (props === undefined) return
    expect(props.items[0]).toMatchObject({ id: item.id, edit: true })
    expect(props.options?.layout).toEqual({
      paddingTop: 8,
      paddingBottom: 64,
      gap: 8
    })
    expect(props.options?.onTokenEnter).toBe(onTokenEnter)
    expect(props.options?.onTokenLeave).toBe(onTokenLeave)
    expect(
      document.querySelector("[data-jingler-pierre-code-view-footer]")
    ).not.toBeNull()
    expect(props.selectedLines).toEqual({
      id: item.id,
      range: { start: 2, end: 4, side: "additions", endSide: "additions" }
    })
    act(() => {
      props.onSelectedLinesChange?.({
        id: item.id,
        range: { start: 3, end: 5, side: "additions", endSide: "additions" }
      })
    })
    expect(onSelectionChange).toHaveBeenCalledWith({
      path: item.file.name,
      side: "new",
      startLine: 3,
      endLine: 5,
      endSide: "new"
    })

    // The factory must arrive through EditProvider (context), NOT the
    // CodeView prop — the runtime ignores the prop, and shipping it that way
    // crashed the app with "createEditor is required for items with
    // edit: true" the first time an item was marked editable.
    expect(props.createEditor).toBeUndefined()
    const editorChange = vi.fn()
    expect(pierre.editProviderCreateEditor?.({ onChange: editorChange })).toBeTruthy()
    expect(pierre.editorOptions).toEqual([{ onChange: editorChange }])

    const first = { ...item.file, contents: "first edit\n" }
    const final = { ...item.file, contents: "final edit\n" }
    act(() => {
      props.onItemEditChange?.(item, first)
      props.onItemEditChange?.(item, final)
      props.onItemEditComplete?.(item, final)
    })

    expect(onDirtyChange.mock.calls).toEqual([
      [item.id, true],
      [item.id, false]
    ])
    expect(onChange.mock.calls).toEqual([
      [
        {
          itemId: item.id,
          path: item.file.name,
          contents: first.contents
        }
      ],
      [
        {
          itemId: item.id,
          path: item.file.name,
          contents: final.contents
        }
      ]
    ])
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      itemId: item.id,
      path: item.file.name,
      contents: final.contents
    })
  })
})
