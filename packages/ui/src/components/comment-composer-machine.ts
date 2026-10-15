import { assign, fromPromise, setup } from "xstate"

export interface CommentComposerInput {
  /** Post `body`; when `close` is true the issue is closed with the comment. Rejects with a readable Error. */
  readonly post: (body: string, close: boolean) => Promise<void>
}

interface Context extends CommentComposerInput {
  readonly draft: string
  readonly error: string | null
}

type Event =
  | { readonly type: "CHANGE"; readonly draft: string }
  | { readonly type: "SUBMIT"; readonly close: boolean }

export const commentComposerMachine = setup({
  types: { context: {} as Context, events: {} as Event, input: {} as CommentComposerInput },
  actors: {
    post: fromPromise<void, { post: CommentComposerInput["post"]; body: string; close: boolean }>(
      ({ input }) => input.post(input.body, input.close)
    )
  }
}).createMachine({
  id: "commentComposer",
  initial: "idle",
  context: ({ input }) => ({ post: input.post, draft: "", error: null }),
  states: {
    idle: {
      on: {
        CHANGE: { actions: assign({ draft: ({ event }) => event.draft, error: null }) },
        SUBMIT: { guard: ({ context }) => context.draft.trim().length > 0, target: "posting" }
      }
    },
    posting: {
      entry: assign({ error: null }),
      invoke: {
        src: "post",
        input: ({ context, event }) => ({
          post: context.post,
          body: context.draft,
          close: event.type === "SUBMIT" && event.close
        }),
        onDone: { target: "idle", actions: assign({ draft: "" }) },
        // The draft stays so a failed post can be retried without retyping.
        onError: {
          target: "idle",
          actions: assign({
            error: ({ event }) => (event.error instanceof Error ? event.error.message : String(event.error))
          })
        }
      }
    }
  }
})
