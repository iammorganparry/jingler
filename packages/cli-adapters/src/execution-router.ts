import type { Session } from "@jingler/core"
import { executionTargetOf } from "@jingler/core"
import type { Effect } from "effect"

export interface SessionExecutor<A, E = never, R = never> {
  readonly execute: (session: Session, operation: string, payload: unknown) => Effect.Effect<A, E, R>
}

/** The sole execution-location branch. A remote failure is never retried locally. */
export const routeSessionOperation = <A, E1, R1, E2, R2>(
  session: Session,
  operation: string,
  payload: unknown,
  local: SessionExecutor<A, E1, R1>,
  remote: SessionExecutor<A, E2, R2>
): Effect.Effect<A, E1 | E2, R1 | R2> =>
  executionTargetOf(session).kind === "local"
    ? local.execute(session, operation, payload)
    : remote.execute(session, operation, payload)
