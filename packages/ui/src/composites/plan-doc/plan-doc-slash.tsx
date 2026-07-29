import { Extension } from "@tiptap/core"
import type { Editor, Range } from "@tiptap/core"
import { ReactRenderer } from "@tiptap/react"
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion"
import { Heading2, List, ListOrdered, ListTree, SquareCheck, Workflow } from "lucide-react"
import { forwardRef, useEffect, useImperativeHandle, useState } from "react"
import { cn } from "../../lib/cn.js"

/**
 * The `/` command menu — the sole insert affordance now the toolbar is gone.
 *
 * Typing `/` on an empty selection opens a popup of block/widget commands; each
 * item, when chosen, first deletes the `/query` range and then runs the exact
 * insertion the old toolbar ran, so the resulting document is byte-for-byte what
 * the toolbar produced. Rendering goes through Tiptap's `@tiptap/suggestion`
 * plugin with a `ReactRenderer`, positioned by the plugin's managed floating-ui
 * `mount` (no tippy dependency).
 */

/** Count nodes of a type in the document, for deriving the next widget id. */
export const countType = (editor: Editor, typeName: string): number => {
  let n = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) n++
  })
  return n
}

export const pad = (n: number): string => String(n).padStart(2, "0")

interface SlashItem {
  readonly title: string
  readonly hint: string
  readonly icon: typeof Heading2
  readonly run: (editor: Editor, range: Range) => void
}

/**
 * The command palette. Prose toggles (H2, lists) reuse StarterKit commands; the
 * plan widgets (stage, acceptance, diagram) are inserted as fully-formed nodes
 * with a derived, document-unique id so the result stays a valid plan — the same
 * commands the deleted `PlanDocToolbar` used, now keyed off the `/` selection.
 */
export const SLASH_ITEMS: ReadonlyArray<SlashItem> = [
  {
    title: "Heading 2",
    hint: "Section heading",
    icon: Heading2,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run()
  },
  {
    title: "Bullet list",
    hint: "Unordered list",
    icon: List,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run()
  },
  {
    title: "Numbered list",
    hint: "Ordered list",
    icon: ListOrdered,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run()
  },
  {
    title: "Stage",
    hint: "Plan stage with acceptance",
    icon: ListTree,
    run: (editor, range) => {
      const id = pad(countType(editor, "planStage") + 1)
      editor
        .chain()
        .focus()
        .deleteRange(range)
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
  },
  {
    title: "Acceptance",
    hint: "Acceptance criterion",
    icon: SquareCheck,
    run: (editor, range) => {
      const n = countType(editor, "planAcceptance") + 1
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "planAcceptance",
          attrs: { id: `c${n}`, status: "pending" },
          content: [{ type: "text", text: "New acceptance criterion." }]
        })
        .run()
    }
  },
  {
    title: "Flow diagram",
    hint: "Mermaid diagram",
    icon: Workflow,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: "planDiagram", attrs: { source: "graph TD; A-->B" } })
        .run()
  }
]

/** The imperative handle the suggestion `onKeyDown` calls into. */
export interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean
}

interface SlashMenuProps {
  items: ReadonlyArray<SlashItem>
  command: (item: SlashItem) => void
}

const SlashMenuList = forwardRef<SlashMenuHandle, SlashMenuProps>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0)

  // Reset the cursor to the top whenever the filtered set changes.
  useEffect(() => setSelected(0), [items])

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (items.length === 0) return false
      if (event.key === "ArrowUp") {
        setSelected((i) => (i + items.length - 1) % items.length)
        return true
      }
      if (event.key === "ArrowDown") {
        setSelected((i) => (i + 1) % items.length)
        return true
      }
      if (event.key === "Enter") {
        const item = items[selected]
        if (item) command(item)
        return true
      }
      return false
    }
  }))

  if (items.length === 0) return null

  return (
    <div className="min-w-[15rem] overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-lg">
      {items.map((item, index) => {
        const Icon = item.icon
        const active = index === selected
        return (
          <button
            key={item.title}
            type="button"
            // Choosing an item must not blur the editor before the command runs.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(item)}
            onMouseEnter={() => setSelected(index)}
            className={cn(
              "flex min-h-10 w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-text-body outline-none transition-colors",
              active && "bg-surface text-text-bright"
            )}
          >
            <Icon className="size-4 flex-none text-dim" />
            <span className="flex-none font-medium">{item.title}</span>
            <span className="ml-auto truncate text-pretty text-[10.5px] text-dim">
              {item.hint}
            </span>
          </button>
        )
      })}
    </div>
  )
})
SlashMenuList.displayName = "SlashMenuList"

/**
 * The Tiptap extension: a `/`-triggered suggestion whose items are `SLASH_ITEMS`,
 * filtered by the typed query, rendered by `SlashMenuList` and positioned by the
 * suggestion plugin's managed mount.
 */
export const PlanSlashCommand = Extension.create({
  name: "planSlashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        command: ({ editor, range, props }) => props.run(editor, range),
        items: ({ query }) =>
          SLASH_ITEMS.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())),
        render: () => {
          let component: ReactRenderer<SlashMenuHandle, SlashMenuProps> | null = null
          let unmount: (() => void) | null = null

          return {
            onStart: (props: SuggestionProps<SlashItem, SlashItem>) => {
              component = new ReactRenderer(SlashMenuList, {
                editor: props.editor,
                props: { items: props.items, command: props.command }
              })
              unmount = props.mount(component.element)
            },
            onUpdate: (props: SuggestionProps<SlashItem, SlashItem>) => {
              component?.updateProps({ items: props.items, command: props.command })
            },
            onKeyDown: ({ event }) => {
              if (event.key === "Escape") return true
              return component?.ref?.onKeyDown(event) ?? false
            },
            onExit: () => {
              unmount?.()
              unmount = null
              component?.destroy()
              component = null
            }
          }
        }
      })
    ]
  }
})
