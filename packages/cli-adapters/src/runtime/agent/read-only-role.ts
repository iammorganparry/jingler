import type { AgentRole, Session } from "@jingler/core"
import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import { Duration, Effect, Stream } from "effect"
import {
  AgentRuntimeError,
  inactiveRuntimeActivity,
  type AgentRuntimeShape
} from "./agent-runtime.js"

const canonicalIdentity = (session: Session) => {
  const chat = session.chats.find((candidate) => candidate.id === session.activeChatId)
  return {
    connectionId: chat?.connectionId ?? session.connectionId,
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
  if (identity.connectionId === undefined || identity.modelId === undefined) {
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
        connectionId: identity.connectionId,
        modelId: identity.modelId,
        role,
        mode: "read-only",
        cwd: session.worktreePath ?? process.cwd(),
        prompt,
        priorMessages: [],
        piSessionId: null,
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
        saveDraftPlan: () => Effect.void,
        proposePlan: () => Effect.succeed({ _tag: "Reject" })
      }
    )
    .pipe(
      Stream.runFold("", (text, event) => (event._tag === "Assistant" ? text + event.text : text)),
      Effect.timeout(timeout)
    )
}
import { randomUUID } from "node:crypto"
