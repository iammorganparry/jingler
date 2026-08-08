import { assign, fromPromise, setup } from "xstate"

interface PluginSecretSettingInput {
  readonly configured: boolean
  readonly save: (value: string) => Promise<void>
  readonly clear: () => Promise<void>
}

interface PluginSecretSettingContext extends PluginSecretSettingInput {
  readonly draft: string
}

type PluginSecretSettingEvent =
  | { readonly type: "CHANGE"; readonly value: string }
  | { readonly type: "REPLACE" }
  | { readonly type: "CANCEL" }
  | { readonly type: "SAVE" }
  | { readonly type: "REMOVE" }

export const pluginSecretSettingMachine = setup({
  types: {
    context: {} as PluginSecretSettingContext,
    events: {} as PluginSecretSettingEvent,
    input: {} as PluginSecretSettingInput
  },
  actors: {
    persist: fromPromise(
      ({ input }: { input: { readonly run: () => Promise<void> } }) => input.run()
    )
  },
  guards: {
    isConfigured: ({ context }) => context.configured,
    hasDraft: ({ context }) => context.draft.length > 0
  },
  actions: {
    change: assign(({ event }) =>
      event.type === "CHANGE" ? { draft: event.value } : {}
    ),
    markConfigured: assign({ configured: true, draft: "" }),
    markRemoved: assign({ configured: false, draft: "" }),
    clearDraft: assign({ draft: "" })
  }
}).createMachine({
  id: "pluginSecretSetting",
  initial: "routing",
  context: ({ input }) => ({ ...input, draft: "" }),
  states: {
    routing: {
      always: [
        { target: "configured", guard: "isConfigured" },
        { target: "editing" }
      ]
    },
    configured: {
      on: {
        REPLACE: { target: "editing", actions: "clearDraft" },
        REMOVE: "removing"
      }
    },
    editing: {
      on: {
        CHANGE: { actions: "change" },
        CANCEL: { target: "configured", guard: "isConfigured", actions: "clearDraft" },
        SAVE: { target: "saving", guard: "hasDraft" }
      }
    },
    saving: {
      invoke: {
        src: "persist",
        input: ({ context }) => ({ run: () => context.save(context.draft) }),
        onDone: { target: "configured", actions: "markConfigured" },
        onError: { target: "editing" }
      }
    },
    removing: {
      invoke: {
        src: "persist",
        input: ({ context }) => ({ run: context.clear }),
        onDone: { target: "editing", actions: "markRemoved" },
        onError: { target: "configured" }
      }
    }
  }
})
