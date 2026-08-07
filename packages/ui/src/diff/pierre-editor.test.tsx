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
}

const pierre = vi.hoisted<{
  codeViewProps?: MockCodeViewProps
  editorOptions: MockEditorOptions[]
}>(() => ({ editorOptions: [] }))

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: MockCodeViewProps) => {
    pierre.codeViewProps = props
    return <div data-testid="mock-pierre-code-view" />
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

vi.mock("@pierre/diffs/editor", () => ({
  Editor: class {
    constructor(options: MockEditorOptions) {
      pierre.editorOptions.push(options)
    }
  }
}))

afterEach(() => {
  cleanup()
  pierre.codeViewProps = undefined
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
        />
      </PierreProvider>
    )

    const props = pierre.codeViewProps
    expect(props).toBeDefined()
    if (props === undefined) return
    expect(props.items[0]).toMatchObject({ id: item.id, edit: true })
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

    const editorChange = vi.fn()
    expect(props.createEditor?.({ onChange: editorChange })).toBeTruthy()
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
