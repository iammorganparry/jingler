/**
 * The extension host: the Node process a plugin's `main` half runs inside.
 *
 * ## What this file is
 *
 * It is the other end of `plugin-host-protocol.ts`. It receives `activate`,
 * imports the plugin's entry, builds the {@link HostContext} the SDK documents,
 * and calls the plugin's exported `activate`. Everything the context can do that
 * this process cannot do alone — storage, `exec`, credentials — is forwarded to
 * main as a `host-request` and awaited.
 *
 * ## Why every plugin shares one process
 *
 * Isolation between plugins is not the goal here and could not be achieved
 * anyway: plugins are trusted code, the same position VS Code takes. What IS
 * achieved is isolating plugins from *Jingler* — a plugin that hangs or throws
 * takes down this process, not the RPC server every session depends on. Main
 * restarts it and re-activates what was live.
 *
 * ## Why an undeclared command is refused
 *
 * `commands.register` checks the id against the manifest's `contributes.commands`.
 * Without that, a plugin could register anything at import time and the
 * enable/disable switch in Settings would be advisory — the manifest is the
 * contract, and the contract is what the operator is shown.
 */
import { pathToFileURL } from "node:url"
import type {
  ExecReply,
  ExecRequest,
  FromHostMessage,
  HostOp,
  ToHostMessage
} from "@jingler/cli-adapters"
import type {
  AgentToolDefinition,
  AgentToolset,
  AuthSession,
  Disposable,
  HostContext,
  IssueAddCommentRequest,
  IssueCreateRequest,
  IssueGetRequest,
  IssueListRequest,
  IssueProvider,
  PluginStorage
} from "@jingler/plugin-sdk/host"

/** The parent port, present because this only ever runs as a utilityProcess. */
declare const process: NodeJS.Process & {
  parentPort: {
    on(event: "message", listener: (message: { data: ToHostMessage }) => void): void
    postMessage(message: FromHostMessage): void
  }
}

const send = (message: FromHostMessage): void => process.parentPort.postMessage(message)
const PROVIDER_TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/u

// ── Asking main for things ───────────────────────────────────────────────────

let nextRequestId = 0
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

/**
 * Forward one operation to main and await its reply.
 *
 * Rejections carry main's message rather than a generic one: a plugin author
 * debugging "why did my exec fail" needs the reason main actually had.
 */
const ask = <T>(pluginId: string, op: HostOp, payload: unknown): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const requestId = `h${++nextRequestId}`
    pending.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject
    })
    send({ kind: "host-request", requestId, pluginId, op, payload })
  })

// ── Per-plugin state ─────────────────────────────────────────────────────────

interface LivePlugin {
  readonly pluginId: string
  readonly declaredCommands: ReadonlySet<string>
  readonly declaredIssueProviders: ReadonlySet<string>
  readonly declaredAgentToolsets: ReadonlySet<string>
  readonly commands: Map<string, (input?: unknown) => unknown | Promise<unknown>>
  readonly agentToolsets: Map<string, AgentToolset>
  readonly issueProviders: Map<string, IssueProvider>
  readonly subscriptions: Disposable[]
  readonly deactivate?: () => void | Promise<void>
}

const live = new Map<string, LivePlugin>()

/**
 * Activations in flight, keyed by plugin id.
 *
 * `live.has(pluginId)` is checked before `await import(entry)` and `live.set`
 * happens after, so two `activate` messages arriving together both passed the
 * check and both imported and called `module.activate(ctx)` — duplicated
 * subscriptions, doubled side effects, last-write-wins command handlers. Main
 * now coalesces concurrent callers too, but this side must hold on its own: the
 * two processes are not one lock.
 */
const activating = new Map<string, Promise<void>>()

const storageFor = (pluginId: string): PluginStorage => ({
  get: <T,>(key: string) =>
    ask<T | undefined>(pluginId, "storage.get", { key }).then((v) => v ?? undefined),
  set: (key: string, value: unknown) =>
    ask<void>(pluginId, "storage.set", { key, value }),
  delete: (key: string) => ask<void>(pluginId, "storage.delete", { key }),
  keys: () => ask<readonly string[]>(pluginId, "storage.keys", {})
})

const buildContext = (plugin: LivePlugin): HostContext => ({
  pluginId: plugin.pluginId,
  storage: storageFor(plugin.pluginId),
  settings: {
    getSecret: (settingId: string) =>
      ask<string | null>(plugin.pluginId, "settings.getSecret", { settingId }).then(
        (value) => value ?? undefined
      )
  },
  issues: {
    registerProvider: (provider) => {
      if (!plugin.declaredIssueProviders.has(provider.id)) {
        throw new Error(
          `Plugin "${plugin.pluginId}" tried to register the issue provider "${provider.id}", which its manifest does not contribute. Add it to contributes.issueProviders.`
        )
      }
      if (plugin.issueProviders.has(provider.id)) {
        throw new Error(
          `Plugin "${plugin.pluginId}" registered the issue provider "${provider.id}" more than once.`
        )
      }
      plugin.issueProviders.set(provider.id, provider)
      return {
        dispose: () => {
          if (plugin.issueProviders.get(provider.id) === provider) {
            plugin.issueProviders.delete(provider.id)
          }
        }
      }
    }
  },
  subscriptions: plugin.subscriptions,

  agentTools: {
    registerToolset: (toolset) => {
      if (!plugin.declaredAgentToolsets.has(toolset.id)) {
        throw new Error(
          `Plugin "${plugin.pluginId}" tried to register agent toolset "${toolset.id}", which its manifest does not contribute. Add it to contributes.agentToolsets.`
        )
      }
      if (plugin.agentToolsets.has(toolset.id)) {
        throw new Error(`Plugin "${plugin.pluginId}" registered agent toolset "${toolset.id}" more than once.`)
      }
      const ids = new Set<string>()
      for (const tool of toolset.tools) {
        if (!PROVIDER_TOOL_ID.test(tool.id)) {
          throw new Error(`Agent tool "${tool.id}" must be a provider-safe id of at most 64 letters, digits, underscores, or hyphens.`)
        }
        if (ids.has(tool.id)) throw new Error(`Agent toolset "${toolset.id}" contains duplicate tool id "${tool.id}".`)
        ids.add(tool.id)
      }
      plugin.agentToolsets.set(toolset.id, toolset)
      return {
        dispose: () => {
          if (plugin.agentToolsets.get(toolset.id) === toolset) plugin.agentToolsets.delete(toolset.id)
        }
      }
    }
  },

  commands: {
    register: (commandId, handler) => {
      if (!plugin.declaredCommands.has(commandId)) {
        // Refused rather than allowed-with-a-warning: the manifest is what the
        // operator sees in Settings, so a command that exists but is not listed
        // there would be a capability they never agreed to.
        throw new Error(
          `Plugin "${plugin.pluginId}" tried to register the command "${commandId}", which its manifest does not contribute. Add it to contributes.commands.`
        )
      }
      plugin.commands.set(commandId, handler)
      return {
        dispose: () => {
          plugin.commands.delete(commandId)
        }
      }
    }
  },

  events: {
    // Session-lifecycle events are not emitted yet; the subscription is real so
    // a plugin written against it works unchanged when they are, rather than
    // needing to discover a missing method at runtime.
    on: () => ({ dispose: () => {} })
  },

  // Mirrors VS Code: prompting is the default and a declined prompt REJECTS,
  // so the common call site needs no null check. `createIfNone: false` is the
  // opt-in "tell me if there is already a grant" form, which resolves undefined.
  //
  // The translation happens HERE and nowhere else. `PluginAuth` answers a plain
  // question with a plain answer — null means "no session" — and main forwards
  // that verbatim. Without this wrapper the prompting overload handed a plugin
  // `null` while its TYPE promised an `AuthSession`, so code written to the
  // documented contract (including this repo's own github-issues plugin) hit
  // "Cannot read properties of null" instead of the rejection the docs, the
  // types and three separate comments all describe.
  authentication: {
    getSession: (async (
      providerId: string,
      scopes: readonly string[],
      opts?: { createIfNone?: boolean }
    ) => {
      const session = await ask<AuthSession | null | undefined>(
        plugin.pluginId,
        "auth.getSession",
        { providerId, scopes, createIfNone: opts?.createIfNone }
      )
      if (session) return session
      // The non-prompting form is allowed to answer "there is no grant".
      if (opts?.createIfNone === false) return undefined
      throw new Error(
        `Access to "${providerId}" was declined, or no credentials are available. ` +
          `Pass { createIfNone: false } to ask without prompting.`
      )
    }) as HostContext["authentication"]["getSession"],
    registerProvider: () => {
      // Loud, not silent. The manifest accepts `contributes.authenticationProviders`
      // and the SDK documents a worked example, but nothing forwards a provider
      // to `PluginAuth` — and the two `AuthProvider` shapes do not even match
      // (the SDK's getSessions/createSession versus cli-adapters' getToken). A
      // plugin that believed this worked would watch every consumer get "no
      // authentication provider with id X" and have nothing to debug.
      throw new Error(
        "authentication.registerProvider is not implemented yet. Contributed auth providers are not supported in this build; remove `contributes.authenticationProviders` from your manifest."
      )
    }
  },

  exec: (command, args = [], options = {}) =>
    ask<ExecReply>(plugin.pluginId, "exec", {
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      timeoutMs: options.timeoutMs
    } satisfies ExecRequest),

  log: {
    info: (message: string) =>
      send({ kind: "log", pluginId: plugin.pluginId, level: "info", message }),
    warn: (message: string) =>
      send({ kind: "log", pluginId: plugin.pluginId, level: "warn", message }),
    error: (message: string) =>
      send({ kind: "log", pluginId: plugin.pluginId, level: "error", message })
  }
})

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null

const repositoryOf = (value: unknown): IssueListRequest["repository"] => {
  const repository = recordOf(value)
  if (typeof repository?.name !== "string" || typeof repository.path !== "string") {
    throw new Error("Issue provider request has an invalid repository context.")
  }
  return { name: repository.name, path: repository.path }
}

const issueListRequestOf = (value: unknown): IssueListRequest => {
  const request = recordOf(value)
  if (typeof request?.search !== "string" || typeof request.mine !== "boolean") {
    throw new Error("Issue provider list request is invalid.")
  }
  return {
    repository: repositoryOf(request.repository),
    search: request.search,
    mine: request.mine
  }
}

const issueGetRequestOf = (value: unknown): IssueGetRequest => {
  const request = recordOf(value)
  if (typeof request?.issueId !== "string") {
    throw new Error("Issue provider get request is invalid.")
  }
  return { repository: repositoryOf(request.repository), issueId: request.issueId }
}

const issueCreateRequestOf = (value: unknown): IssueCreateRequest => {
  const request = recordOf(value)
  if (typeof request?.title !== "string" || typeof request.body !== "string") {
    throw new Error("Issue provider create request is invalid.")
  }
  return {
    repository: repositoryOf(request.repository),
    title: request.title,
    body: request.body
  }
}

const issueAddCommentRequestOf = (value: unknown): IssueAddCommentRequest => {
  const request = recordOf(value)
  if (typeof request?.issueId !== "string" || typeof request.body !== "string") {
    throw new Error("Issue provider comment request is invalid.")
  }
  return {
    repository: repositoryOf(request.repository),
    issueId: request.issueId,
    body: request.body
  }
}

// ── Message handling ─────────────────────────────────────────────────────────

const activate = async (message: Extract<ToHostMessage, { kind: "activate" }>) => {
  const { requestId, pluginId } = message

  const inFlight = activating.get(pluginId)
  if (inFlight) {
    // Join it rather than starting a second. Whichever way it settles, this
    // caller gets the same answer the first one did.
    await inFlight.then(
      () => send({ kind: "activated", requestId, pluginId }),
      (cause: unknown) =>
        send({ kind: "activation-failed", requestId, pluginId, message: messageOf(cause) })
    )
    return
  }

  const run = runActivation(message)
  activating.set(pluginId, run)
  try {
    await run
    send({ kind: "activated", requestId, pluginId })
  } catch (cause) {
    send({ kind: "activation-failed", requestId, pluginId, message: messageOf(cause) })
  } finally {
    activating.delete(pluginId)
  }
}

/** Import and activate once. Throws on failure; the caller reports it. */
const runActivation = async (
  message: Extract<ToHostMessage, { kind: "activate" }>
): Promise<void> => {
  const { pluginId, entry, declaredCommands, declaredIssueProviders, declaredAgentToolsets } = message

  if (live.has(pluginId)) {
    // Already activated. Idempotent rather than an error: several activation
    // events can fire for one plugin (its tab AND its command), and racing them
    // is normal rather than exceptional.
    return
  }

  const plugin: LivePlugin = {
    pluginId,
    declaredCommands: new Set(declaredCommands),
    declaredIssueProviders: new Set(declaredIssueProviders),
    declaredAgentToolsets: new Set(declaredAgentToolsets),
    commands: new Map(),
    agentToolsets: new Map(),
    issueProviders: new Map(),
    subscriptions: []
  }

  try {
    // `pathToFileURL` because a Windows path is not a valid import specifier —
    // `import("C:\\...")` throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
    const module = (await import(pathToFileURL(entry).href)) as {
      activate?: (ctx: HostContext) => void | Promise<void>
      deactivate?: () => void | Promise<void>
    }

    if (typeof module.activate !== "function") {
      throw new Error(
        `${entry} does not export an \`activate\` function. A plugin's main entry must \`export const activate: Activate = …\`.`
      )
    }

    live.set(pluginId, { ...plugin, deactivate: module.deactivate })
    await module.activate(buildContext(plugin))
    const missingProvider = [...plugin.declaredIssueProviders].find(
      (providerId) => !plugin.issueProviders.has(providerId)
    )
    if (missingProvider) {
      throw new Error(
        `Plugin "${pluginId}" declares the issue provider "${missingProvider}" but activate() did not register it with issues.registerProvider.`
      )
    }
    const missingToolset = [...plugin.declaredAgentToolsets].find(
      (toolsetId) => !plugin.agentToolsets.has(toolsetId)
    )
    if (missingToolset) {
      throw new Error(
        `Plugin "${pluginId}" declares agent toolset "${missingToolset}" but activate() did not register it with agentTools.registerToolset.`
      )
    }
  } catch (cause) {
    // Dropped from `live` so a later activation event can try again — a plugin
    // that failed because a file was mid-save should not stay dead until the
    // app restarts.
    live.delete(pluginId)
    throw cause
  }
}

const deactivate = async (message: Extract<ToHostMessage, { kind: "deactivate" }>) => {
  const { requestId, pluginId } = message
  const plugin = live.get(pluginId)
  live.delete(pluginId)

  if (plugin) {
    // Reverse order, mirroring VS Code: a subscription registered later may
    // depend on one registered earlier.
    for (const subscription of [...plugin.subscriptions].reverse()) {
      try {
        subscription.dispose()
      } catch (cause) {
        send({
          kind: "log",
          pluginId,
          level: "warn",
          message: `dispose threw during deactivate: ${messageOf(cause)}`
        })
      }
    }
    try {
      await plugin.deactivate?.()
    } catch (cause) {
      send({
        kind: "log",
        pluginId,
        level: "warn",
        message: `deactivate threw: ${messageOf(cause)}`
      })
    }
  }

  send({ kind: "deactivated", requestId, pluginId })
}

const invoke = async (message: Extract<ToHostMessage, { kind: "invoke" }>) => {
  const { requestId, pluginId, commandId, arg } = message
  const handler = live.get(pluginId)?.commands.get(commandId)

  if (!handler) {
    send({
      kind: "invoke-result",
      requestId,
      ok: false,
      message: live.has(pluginId)
        ? `"${commandId}" is not registered. The plugin activated but never called commands.register for it.`
        : `"${pluginId}" is not activated, so "${commandId}" cannot run.`
    })
    return
  }

  try {
    const value = await handler(arg)
    send({ kind: "invoke-result", requestId, ok: true, value })
  } catch (cause) {
    send({ kind: "invoke-result", requestId, ok: false, message: messageOf(cause) })
  }
}

const descriptorOf = (tool: AgentToolDefinition) => ({
  id: tool.id,
  description: tool.description,
  inputSchema: tool.inputSchema,
  risk: tool.risk,
  timeoutMs: tool.timeoutMs ?? 30_000,
  outputBudget: tool.outputBudget ?? 16_000,
  cancellable: tool.cancellable ?? true,
  idempotency: tool.idempotency ?? "unsafe" as const
})

const loadAgentToolset = (
  message: Extract<ToHostMessage, { kind: "agent-toolset-load" }>
): void => {
  const toolset = live.get(message.pluginId)?.agentToolsets.get(message.toolsetId)
  if (!toolset) {
    send({
      kind: "agent-toolset-result",
      requestId: message.requestId,
      ok: false,
      message: `Agent toolset "${message.toolsetId}" is not registered by plugin "${message.pluginId}".`
    })
    return
  }
  send({
    kind: "agent-toolset-result",
    requestId: message.requestId,
    ok: true,
    tools: toolset.tools.map(descriptorOf)
  })
}

const invokeAgentTool = async (
  message: Extract<ToHostMessage, { kind: "agent-tool-invoke" }>
): Promise<void> => {
  const toolset = live.get(message.pluginId)?.agentToolsets.get(message.toolsetId)
  const tool = toolset?.tools.find((candidate) => candidate.id === message.toolId)
  if (!tool) {
    send({
      kind: "agent-tool-result",
      requestId: message.requestId,
      ok: false,
      message: `Agent tool "${message.toolId}" is not registered in toolset "${message.toolsetId}".`
    })
    return
  }
  try {
    const value = await tool.execute(message.input, new AbortController().signal)
    send({ kind: "agent-tool-result", requestId: message.requestId, ok: true, value })
  } catch (cause) {
    send({ kind: "agent-tool-result", requestId: message.requestId, ok: false, message: messageOf(cause) })
  }
}

const invokeIssueProvider = async (
  message: Extract<ToHostMessage, { kind: "issue-provider-invoke" }>
) => {
  const { requestId, pluginId, providerId, method, input } = message
  const provider = live.get(pluginId)?.issueProviders.get(providerId)
  if (!provider) {
    send({
      kind: "issue-provider-result",
      requestId,
      ok: false,
      message: live.has(pluginId)
        ? `Issue provider "${providerId}" is not registered by plugin "${pluginId}".`
        : `Plugin "${pluginId}" is not activated.`
    })
    return
  }

  try {
    const value = await (() => {
      switch (method) {
        case "listIssues":
          return provider.listIssues(issueListRequestOf(input))
        case "getIssue":
          return provider.getIssue(issueGetRequestOf(input))
        case "createIssue":
          return provider.createIssue(issueCreateRequestOf(input))
        case "addComment":
          return provider.addComment(issueAddCommentRequestOf(input))
      }
    })()
    send({ kind: "issue-provider-result", requestId, ok: true, value })
  } catch (cause) {
    send({
      kind: "issue-provider-result",
      requestId,
      ok: false,
      message: messageOf(cause)
    })
  }
}

process.parentPort.on("message", ({ data }) => {
  switch (data.kind) {
    case "activate":
      void activate(data)
      break
    case "deactivate":
      void deactivate(data)
      break
    case "invoke":
      void invoke(data)
      break
    case "agent-toolset-load":
      loadAgentToolset(data)
      break
    case "agent-tool-invoke":
      void invokeAgentTool(data)
      break
    case "issue-provider-invoke":
      void invokeIssueProvider(data)
      break
    case "host-reply": {
      const waiting = pending.get(data.requestId)
      if (!waiting) return
      pending.delete(data.requestId)
      if (data.ok) waiting.resolve(data.value)
      else waiting.reject(new Error(data.message ?? "the host refused the request"))
      break
    }
  }
})

/**
 * An unhandled rejection in plugin code must not take the host down.
 *
 * Node's default is to exit, which would kill every OTHER plugin because one of
 * them forgot a `.catch`. Reported and survived instead — the plugin's own
 * behaviour is already broken, and there is nothing to gain by breaking its
 * neighbours too.
 */
process.on("unhandledRejection", (reason) => {
  send({
    kind: "log",
    pluginId: "<host>",
    level: "error",
    message: `unhandled rejection in a plugin: ${messageOf(reason)}`
  })
})

send({ kind: "ready" })
