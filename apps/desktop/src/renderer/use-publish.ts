import type { Session } from "@jingler/core"
import { useMachine } from "@xstate/react"
import { useMemo } from "react"
import { createRendererPublishMachine } from "./publish-machine.js"
import { rpc } from "./rpc-client.js"

export const usePublish = (
  session: Session,
  onPrLinked?: (sessionId: string, prNumber: number) => void,
  onCheckpoint?: (sessionId: string, checkpoint: NonNullable<Session["publish"]>) => void
) => {
  const machine = useMemo(() => createRendererPublishMachine(session.publish, {
    subscribe: (listener) => rpc.githubPublish(session.id, (checkpoint) => {
      onCheckpoint?.(session.id, checkpoint)
      listener(checkpoint)
    }),
    onComplete: (checkpoint) => {
      if (checkpoint.prNumber !== undefined) onPrLinked?.(session.id, checkpoint.prNumber)
    }
  }), [session.id, onCheckpoint, onPrLinked])
  const [snapshot, send] = useMachine(machine)
  return {
    checkpoint: snapshot.context.checkpoint,
    publishing: snapshot.matches("publishing"),
    publish: () => send({ type: "PUBLISH" }),
    retry: () => send({ type: "RETRY" })
  }
}
