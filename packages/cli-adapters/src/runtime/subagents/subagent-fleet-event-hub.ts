import type { StreamEvent } from "@jingler/core"
import { Context, Effect, Layer, Ref } from "effect"

export interface SubagentFleetEventHubShape {
  readonly subscribe: (
    listener: (event: StreamEvent) => void
  ) => Effect.Effect<() => void>
  readonly publish: (event: StreamEvent) => Effect.Effect<void>
  readonly clear: Effect.Effect<void>
}

export class SubagentFleetEventHub extends Context.Tag(
  "@jingler/SubagentFleetEventHub"
)<SubagentFleetEventHub, SubagentFleetEventHubShape>() {}

export const makeSubagentFleetEventHub = (): Effect.Effect<
  SubagentFleetEventHubShape
> => Effect.gen(function* () {
  const listeners = yield* Ref.make<ReadonlySet<(event: StreamEvent) => void>>(
    new Set()
  )
  return {
    subscribe: (listener) => Ref.updateAndGet(listeners, (current) =>
      new Set([...current, listener])
    ).pipe(Effect.as(() => {
      Effect.runSync(Ref.update(listeners, (current) => {
        const next = new Set(current)
        next.delete(listener)
        return next
      }))
    })),
    publish: (event) => Ref.get(listeners).pipe(
      Effect.flatMap((current) => Effect.forEach(
        current,
        (listener) => Effect.sync(() => listener(event)),
        { discard: true }
      ))
    ),
    clear: Ref.set(listeners, new Set())
  }
})

export const SubagentFleetEventHubLive = Layer.effect(
  SubagentFleetEventHub,
  makeSubagentFleetEventHub()
)
