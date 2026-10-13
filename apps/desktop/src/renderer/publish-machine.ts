import type { PublishCheckpoint } from "@jingler/core"
import { assign, fromCallback, setup } from "xstate"

export interface PublishMachineDependencies {
  readonly subscribe: (listener: (checkpoint: PublishCheckpoint) => void, base?: string) => () => void
  readonly onComplete: (checkpoint: PublishCheckpoint) => void
}

interface PublishContext {
  checkpoint: PublishCheckpoint | null
  base?: string
}

type PublishEvent =
  | { readonly type: "PUBLISH"; readonly base?: string }
  | { readonly type: "RETRY" }
  | { readonly type: "CHECKPOINT"; readonly checkpoint: PublishCheckpoint }

export const createRendererPublishMachine = (
  initial: PublishCheckpoint | undefined,
  dependencies: PublishMachineDependencies
) => setup({
  types: {
    context: {} as PublishContext,
    events: {} as PublishEvent
  },
  actors: {
    publish: fromCallback<PublishEvent, { base?: string }>(({ input, sendBack }) =>
      dependencies.subscribe((checkpoint) => sendBack({ type: "CHECKPOINT", checkpoint }), input?.base))
  },
  actions: {
    saveCheckpoint: assign({ checkpoint: ({ event }) =>
      event.type === "CHECKPOINT" ? event.checkpoint : null }),
    setBase: assign({ base: ({ event }) =>
      event.type === "PUBLISH" ? event.base : undefined }),
    notifyComplete: ({ event }) => {
      if (event.type === "CHECKPOINT") dependencies.onComplete(event.checkpoint)
    }
  },
  guards: {
    failed: ({ event }) => event.type === "CHECKPOINT" && event.checkpoint.step === "failed",
    complete: ({ event }) => event.type === "CHECKPOINT" && event.checkpoint.step === "complete",
    noChanges: ({ event }) => event.type === "CHECKPOINT" && event.checkpoint.step === "no-changes"
  }
}).createMachine({
  id: "renderer-publish",
  initial: initial?.step === "failed" ? "failed" : initial?.step === "complete" ? "complete" : "idle",
  context: { checkpoint: initial ?? null },
  states: {
    idle: { on: { PUBLISH: { target: "publishing", actions: "setBase" } } },
    publishing: {
      invoke: { src: "publish", input: ({ context }) => ({ base: context.base }) },
      on: {
        CHECKPOINT: [
          { guard: "failed", target: "failed", actions: "saveCheckpoint" },
          { guard: "complete", target: "complete", actions: ["saveCheckpoint", "notifyComplete"] },
          { guard: "noChanges", target: "no-changes", actions: "saveCheckpoint" },
          { actions: "saveCheckpoint" }
        ]
      }
    },
    failed: { on: { RETRY: "publishing", PUBLISH: { target: "publishing", actions: "setBase" } } },
    complete: { on: { PUBLISH: { target: "publishing", actions: "setBase" } } },
    "no-changes": { on: { PUBLISH: { target: "publishing", actions: "setBase" } } }
  }
})
