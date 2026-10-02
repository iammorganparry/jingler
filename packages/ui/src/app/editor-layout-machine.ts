import { assign, createActor, setup } from "xstate"
import { useSelector } from "@xstate/react"
import { removeEditorLayout, saveEditorLayout, type EditorLayout } from "./editor-layout.js"

export interface EditorLayoutsContext {
  readonly layouts: Readonly<Record<string, EditorLayout>>
}

export type EditorLayoutsEvent =
  | { readonly type: "INIT"; readonly sessionId: string; readonly layout: EditorLayout }
  | { readonly type: "UPDATE"; readonly sessionId: string; readonly update: (layout: EditorLayout) => EditorLayout }
  | { readonly type: "FORGET"; readonly sessionId: string }
  | { readonly type: "RESET" }

const pendingUpdates = new WeakMap<object, EditorLayout>()

export const editorLayoutsMachine = setup({
  types: { context: {} as EditorLayoutsContext, events: {} as EditorLayoutsEvent }
}).createMachine({
  id: "editorLayouts",
  context: { layouts: {} },
  on: {
    INIT: {
      guard: ({ context, event }) => context.layouts[event.sessionId] === undefined,
      actions: assign({ layouts: ({ context, event }) => ({ ...context.layouts, [event.sessionId]: event.layout }) })
    },
    UPDATE: {
      guard: ({ context, event }) => {
        const current = context.layouts[event.sessionId]
        if (!current) return false
        const next = event.update(current)
        if (next === current) return false
        pendingUpdates.set(event, next)
        return true
      },
      actions: assign({
        layouts: ({ context, event }) => {
          const next = pendingUpdates.get(event)
          pendingUpdates.delete(event)
          if (!next) return context.layouts
          saveEditorLayout(event.sessionId, next)
          return { ...context.layouts, [event.sessionId]: next }
        }
      })
    },
    RESET: { actions: assign({ layouts: () => ({}) }) },
    FORGET: {
      actions: assign({
        layouts: ({ context, event }) => {
          if (context.layouts[event.sessionId] === undefined) return context.layouts
          const { [event.sessionId]: _, ...rest } = context.layouts
          removeEditorLayout(event.sessionId)
          return rest
        }
      })
    }
  }
})

export const editorLayouts = createActor(editorLayoutsMachine).start()

export const initEditorLayout = (sessionId: string, layout: EditorLayout): void =>
  editorLayouts.send({ type: "INIT", sessionId, layout })

export const updateEditorLayout = (sessionId: string, update: (layout: EditorLayout) => EditorLayout): void =>
  editorLayouts.send({ type: "UPDATE", sessionId, update })

export const forgetEditorLayout = (sessionId: string): void =>
  editorLayouts.send({ type: "FORGET", sessionId })

export const editorLayoutOf = (sessionId: string): EditorLayout | undefined =>
  editorLayouts.getSnapshot().context.layouts[sessionId]

export const useEditorLayout = (sessionId: string): EditorLayout | undefined =>
  useSelector(editorLayouts, (snapshot) => snapshot.context.layouts[sessionId])

export const resetEditorLayouts = (): void => editorLayouts.send({ type: "RESET" })
