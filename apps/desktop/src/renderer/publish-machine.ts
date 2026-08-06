import type { PublishCheckpoint } from "@jingler/core"
import { assign, fromCallback, setup } from "xstate"

export interface PublishMachineDependencies {
  readonly subscribe: (listener: (checkpoint: PublishCheckpoint) => void) => () => void
  readonly onComplete: (checkpoint: PublishCheckpoint) => void
}

interface PublishContext {
  checkpoint: PublishCheckpoint | null
}

type PublishEvent =
  | { readonly type: "PUBLISH" }
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
    publish: fromCallback(({ sendBack }) =>
      dependencies.subscribe((checkpoint) => sendBack({ type: "CHECKPOINT", checkpoint })))
  },
  actions: {
    saveCheckpoint: assign({ checkpoint: ({ event }) =>
      event.type === "CHECKPOINT" ? event.checkpoint : null }),
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
    idle: { on: { PUBLISH: "publishing" } },
    publishing: {
      invoke: { src: "publish" },
      on: {
        CHECKPOINT: [
          { guard: "failed", target: "failed", actions: "saveCheckpoint" },
          { guard: "complete", target: "complete", actions: ["saveCheckpoint", "notifyComplete"] },
          { guard: "noChanges", target: "no-changes", actions: "saveCheckpoint" },
          { actions: "saveCheckpoint" }
        ]
      }
    },
    failed: { on: { RETRY: "publishing", PUBLISH: "publishing" } },
    complete: { on: { PUBLISH: "publishing" } },
    "no-changes": { on: { PUBLISH: "publishing" } }
  }
})
