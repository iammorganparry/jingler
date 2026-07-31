import { assign, fromPromise, setup } from "xstate"

export interface PlanCommentMention {
  readonly routingId: string
  readonly token: string
}

interface PlanCommentComposerContext {
  readonly value: string
  readonly mentioned: ReadonlyArray<PlanCommentMention>
  readonly activeIndex: number
  readonly getOnSubmit: () => (
    body: string,
    mentionedParticipantIds: ReadonlyArray<string>
  ) => Promise<boolean | void> | boolean | void
}

type PlanCommentComposerEvent =
  | { readonly type: "change"; readonly value: string }
  | {
      readonly type: "choose"
      readonly value: string
      readonly mention: PlanCommentMention
    }
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "submit" }

export const planCommentComposerMachine = setup({
  types: {
    context: {} as PlanCommentComposerContext,
    events: {} as PlanCommentComposerEvent,
    input: {} as Pick<PlanCommentComposerContext, "getOnSubmit">
  },
  actors: {
    submit: fromPromise(
      ({
        input
      }: {
        input: {
          readonly run: () => Promise<boolean>
        }
      }) => input.run()
    )
  },
  guards: {
    hasContent: ({ context }) => context.value.trim().length > 0
  },
  actions: {
    change: assign(({ context, event }) => {
      if (event.type !== "change") return {}
      return {
        value: event.value,
        mentioned: context.mentioned.filter(({ token }) =>
          containsMentionToken(event.value, token)
        ),
        activeIndex: 0
      }
    }),
    choose: assign(({ context, event }) => {
      if (event.type !== "choose") return {}
      return {
        value: event.value,
        mentioned: context.mentioned.some(
          ({ routingId }) => routingId === event.mention.routingId
        )
          ? context.mentioned
          : [...context.mentioned, event.mention],
        activeIndex: 0
      }
    }),
    move: assign(({ event }) =>
      event.type === "move" ? { activeIndex: event.index } : {}
    ),
    clear: assign({ value: "", mentioned: [], activeIndex: 0 })
  }
}).createMachine({
  id: "planCommentComposer",
  initial: "editing",
  context: ({ input }) => ({
    value: "",
    mentioned: [],
    activeIndex: 0,
    getOnSubmit: input.getOnSubmit
  }),
  states: {
    editing: {
      on: {
        change: { actions: "change" },
        choose: { actions: "choose" },
        move: { actions: "move" },
        submit: { target: "submitting", guard: "hasContent" }
      }
    },
    submitting: {
      invoke: {
        src: "submit",
        input: ({ context }) => ({
          run: async () => {
            const result = await context.getOnSubmit()(
              context.value.trim(),
              context.mentioned.map(({ routingId }) => routingId)
            )
            if (result === false) throw new Error("Comment submission failed")
            return true
          }
        }),
        onDone: { target: "editing", actions: "clear" },
        onError: { target: "editing" }
      }
    }
  }
})

const containsMentionToken = (value: string, token: string): boolean => {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?:^|\\s)${escaped}(?=$|\\s|[.,!?;:()\\[\\]{}])`
  ).test(value)
}
