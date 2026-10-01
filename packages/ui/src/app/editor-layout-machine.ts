/**
 * Every session's editor layout, in one app-wide actor.
 *
 * App-wide rather than per pane because two readers need the same layout: the
 * session's editor groups and its sidebar tree. The rules live in the pure
 * reducers of `editor-layout.ts`; this only stores their results and mirrors
 * each change to localStorage.
 */
import { assign, createActor, setup } from "xstate"
import { useSelector } from "@xstate/react"
import { saveEditorLayout, type EditorLayout } from "./editor-layout.js"

export interface EditorLayoutsContext {
  readonly layouts: Readonly<Record<string, EditorLayout>>
}

export type EditorLayoutsEvent =
  /** Seed a session's layout (restored from storage) unless one is already held. */
  | { readonly type: "INIT"; readonly sessionId: string; readonly layout: EditorLayout }
  /** Apply a reducer to a held layout. A no-op reducer (same object) changes nothing. */
  | { readonly type: "UPDATE"; readonly sessionId: string; readonly update: (layout: EditorLayout) => EditorLayout }
  | { readonly type: "FORGET"; readonly sessionId: string }

export const editorLayoutsMachine = setup({
  types: { context: {} as EditorLayoutsContext, events: {} as EditorLayoutsEvent },
  actions: {
    persist: (_, params: { sessionId: string; layout: EditorLayout }) => saveEditorLayout(params.sessionId, params.layout)
  }
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
        return current !== undefined && event.update(current) !== current
      },
      actions: [
        assign({
          layouts: ({ context, event }) => ({
            ...context.layouts,
            [event.sessionId]: event.update(context.layouts[event.sessionId]!)
          })
        }),
        {
          type: "persist",
          params: ({ context, event }) => ({ sessionId: event.sessionId, layout: context.layouts[event.sessionId]! })
        }
      ]
    },
    FORGET: {
      actions: assign({
        layouts: ({ context, event }) => {
          const { [event.sessionId]: _, ...rest } = context.layouts
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

export const editorLayoutOf = (sessionId: string): EditorLayout | undefined =>
  editorLayouts.getSnapshot().context.layouts[sessionId]

/** Re-renders only when THIS session's layout object changes. */
export const useEditorLayout = (sessionId: string): EditorLayout | undefined =>
  useSelector(editorLayouts, (snapshot) => snapshot.context.layouts[sessionId])
