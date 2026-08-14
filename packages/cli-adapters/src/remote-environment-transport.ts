import type { RemoteSessionEvent, Session } from "@jingler/core"
import type { Stream } from "effect"

export type RemoteSessionResource = Pick<
  Session,
  "id" | "environmentId" | "connectionId" | "providerId" | "modelId"
>

/** Provider boundary below the shared remote command/event protocol. */
export interface RemoteEnvironmentTransport<E> {
  readonly execute: (
    session: RemoteSessionResource,
    operation: string,
    payload: unknown,
    commandId?: string
  ) => Stream.Stream<RemoteSessionEvent, E>
}
