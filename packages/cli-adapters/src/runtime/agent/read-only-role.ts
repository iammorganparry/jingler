import type { AgentRole, Session } from "@jingler/core"
import { CURRENT_RUNTIME_CONTRACTS, piEndpointId } from "@jingler/core"
import { Duration, Effect, Stream } from "effect"
import {
  AgentRuntimeError,
  inactiveRuntimeActivity,
  type AgentRuntimeShape
} from "./agent-runtime.js"

const canonicalIdentity = (session: Session) => {
  const chat = session.chats.find((candidate) => candidate.id === session.activeChatId)
  const connectionId = chat?.connectionId ?? session.connectionId
  return {
    runtimeId: chat?.runtimeId ?? session.runtimeId ?? "pi",
    endpointId: chat?.endpointId ?? session.endpointId ?? (
      connectionId === undefined
        ? undefined
        : piEndpointId(session.environmentId ?? "desktop", connectionId)
    ),
    connectionId,
    providerId: chat?.providerId ?? session.providerId,
    modelId: chat?.modelId ?? session.modelId
  }
}

/** Run a fresh non-mutating background role through the session's pinned runtime identity. */
export const runReadOnlyRoleText = (
  runtime: AgentRuntimeShape,
  session: Session,
  role: Extract<AgentRole, "title" | "background">,
  prompt: string,
  timeout: Duration.DurationInput
) => {
  const identity = canonicalIdentity(session)
  if (
    identity.endpointId === undefined ||
    identity.modelId === undefined ||
    (identity.runtimeId === "pi" && identity.connectionId === undefined)
  ) {
    return Effect.fail(
      new AgentRuntimeError({
        reason: "authentication",
        message: "The session has no canonical provider connection"
      })
    )
  }

  return runtime
    .run(
      {
        runId: randomUUID(),
        sessionId: session.id,
        chatId: session.activeChatId,
        runtimeId: identity.runtimeId,
        endpointId: identity.endpointId,
        connectionId: identity.connectionId,
        providerId: identity.providerId,
        modelId: identity.modelId,
        role,
        mode: "read-only",
        cwd: session.worktreePath ?? process.cwd(),
        prompt,
        priorMessages: [],
        continuation: null,
        seed: null,
        targetCapabilities: {
          versions: CURRENT_RUNTIME_CONTRACTS,
          toolIds: [],
          resourceIds: [],
          targetId: session.environmentId ?? "desktop"
        }
      },
      {
        ...inactiveRuntimeActivity,
        canUseTool: () => Effect.succeed("deny"),
        askQuestion: () => Effect.succeed([]),
      }
    )
    .pipe(
      Stream.runFold("", (text, event) => (event._tag === "Assistant" ? text + event.text : text)),
      Effect.timeout(timeout)
    )
}
import { randomUUID } from "node:crypto"
