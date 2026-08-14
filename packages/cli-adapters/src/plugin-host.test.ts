import { describe, expect, it, vi } from "vitest"
import type { LoadedPlugin } from "@jingler/core"
import {
  PluginHostRuntime,
  type HostProcess,
  type HostRequestHandler
} from "./plugin-host.js"
import type { FromHostMessage, ToHostMessage } from "./plugin-host-protocol.js"

/**
 * The host runtime, driven without spawning anything.
 *
 * `HostProcess` is an interface rather than `utilityProcess` for exactly this:
 * the interesting behaviour is what happens when a plugin hangs, crashes, or
 * crashes twice, and none of that is reachable in a test that has to start a
 * real Node process and wait for it to die.
 */

/** A fake host process that records what it was sent and can be crashed. */
const fakeProcess = () => {
  let onMessage: ((m: FromHostMessage) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  const sent: ToHostMessage[] = []
  let killed = false

  const proc: HostProcess = {
    post: (message) => {
      sent.push(message)
    },
    onMessage: (handler) => {
      onMessage = handler
    },
    onExit: (handler) => {
      onExit = handler
    },
    kill: () => {
      killed = true
      // A real `utilityProcess` fires `exit` when it is killed — the SAME event
      // a crash fires. The fake used to swallow it, which is why the suite could
      // not see that `shutdown()` was respawning the host on quit: nothing in
      // the tests ever reached `handleExit` by the kill path.
      onExit?.(0)
    }
  }

  return {
    proc,
    sent,
    get killed() {
      return killed
    },
    emit: (message: FromHostMessage) => onMessage?.(message),
    crash: () => onExit?.(1),
    /** The host reports ready as soon as it boots; nothing proceeds before it. */
    ready: () => onMessage?.({ kind: "ready" })
  }
}

const plugin = (over: Partial<LoadedPlugin["manifest"]> = {}): LoadedPlugin =>
  ({
    manifest: {
      id: "linear",
      name: "Linear",
      version: "1.0.0",
      main: "dist/main.js",
      contributes: { commands: [{ id: "linear.sync", title: "Sync" }] },
      ...over
    },
    dir: "/home/dev/jingler/plugins/linear",
    enabled: true,
    activated: false,
    builtin: false
  }) as LoadedPlugin

const noRequests = async () => ({ ok: true as const, value: null })

/** Spawn a runtime over a sequence of fake processes (one per restart). */
const setup = (count = 4, handleRequest: HostRequestHandler = noRequests) => {
  const procs = Array.from({ length: count }, () => fakeProcess())
  let index = 0
  const events = {
    onActivated: vi.fn(),
    onActivationFailed: vi.fn(),
    onLog: vi.fn(),
    onPluginEvent: vi.fn()
  }
  const runtime = new PluginHostRuntime(
    () => procs[index++]!.proc,
    handleRequest,
    events
  )
  return {
    runtime,
    procs,
    events,
    current: () => procs[index - 1]!,
    /**
     * How many fakes the runtime has actually taken.
     *
     * `procs` is pre-filled to `count` whether or not they get used, so its
     * length says nothing about spawning — asserting on it looks like a spawn
     * count and is a constant.
     */
    spawned: () => index
  }
}

/** Let queued microtasks run — the runtime awaits `ready` before sending. */
const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * Drive a complete activation handshake.
 *
 * Every test needs this and none of them are about it. Leaving an activation
 * pending instead makes the suite wait out the real ACTIVATE_TIMEOUT_MS and
 * then reject into nobody — 15 seconds of nothing, followed by noise.
 */
const activateFully = async (
  runtime: PluginHostRuntime,
  proc: ReturnType<typeof fakeProcess>,
  p = plugin()
) => {
  const done = runtime.activate(p)
  await tick()
  proc.ready()
  await tick()
  const message = proc.sent.find((m) => m.kind === "activate")
  if (message?.kind !== "activate") throw new Error("no activate was sent")
  proc.emit({ kind: "activated", requestId: message.requestId, pluginId: p.manifest.id })
  await done
  return message
}

describe("activation", () => {
  it("does nothing for a plugin with no host half", async () => {
    const { runtime, procs } = setup()
    await runtime.activate(plugin({ main: undefined }))
    // No process spawned at all: a UI-only plugin must never cost a Node start.
    expect(procs[0]!.sent).toHaveLength(0)
    expect(runtime.isActivated("linear")).toBe(false)
  })

  it("sends activate with the manifest's declared commands", async () => {
    const { runtime, procs } = setup()
    const p = runtime.activate(plugin())
    await tick()
    procs[0]!.ready()
    await tick()

    const message = procs[0]!.sent.find((m) => m.kind === "activate")
    expect(message).toBeTruthy()
    if (message?.kind !== "activate") throw new Error("expected activate")
    expect(message.pluginId).toBe("linear")
    expect(message.entry).toBe("/home/dev/jingler/plugins/linear/dist/main.js")
    // The host refuses registrations outside this list, which is what keeps the
    // manifest — the thing shown in Settings — the actual contract.
    expect(message.declaredCommands).toEqual(["linear.sync"])
    expect(message.declaredIssueProviders).toEqual([])
    expect(message.declaredAgentToolsets).toEqual([])

    procs[0]!.emit({ kind: "activated", requestId: message.requestId, pluginId: "linear" })
    await p
    expect(runtime.isActivated("linear")).toBe(true)
  })

  it("is idempotent — several activation events for one plugin is the normal case", async () => {
    const { runtime, procs } = setup()
    await activateFully(runtime, procs[0]!)

    await runtime.activate(plugin())
    expect(procs[0]!.sent.filter((m) => m.kind === "activate")).toHaveLength(1)
  })

  it("reports a failing activate and leaves the plugin retryable", async () => {
    const { runtime, procs, events } = setup()
    const p = runtime.activate(plugin())
    await tick()
    procs[0]!.ready()
    await tick()
    const message = procs[0]!.sent.find((m) => m.kind === "activate")!

    procs[0]!.emit({
      kind: "activation-failed",
      requestId: message.requestId,
      pluginId: "linear",
      message: "connect ECONNREFUSED"
    })

    await expect(p).rejects.toThrow(/ECONNREFUSED/)
    expect(events.onActivationFailed).toHaveBeenCalledWith("linear", "connect ECONNREFUSED")
    // Not activated, so the next activation event tries again — a plugin that
    // failed because a file was mid-save must not stay dead until restart.
    expect(runtime.isActivated("linear")).toBe(false)
  })
})

describe("invoke", () => {
  it("activates the plugin first, then dispatches", async () => {
    const { runtime, procs } = setup()
    const result = runtime.invoke(plugin(), "linear.sync", { repo: "x" })
    await tick()
    procs[0]!.ready()
    await tick()

    const activate = procs[0]!.sent.find((m) => m.kind === "activate")!
    procs[0]!.emit({ kind: "activated", requestId: activate.requestId, pluginId: "linear" })
    await tick()

    const invoke = procs[0]!.sent.find((m) => m.kind === "invoke")
    expect(invoke).toBeTruthy()
    if (invoke?.kind !== "invoke") throw new Error("expected invoke")
    expect(invoke.commandId).toBe("linear.sync")
    expect(invoke.arg).toEqual({ repo: "x" })

    procs[0]!.emit({
      kind: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      value: [1, 2, 3]
    })
    expect(await result).toEqual([1, 2, 3])
  })

  it("surfaces a command's own failure with its message", async () => {
    const { runtime, procs } = setup()
    const result = runtime.invoke(plugin(), "linear.sync")
    await tick()
    procs[0]!.ready()
    await tick()
    const activate = procs[0]!.sent.find((m) => m.kind === "activate")!
    procs[0]!.emit({ kind: "activated", requestId: activate.requestId, pluginId: "linear" })
    await tick()
    const invoke = procs[0]!.sent.find((m) => m.kind === "invoke")!

    procs[0]!.emit({
      kind: "invoke-result",
      requestId: invoke.requestId,
      ok: false,
      message: "rate limited"
    })
    await expect(result).rejects.toThrow(/rate limited/)
  })
})

describe("agent toolsets", () => {
  const toolPlugin = () =>
    plugin({
      contributes: {
        agentToolsets: [
          { id: "linear.issues", label: "Linear issues", description: "Work with Linear issues." }
        ]
      }
    })

  it("materializes full schemas only after a toolset is selected", async () => {
    const { runtime, procs } = setup()
    const result = runtime.loadAgentToolset(toolPlugin(), "linear.issues")
    await tick()
    procs[0]!.ready()
    await tick()
    const activate = procs[0]!.sent.find((message) => message.kind === "activate")
    if (activate?.kind !== "activate") throw new Error("expected activate")
    expect(activate.declaredAgentToolsets).toEqual(["linear.issues"])
    procs[0]!.emit({ kind: "activated", requestId: activate.requestId, pluginId: "linear" })
    await tick()

    const load = procs[0]!.sent.find((message) => message.kind === "agent-toolset-load")
    if (load?.kind !== "agent-toolset-load") throw new Error("expected toolset load")
    expect(load.toolsetId).toBe("linear.issues")
    const tools = [{
      id: "linear_get_issue",
      description: "Get one issue.",
      inputSchema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] },
      risk: "network" as const,
      timeoutMs: 30_000,
      outputBudget: 8_000,
      cancellable: true,
      idempotency: "safe" as const
    }]
    procs[0]!.emit({ kind: "agent-toolset-result", requestId: load.requestId, ok: true, tools })
    await expect(result).resolves.toEqual(tools)
  })

  it("routes a selected native tool invocation", async () => {
    const { runtime, procs } = setup()
    await activateFully(runtime, procs[0]!, toolPlugin())
    const result = runtime.invokeAgentTool(toolPlugin(), "linear.issues", "linear_get_issue", { id: "ENG-1" })
    await tick()
    const invoke = procs[0]!.sent.find((message) => message.kind === "agent-tool-invoke")
    if (invoke?.kind !== "agent-tool-invoke") throw new Error("expected agent tool invoke")
    expect(invoke).toMatchObject({ toolsetId: "linear.issues", toolId: "linear_get_issue", input: { id: "ENG-1" } })
    procs[0]!.emit({ kind: "agent-tool-result", requestId: invoke.requestId, ok: true, value: { title: "Fix it" } })
    await expect(result).resolves.toEqual({ title: "Fix it" })
  })
})

describe("issue providers", () => {
  it("activates the declaring plugin and routes a provider operation", async () => {
    const { runtime, procs } = setup()
    const p = plugin({
      contributes: {
        issueProviders: [{ id: "linear", label: "Linear" }]
      }
    })
    const result = runtime.invokeIssueProvider(p, "linear", "listIssues", {
      repository: { name: "jingler", path: "/repos/jingler" },
      search: "retry",
      mine: true
    })
    await tick()
    procs[0]!.ready()
    await tick()

    const activate = procs[0]!.sent.find((message) => message.kind === "activate")
    if (activate?.kind !== "activate") throw new Error("expected activate")
    expect(activate.declaredIssueProviders).toEqual(["linear"])
    procs[0]!.emit({
      kind: "activated",
      requestId: activate.requestId,
      pluginId: "linear"
    })
    await tick()

    const invoke = procs[0]!.sent.find(
      (message) => message.kind === "issue-provider-invoke"
    )
    if (invoke?.kind !== "issue-provider-invoke") {
      throw new Error("expected issue provider invoke")
    }
    expect(invoke).toMatchObject({
      pluginId: "linear",
      providerId: "linear",
      method: "listIssues",
      input: {
        repository: { name: "jingler", path: "/repos/jingler" },
        search: "retry",
        mine: true
      }
    })
    procs[0]!.emit({
      kind: "issue-provider-result",
      requestId: invoke.requestId,
      ok: true,
      value: [{ identifier: "ENG-123" }]
    })
    await expect(result).resolves.toEqual([{ identifier: "ENG-123" }])
  })

  it("settles an issue-provider request when the host exits", async () => {
    const { runtime, procs } = setup()
    const p = plugin({
      contributes: { issueProviders: [{ id: "linear", label: "Linear" }] }
    })
    const result = runtime.invokeIssueProvider(p, "linear", "getIssue", {
      repository: { name: "jingler", path: "/repos/jingler" },
      issueId: "issue-1"
    })
    await tick()
    procs[0]!.ready()
    await tick()
    const activate = procs[0]!.sent.find((message) => message.kind === "activate")
    if (activate?.kind !== "activate") throw new Error("expected activate")
    procs[0]!.emit({
      kind: "activated",
      requestId: activate.requestId,
      pluginId: "linear"
    })
    await tick()

    procs[0]!.crash()
    await expect(result).rejects.toThrow(/exited while this call was in flight/)
  })
})

describe("host requests", () => {
  it("serves a plugin's request and replies on the same id", async () => {
    const handle = vi.fn(async () => ({ ok: true as const, value: "stored" }))
    const { runtime, procs } = setup(4, handle)
    await activateFully(runtime, procs[0]!)

    procs[0]!.emit({
      kind: "host-request",
      requestId: "h1",
      pluginId: "linear",
      op: "storage.get",
      payload: { key: "k" }
    })
    await tick()

    expect(handle).toHaveBeenCalledWith("linear", "storage.get", { key: "k" })
    const reply = procs[0]!.sent.find((m) => m.kind === "host-reply")
    expect(reply).toMatchObject({ requestId: "h1", ok: true, value: "stored" })
  })

  it("turns a thrown handler into a refusal rather than losing the reply", async () => {
    // A plugin awaiting a promise nobody will ever settle is worse than an
    // error: it hangs with no diagnosis.
    const handle = vi.fn(async () => {
      throw new Error("no such provider")
    })
    const { runtime, procs } = setup(4, handle)
    await activateFully(runtime, procs[0]!)

    procs[0]!.emit({
      kind: "host-request",
      requestId: "h9",
      pluginId: "linear",
      op: "auth.getSession",
      payload: {}
    })
    await tick()

    const reply = procs[0]!.sent.find((m) => m.kind === "host-reply")
    expect(reply).toMatchObject({ requestId: "h9", ok: false })
    if (reply?.kind !== "host-reply") throw new Error("expected reply")
    expect(reply.message).toContain("no such provider")
  })
})

describe("crash handling", () => {
  it("rejects in-flight calls rather than hanging them", async () => {
    const { runtime, procs } = setup()
    const result = runtime.invoke(plugin(), "linear.sync")
    await tick()
    procs[0]!.ready()
    await tick()
    const activate = procs[0]!.sent.find((m) => m.kind === "activate")!
    procs[0]!.emit({ kind: "activated", requestId: activate.requestId, pluginId: "linear" })
    await tick()

    procs[0]!.crash()
    await expect(result).rejects.toThrow(/exited while this call was in flight/)
  })

  it("restarts once and re-activates what was live", async () => {
    const { runtime, procs } = setup()
    await activateFully(runtime, procs[0]!)

    procs[0]!.crash()
    await tick()
    procs[1]!.ready()
    await tick()

    // The plugin the operator was using comes back without them doing anything.
    expect(procs[1]!.sent.some((m) => m.kind === "activate")).toBe(true)
  })

  it("stays down after a second crash instead of looping", async () => {
    const { runtime, procs } = setup()
    await activateFully(runtime, procs[0]!)

    procs[0]!.crash()
    await tick()
    procs[1]!.crash()
    await tick()

    // Respawning forever would burn CPU while presenting as an app that is
    // merely slow. It says so instead.
    await expect(runtime.activate(plugin())).rejects.toThrow(/crashed repeatedly/)
  })

  it("lets an explicit reload clear the crash budget", async () => {
    // A reload is the operator saying "try again". Holding an earlier crash
    // against it would make a fixed plugin unfixable without an app restart.
    const { runtime, procs } = setup(6)
    await activateFully(runtime, procs[0]!)

    procs[0]!.crash()
    await tick()
    procs[1]!.crash()
    await tick()

    const reload = runtime.reload(plugin())
    await tick()
    procs[2]!.ready()
    await tick()
    const again = procs[2]!.sent.find((m) => m.kind === "activate")
    expect(again).toBeTruthy()
    procs[2]!.emit({ kind: "activated", requestId: again!.requestId, pluginId: "linear" })
    await reload
    expect(runtime.isActivated("linear")).toBe(true)
  })
})

describe("shutdown", () => {
  it("kills the process, so quitting leaves no orphan Node", async () => {
    const { runtime, procs } = setup()
    await activateFully(runtime, procs[0]!)

    runtime.shutdown()
    expect(procs[0]!.killed).toBe(true)
    expect(runtime.isActivated("linear")).toBe(false)
  })

  it("does not respawn the host it just killed", async () => {
    // Killing a child fires the same `exit` event a crash does, and
    // `handleExit` could not tell them apart: with the crash budget unspent it
    // restarted, forking a fresh utilityProcess in the middle of `before-quit`.
    // The healthy-uptime reset made that the normal case, since any host up for
    // a minute has `restarts === 0`.
    const { runtime, procs, spawned } = setup()
    await activateFully(runtime, procs[0]!)
    expect(spawned()).toBe(1)

    runtime.shutdown()
    await tick()

    expect(spawned(), "a second process was spawned during shutdown").toBe(1)
  })

  it("rejects in-flight calls rather than parking them forever", async () => {
    // `handleExit` normally does this and now returns early on an intentional
    // kill, so `shutdown` has to. A quit that leaves promises unsettled is a
    // quit that can hang on them.
    const { runtime, procs } = setup()
    await activateFully(runtime, procs[0]!)

    const inFlight = runtime.invoke(plugin(), "linear.sync")
    await tick()

    runtime.shutdown()

    await expect(inFlight).rejects.toThrow(/shut down/)
  })
})
