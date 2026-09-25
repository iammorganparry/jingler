import { CodexInbox } from "./inbox.js"
import type { RuntimeMcpServer } from "../mcp/attachment.js"
import type { PermissionsRequestApprovalParams } from "./generated/v2/PermissionsRequestApprovalParams.js"
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js"
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js"
import {
  nativeCliEndpointId,
  type AgentRunSpec,
  type RuntimeContinuation,
  type StreamEvent
} from "@jingler/core"
import { Effect, Stream } from "effect"
import {
  AgentRuntimeError,
  type AgentRuntimeContext,
  type AgentRuntimeRegistration,
  type AgentRuntimeShape
} from "../agent/agent-runtime.js"
import { CodexClient, CodexRpcError, codexEnvironment, type CodexClientOptions, type CodexMessage } from "./client.js"
import { CodexEvents } from "./events.js"
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js"
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js"
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.js"
import type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams.js"
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse.js"
import type { Turn } from "./generated/v2/Turn.js"
import type { JsonValue } from "./generated/serde_json/JsonValue.js"

const failure = (cause: unknown) =>
  cause instanceof AgentRuntimeError
    ? cause
    : new AgentRuntimeError({
        reason: "runtime",
        message:
          cause instanceof CodexRpcError
            ? `Codex RPC failed (${cause.code})`
            : cause instanceof Error
              ? cause.message
              : "Codex runtime failed"
      })
const unsupported = () =>
  Effect.fail(failure(new Error("This operation is unavailable in native Codex")))
const textInput = (text: string) => ({ type: "text" as const, text, text_elements: [] })
const key = (owner: RuntimeContinuation, target: string) =>
  JSON.stringify([target, owner.endpointId, owner.id])

const mcpServerConfig = (
  server: RuntimeMcpServer,
  index: number,
  env: NodeJS.ProcessEnv
): JsonValue => {
  if (server.transport === "stdio") {
    // Config env_vars forwards named inherited values; no credentials in config.
    const names = Object.keys(server.env)
    for (const name of names) {
      if (env[name] !== undefined && env[name] !== server.env[name])
        throw new Error("Conflicting MCP environment")
      env[name] = server.env[name]
    }
    return {
      command: server.command,
      args: [...server.args],
      env_vars: names,
      ...(server.cwd ? { cwd: server.cwd } : {})
    }
  } else {
    if (server.transport === "sse" || server.authProvider || server.oauth)
      throw new Error("Codex MCP attachment requires unsupported SSE/OAuth bridging")
    const headers: Record<string, string> = {}
    for (const [header, value] of Object.entries(server.headers)) {
      const name = `JINGLER_CODEX_MCP_${index}_${Object.keys(headers).length}`
      env[name] = value
      headers[header] = name
    }
    return { url: server.url, env_http_headers: headers }
  }
}

/** Secrets go only into the child's environment, never argv/config/journal. */
export const codexMcpConfig = (context: AgentRuntimeContext, environment: NodeJS.ProcessEnv) => {
  const servers: Record<string, JsonValue> = {}
  const env = codexEnvironment(environment)
  const attachments = [
    ...(context.mcp?.configured ?? []),
    ...(context.mcp?.browser ? [context.mcp.browser] : [])
  ]
  for (const [index, server] of attachments.entries()) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(server.name) || server.name in servers)
      throw new Error("Invalid or duplicate Codex MCP attachment name")
    servers[server.name] = mcpServerConfig(server, index, env)
  }
  return { env, config: { mcp_servers: servers } }
}

const seedPrompt = (spec: AgentRunSpec) => {
  const history = spec.seed?.messages ?? spec.priorMessages
  return history.length === 0
    ? spec.prompt
    : `${history
        .map((message) =>
          JSON.stringify({
            role: message.role,
            text: message.parts
              .flatMap((part) => (part._tag === "Text" ? [part.text] : []))
              .join("\n")
          })
        )
        .join("\n")}\n${spec.prompt}`
}

const permissionResponse = async (
  request: PermissionsRequestApprovalParams,
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  signal: AbortSignal
): Promise<PermissionsRequestApprovalResponse> => {
  const decision =
    spec.mode === "read-only"
      ? "deny"
      : await Effect.runPromise(
          context.canUseTool({
            toolId: request.itemId,
            risk: request.permissions.fileSystem ? "mutate" : "network"
          }),
          { signal }
        )
  return {
    scope: "turn",
    permissions:
      decision === "allow"
        ? {
            ...(request.permissions.network ? { network: request.permissions.network } : {}),
            ...(request.permissions.fileSystem
              ? { fileSystem: request.permissions.fileSystem }
              : {})
          }
        : {}
  }
}

const questionResponse = async (
  request: ToolRequestUserInputParams,
  id: string | number,
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  signal: AbortSignal
): Promise<ToolRequestUserInputResponse> => {
  if (request.questions.some((question) => question.isSecret))
    throw new Error("Secret questions are unsupported")
  const answers = await Effect.runPromise(
    context.askQuestion({
      id: `${spec.runId}:${id}`,
      questions: request.questions.map((question) => ({
        header: question.header,
        question: question.question,
        options: question.options ?? [],
        multiSelect: false
      }))
    }),
    { signal }
  )
  return {
    answers: Object.fromEntries(
      request.questions.map((question, index) => {
        const answer = answers[index]
        return [
          question.id,
          { answers: [...(answer?.selected ?? []), ...(answer?.other ? [answer.other] : [])] }
        ]
      })
    )
  }
}

const answerRequest = async (
  message: CodexMessage,
  turnId: string,
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  client: CodexClient,
  signal: AbortSignal
) => {
  const id = message.id!
  const p = message.params
  if (p.turnId !== turnId) {
    client.reject(id, "Request does not belong to active turn")
    return
  }
  let response: unknown
  switch (message.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      const allowed = spec.mode === "read-only" ? "deny" : await Effect.runPromise(
        context.canUseTool({
          toolId: String(p.itemId),
          risk: message.method === "item/fileChange/requestApproval" ? "mutate" : "execute"
        }),
        { signal }
      )
      response = { decision: allowed === "allow" ? "accept" : "decline" }
      break
    }
    case "item/permissions/requestApproval":
      response = await permissionResponse(
        p as unknown as PermissionsRequestApprovalParams,
        spec,
        context,
        signal
      )
      break
    case "item/tool/requestUserInput":
      response = await questionResponse(
        p as unknown as ToolRequestUserInputParams,
        id,
        spec,
        context,
        signal
      )
      break
    default:
      client.reject(id)
      return
  }
  if (!signal.aborted) client.reply(id, response)
}

const openThread = async (
  client: CodexClient,
  spec: AgentRunSpec,
  config: ThreadStartParams["config"]
) => {
  await client.initialize()
  const account = await client.request<GetAccountResponse>("account/read", { refreshToken: false })
  if (account.account === null && account.requiresOpenaiAuth)
    throw new AgentRuntimeError({
      reason: "authentication",
      message: "Sign in to Codex CLI on this execution target"
    })
  const params: ThreadStartParams = {
    cwd: spec.cwd,
    model: spec.modelId,
    config,
    approvalPolicy: spec.mode === "read-only" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandbox: spec.mode === "read-only" ? "read-only" : "workspace-write"
  }
  let fresh = spec.continuation === null
  let response: { thread: { id: string } }
  if (spec.continuation) {
    try {
      const continuationParams = {
        ...params,
        threadId: spec.continuation.id,
        excludeTurns: true,
        ephemeral: false
      }
      response = await client.request(
        "thread/resume",
        continuationParams
      )
    } catch (cause) {
      // Only a missing persisted thread is recoverable; auth/config errors must surface.
      if (
        !(cause instanceof CodexRpcError) ||
        !/thread[^\n]*(?:not found|does not exist)|no rollout found/iu.test(cause.message)
      )
        throw cause
      fresh = true
      response = await client.request("thread/start", params)
    }
  } else response = await client.request("thread/start", params)
  return { response, fresh }
}

const turnParams = (spec: AgentRunSpec, threadId: string, fresh: boolean): TurnStartParams => ({
  threadId,
  input: [
    textInput(fresh ? seedPrompt(spec) : spec.prompt),
    ...(spec.images ?? []).map((image) => ({
      type: "image" as const,
      url: `data:${image.mediaType};base64,${image.data}`
    }))
  ],
  ...(spec.reasoning
    ? { effort: spec.reasoning.enabled ? (spec.reasoning.effort ?? null) : "none" }
    : {})
})

const completedEvent = (turn: Turn, tokens: number): StreamEvent => {
  if (turn.status === "failed") return { _tag: "Failed", message: "Codex turn failed" }
  if (turn.status === "interrupted")
    throw new AgentRuntimeError({ reason: "interrupted", message: "Codex turn interrupted" })
  return { _tag: "Done", tokens, costUsd: 0 }
}

async function* consume(
  inbox: CodexInbox,
  turnId: string,
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  client: CodexClient,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const events = new CodexEvents()
  const pending = new Set<string | number>()
  for (;;) {
    const message = await inbox.next()
    if (message.id !== undefined) {
      if (pending.size >= 32 || pending.has(message.id))
        throw new Error("Too many or duplicate Codex server requests")
      pending.add(message.id)
      void answerRequest(message, turnId, spec, context, client, signal)
        .catch(() => {
          if (!signal.aborted) inbox.fail(new Error("Codex server request failed"))
        })
        .finally(() => pending.delete(message.id!))
      continue
    }
    if (message.params.turnId !== undefined && message.params.turnId !== turnId) continue
    if (message.method === "turn/completed") {
      const turn = message.params.turn as Turn
      if (turn.id !== turnId) continue
      yield completedEvent(turn, events.tokens)
      return
    }
    yield* events.map(message)
  }
}

interface ActiveTurn {
  client: CodexClient
  turnId: string
}
export const makeCodexAgentRuntime = (options: CodexClientOptions = {}): AgentRuntimeShape => {
  const active = new Map<string, ActiveTurn>()
  const reserved = new Set<string>()
  const control = (continuation: RuntimeContinuation, targetId: string, text?: string) =>
    Effect.tryPromise({
      try: async () => {
        const run = active.get(key(continuation, targetId))
        if (!run) throw new Error("Codex turn is not active")
        if (text === undefined)
          await run.client.request("turn/interrupt", {
            threadId: continuation.id,
            turnId: run.turnId
          })
        else
          await run.client.request("turn/steer", {
            threadId: continuation.id,
            expectedTurnId: run.turnId,
            input: [textInput(text)]
          } satisfies TurnSteerParams)
      },
      catch: failure
    })
  return {
    run: (spec, context) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          // No supported policy guarantees approval for every edit and command.
          // In particular, workspace-write + untrusted can auto-approve edits.
          if (spec.mode === "ask" || spec.mode === "accept-edits")
            return yield* Effect.fail(new AgentRuntimeError({
              reason: "runtime",
              message: `${spec.mode} mode is unsupported in native Codex: required approvals cannot be guaranteed`
            }))
          const attachment = yield* Effect.try({
            try: () => codexMcpConfig(context, options.environment ?? process.env),
            catch: failure
          })
          const client = yield* Effect.acquireRelease(
            Effect.try({
              try: () => new CodexClient({
                ...options,
                cwd: spec.cwd,
                // codexMcpConfig already filtered inherited values before adding attachments.
                environment: attachment.env,
                mcpEnvironmentKeys: Object.keys(attachment.env)
              }),
              catch: failure
            }),
            (owned) => Effect.promise(() => owned.close())
          )
          const iterator = run(spec, context, client, attachment.config)
          // Close before iterator.return(undefined): an async generator may be blocked waiting
          // for its next notification, so waiting for return first would deadlock.
          const iterable: AsyncIterable<StreamEvent> = {
            [Symbol.asyncIterator]: () => ({
              next: () => iterator.next(),
              return: async () => {
                await client.close()
                return iterator.return(undefined)
              }
            })
          }
          return Stream.fromAsyncIterable(iterable, failure)
        })
      ),
    steer: (continuation, targetId, text) => control(continuation, targetId, text),
    interrupt: (continuation, targetId) => control(continuation, targetId),
    controlSubagent: unsupported,
    decidePlanReview: unsupported,
    subagentFleetSnapshot: unsupported,
    subagentTranscript: unsupported
  }

  async function* run(
    spec: AgentRunSpec,
    context: AgentRuntimeContext,
    client: CodexClient,
    config: ThreadStartParams["config"]
  ): AsyncGenerator<StreamEvent> {
    const pendingKey = spec.continuation
      ? key(spec.continuation, spec.targetCapabilities.targetId)
      : undefined
    if (pendingKey && reserved.has(pendingKey))
      throw new Error("Codex thread already has an active run")
    if (pendingKey) reserved.add(pendingKey)
    const inbox = new CodexInbox(client)
    const abort = new AbortController()
    let activeKey: string | undefined
    try {
      const { response, fresh } = await openThread(client, spec, config)
      const threadId = response.thread.id
      inbox.threadId = threadId
      const ownerKey = key(
        { runtimeId: "codex", endpointId: spec.endpointId, id: threadId },
        spec.targetCapabilities.targetId
      )
      if (active.has(ownerKey)) throw new Error("Codex thread already active")
      const started = await client.request<{ turn: Turn }>(
        "turn/start",
        turnParams(spec, threadId, fresh)
      )
      const turnId = started.turn.id
      activeKey = ownerKey
      active.set(activeKey, { client, turnId })
      yield { _tag: "Started", sessionId: threadId, model: spec.modelId }
      yield* consume(inbox, turnId, spec, context, client, abort.signal)
    } finally {
      abort.abort()
      inbox.dispose()
      if (activeKey) active.delete(activeKey)
      if (pendingKey) reserved.delete(pendingKey)
    }
  }
}

export const makeCodexRuntimeRegistration = (
  options: CodexClientOptions = {}
): AgentRuntimeRegistration => ({
  runtimeId: "codex",
  runtime: makeCodexAgentRuntime(options),
  ownsEndpoint: (endpointId, targetId) => endpointId === nativeCliEndpointId(targetId, "codex")
})
