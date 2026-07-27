/**
 * Main's half of the extension host: spawn it, keep it alive, route to it.
 *
 * ## Lazy activation, and why it is not an optimisation
 *
 * A plugin stays a manifest entry until one of its `activationEvents` fires.
 * With ten plugins installed, eagerly importing each one's `main` would put
 * whatever they each do at startup — a network call, a CLI probe, a file scan —
 * on the critical path to the operator's first frame, for work they may never
 * ask for. So `Plugins.invoke` and the renderer's `onTab` both go through
 * {@link PluginHost.ensureActivated}, and a plugin nobody touches costs nothing
 * but a directory read.
 *
 * ## Crash policy: restart once, then stay down
 *
 * A crashed host is restarted and its previously-active plugins re-activated,
 * because the common cause is one plugin doing something fatal on a path the
 * operator can avoid. But a host that crashes again immediately is in a loop,
 * and respawning forever would burn CPU while presenting as an app that is
 * merely slow. After the second failure it stays down and says so.
 *
 * ## Why this is deliberately transport, not policy
 *
 * The decision of WHICH plugins may activate, and what a plugin is allowed to
 * ask for, is not made here — the registry owns the catalog and the consent
 * layer owns credentials. This service knows how to run a process and correlate
 * messages, and keeping it to that is what makes both of those testable without
 * spawning anything.
 */
import { Effect, Deferred, Ref } from "effect"
import { PluginError } from "@jingler/core"
import type { LoadedPlugin } from "@jingler/core"
import {
  ACTIVATE_TIMEOUT_MS,
  HOST_READY_TIMEOUT_MS,
  type FromHostMessage,
  type ToHostMessage
} from "./plugin-host-protocol.js"

/**
 * What the host service needs from the process it drives.
 *
 * An interface rather than `utilityProcess` directly, because Electron is not
 * importable from `cli-adapters` (it is a main-process global) and because a
 * test must be able to drive the whole lifecycle — activate, invoke, crash,
 * restart — without spawning Node.
 */
export interface HostProcess {
  /** Send one message to the host. */
  readonly post: (message: ToHostMessage) => void
  /** Register the sole message handler. */
  readonly onMessage: (handler: (message: FromHostMessage) => void) => void
  /** Register the exit handler. Fires for both crashes and clean shutdowns. */
  readonly onExit: (handler: (code: number) => void) => void
  /** Terminate the process. */
  readonly kill: () => void
}

/** How main is told to make a new host process. Injected so tests can fake it. */
export type HostProcessFactory = () => HostProcess

/** What main does when a plugin asks for something it cannot do itself. */
export interface HostRequestHandler {
  (
    pluginId: string,
    op: string,
    payload: unknown
  ): Promise<{ ok: true; value: unknown } | { ok: false; message: string }>
}

export interface PluginHostEvents {
  readonly onPluginEvent?: (pluginId: string, topic: string, payload: unknown) => void
  readonly onActivated?: (pluginId: string) => void
  readonly onActivationFailed?: (pluginId: string, message: string) => void
  readonly onLog?: (pluginId: string, level: string, message: string) => void
}

interface Waiter {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: PluginError) => void
}

/** How many times a crashed host is respawned before it is left down. */
const MAX_RESTARTS = 1

/**
 * How long a host must stay up before its crash budget is forgiven.
 *
 * Long enough that a crash-loop cannot launder itself clean between attempts,
 * short enough that an operator who hit a bad path an hour ago is not still
 * paying for it.
 */
const HEALTHY_UPTIME_MS = 60_000

export class PluginHostRuntime {
  private process: HostProcess | null = null
  private ready = false
  private restarts = 0
  private downReason: string | null = null
  /**
   * Set once `shutdown` has been called, and never cleared.
   *
   * `shutdown` kills the child, and killing a child fires the SAME `onExit`
   * handler a crash does — `handleExit` had no way to tell the two apart. With
   * the crash budget unspent it did what it does for a crash: incremented
   * `restarts` and called `start()`, forking a fresh `utilityProcess` in the
   * middle of `before-quit`. A new Node process racing app teardown, and if the
   * fork throws that late it throws inside an exit handler.
   *
   * The healthy-uptime reset made this the NORMAL case rather than a rare one:
   * any host that had been up a minute has `restarts === 0`, so every ordinary
   * quit with a live plugin host hit it.
   *
   * Never cleared because a runtime that has been shut down is finished; the
   * layer builds a new one on the next boot.
   */
  private shuttingDown = false
  private nextId = 0
  /** Pending "this host has been up long enough" timer. See HEALTHY_UPTIME_MS. */
  private healthyTimer: ReturnType<typeof setTimeout> | undefined
  private readonly waiters = new Map<string, Waiter>()
  /** Plugins currently activated, so a restart can restore them. */
  private readonly activated = new Map<string, LoadedPlugin>()
  /**
   * Activations in flight, keyed by plugin id.
   *
   * The `activated` check alone was a time-of-check/time-of-use hole: it happens
   * before `await whenReady()` and the set happens after, so two concurrent
   * callers — which this class's own comments call the normal case, a tab and a
   * command firing together — both passed the check and both sent an `activate`.
   * The host entry had the same shape, so `module.activate(ctx)` ran twice:
   * duplicated subscriptions, doubled side effects, last-write-wins handlers.
   *
   * Storing the promise on first entry and returning it to everyone else makes
   * concurrent activation one activation, which is what "idempotent" was always
   * supposed to mean.
   */
  private readonly activating = new Map<string, Promise<void>>()
  /**
   * Callers parked in {@link whenReady}.
   *
   * Rejected — not merely dropped — when the process exits. A waiter left over
   * from a dead host would otherwise resume against the NEXT one and send it an
   * activation it never asked for, so a single crash could leave a plugin
   * activated twice.
   */
  private readyWaiters: Array<{
    resolve: () => void
    reject: (error: PluginError) => void
  }> = []

  constructor(
    private readonly spawn: HostProcessFactory,
    private readonly handleRequest: HostRequestHandler,
    private readonly events: PluginHostEvents = {}
  ) {}

  private id(): string {
    return `m${++this.nextId}`
  }

  private start(): void {
    const child = this.spawn()
    this.process = child
    this.ready = false

    child.onMessage((message) => this.receive(message))
    child.onExit(() => this.handleExit())
  }

  private handleExit(): void {
    this.process = null
    this.ready = false
    // The uptime it was accruing did not happen.
    clearTimeout(this.healthyTimer)
    this.healthyTimer = undefined

    // An intentional kill is not a crash. Everything below this line — rejecting
    // waiters, restarting, re-activating — is the response to a host that died
    // on its own, and running it during `shutdown` respawns the process we just
    // killed. `shutdown` has already cleared the state this would rebuild.
    if (this.shuttingDown) return

    // Every in-flight call dies with the process. Rejecting them explicitly is
    // the difference between a plugin command that reports a crash and one that
    // hangs forever on a promise nothing will ever settle.
    for (const [, waiter] of this.waiters) {
      waiter.reject(
        new PluginError({
          pluginId: "<host>",
          reason: "the plugin host exited while this call was in flight"
        })
      )
    }
    this.waiters.clear()

    // Same treatment for anyone still waiting for the host to boot. Leaving
    // these parked is what let a pre-crash activation wake up against a
    // restarted process and activate a plugin a second time.
    const stranded = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of stranded) {
      waiter.reject(
        new PluginError({
          pluginId: "<host>",
          reason: "the plugin host exited before it finished starting"
        })
      )
    }

    const toRestore = [...this.activated.values()]
    this.activated.clear()

    if (this.restarts >= MAX_RESTARTS) {
      // A host that dies again immediately is looping. Respawning forever would
      // burn CPU while presenting as an app that is merely slow.
      this.downReason =
        "the plugin host crashed repeatedly and has been stopped. Disable recently changed plugins, then reload."
      return
    }

    this.restarts += 1
    this.start()
    for (const plugin of toRestore) {
      // Caught, not floated: nobody is awaiting a restart-time re-activation, so
      // a plugin that fails to come back would otherwise surface as an unhandled
      // rejection — noisy, and in some Node configurations fatal to the process
      // doing the restarting.
      void this.activate(plugin).catch((cause: unknown) => {
        this.events.onActivationFailed?.(
          plugin.manifest.id,
          cause instanceof PluginError
            ? cause.reason
            : `did not survive a host restart: ${String(cause)}`
        )
      })
    }
  }

  private receive(message: FromHostMessage): void {
    switch (message.kind) {
      case "ready": {
        this.ready = true
        // A host that booted successfully has spent its debt. Without this
        // `restarts` only ever went up — two crashes an hour apart killed the
        // host permanently, when the policy comment describes a LOOP (crashing
        // again immediately) as the thing worth giving up on.
        clearTimeout(this.healthyTimer)
        this.healthyTimer = setTimeout(() => {
          this.restarts = 0
        }, HEALTHY_UPTIME_MS)
        const waiting = this.readyWaiters
        this.readyWaiters = []
        for (const waiter of waiting) waiter.resolve()
        break
      }
      case "activated":
      case "deactivated":
        this.settle(message.requestId, true, undefined)
        if (message.kind === "activated") this.events.onActivated?.(message.pluginId)
        break
      case "activation-failed":
        this.activated.delete(message.pluginId)
        this.settle(message.requestId, false, undefined, message.message)
        this.events.onActivationFailed?.(message.pluginId, message.message)
        break
      case "invoke-result":
        this.settle(message.requestId, message.ok, message.value, message.message)
        break
      case "event":
        this.events.onPluginEvent?.(message.pluginId, message.topic, message.payload)
        break
      case "log":
        this.events.onLog?.(message.pluginId, message.level, message.message)
        break
      case "host-request":
        void this.serveRequest(message)
        break
    }
  }

  private async serveRequest(
    message: Extract<FromHostMessage, { kind: "host-request" }>
  ): Promise<void> {
    let reply: ToHostMessage
    try {
      const result = await this.handleRequest(message.pluginId, message.op, message.payload)
      reply = result.ok
        ? { kind: "host-reply", requestId: message.requestId, ok: true, value: result.value }
        : {
            kind: "host-reply",
            requestId: message.requestId,
            ok: false,
            message: result.message
          }
    } catch (cause) {
      reply = {
        kind: "host-reply",
        requestId: message.requestId,
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause)
      }
    }
    // The host may have died while we were working; a post to a dead process
    // throws, and there is nobody left to receive the answer anyway.
    this.process?.post(reply)
  }

  private settle(
    requestId: string,
    ok: boolean,
    value: unknown,
    message?: string
  ): void {
    const waiter = this.waiters.get(requestId)
    if (!waiter) return
    this.waiters.delete(requestId)
    if (ok) waiter.resolve(value)
    else
      waiter.reject(
        new PluginError({ pluginId: "<host>", reason: message ?? "the plugin failed" })
      )
  }

  /**
   * Wait for the host to report `ready`, but not forever.
   *
   * `HOST_READY_TIMEOUT_MS` was defined with a docstring explaining exactly this
   * and then consumed by nothing. A host that spawns and hangs before sending
   * `ready` — or a spawn that fails without producing an exit event — parked
   * every activation in `readyWaiters` permanently: the tab that triggered it
   * spun with no diagnosis, and `ACTIVATE_TIMEOUT_MS` never fired because that
   * race only starts once this resolves.
   */
  private whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error: PluginError) => {
          clearTimeout(timer)
          reject(error)
        }
      }
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter)
        // Marked down rather than merely failed: a host that never booted will
        // not boot on the next attempt either, and retrying forever is how this
        // presents as an app that is just slow.
        this.downReason = `the plugin host did not start within ${HOST_READY_TIMEOUT_MS}ms`
        reject(new PluginError({ pluginId: "<host>", reason: this.downReason }))
      }, HOST_READY_TIMEOUT_MS)
      this.readyWaiters.push(waiter)
    })
  }

  private send<T>(message: ToHostMessage & { requestId: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(message.requestId, {
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.process?.post(message)
    })
  }

  /** Ensure a host process exists, or report why it will not. */
  private ensureProcess(): PluginError | null {
    if (this.downReason) {
      return new PluginError({ pluginId: "<host>", reason: this.downReason })
    }
    if (!this.process) this.start()
    return null
  }

  /**
   * Activate a plugin's host half if it is not already running.
   *
   * Idempotent, because several activation events can fire for one plugin (its
   * tab AND one of its commands) and racing them is the normal case.
   */
  async activate(plugin: LoadedPlugin): Promise<void> {
    const { manifest } = plugin
    if (!manifest.main) return
    if (this.activated.has(manifest.id)) return

    // Join an activation already under way rather than starting a second.
    const inFlight = this.activating.get(manifest.id)
    if (inFlight) return await inFlight

    const run = this.runActivation(plugin)
    this.activating.set(manifest.id, run)
    try {
      await run
    } finally {
      this.activating.delete(manifest.id)
    }
  }

  private async runActivation(plugin: LoadedPlugin): Promise<void> {
    const { manifest } = plugin
    const down = this.ensureProcess()
    if (down) throw down

    await this.whenReady()
    this.activated.set(manifest.id, plugin)

    const requestId = this.id()
    const activation = this.send<void>({
      kind: "activate",
      requestId,
      pluginId: manifest.id,
      entry: `${plugin.dir}/${manifest.main}`,
      declaredCommands: (manifest.contributes?.commands ?? []).map((c) => c.id)
    })

    // A plugin awaiting a network call it will never get must not hold the
    // activation open forever — the tab that triggered it is on screen, waiting.
    //
    // The timer is CLEARED in `finally`, and that is not tidiness. Left running,
    // it fires ~15s after every successful activation and rejects a promise
    // nobody is holding — an unhandled rejection per activation, plus a live
    // timer per plugin for as long as the app is open.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PluginError({
              pluginId: manifest.id,
              reason: `activate() did not finish within ${ACTIVATE_TIMEOUT_MS}ms`
            })
          ),
        ACTIVATE_TIMEOUT_MS
      )
    })

    try {
      await Promise.race([activation, timeout])
    } catch (cause) {
      this.activated.delete(manifest.id)
      throw cause
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Dispatch a command, activating the plugin first if needed. */
  async invoke(plugin: LoadedPlugin, commandId: string, arg?: unknown): Promise<unknown> {
    await this.activate(plugin)
    return await this.send<unknown>({
      kind: "invoke",
      requestId: this.id(),
      pluginId: plugin.manifest.id,
      commandId,
      arg
    })
  }

  /** Tear a plugin down without touching the others. */
  async deactivate(pluginId: string): Promise<void> {
    if (!this.activated.has(pluginId) || !this.process) return
    this.activated.delete(pluginId)
    await this.send<void>({ kind: "deactivate", requestId: this.id(), pluginId })
  }

  /** Deactivate then activate — the development loop for a plugin author. */
  async reload(plugin: LoadedPlugin): Promise<void> {
    await this.deactivate(plugin.manifest.id)
    // The crash budget resets: a reload is an explicit "try again", and holding
    // an earlier crash against it would make the plugin unfixable without a
    // full app restart.
    this.restarts = 0
    this.downReason = null
    await this.activate(plugin)
  }

  isActivated(pluginId: string): boolean {
    return this.activated.has(pluginId)
  }

  /** Terminate the host. Called on quit; leaves no orphan Node process. */
  shutdown(): void {
    // BEFORE the kill, because `kill()` may deliver `exit` synchronously and
    // `handleExit` reads this flag to know the death was intentional.
    this.shuttingDown = true
    clearTimeout(this.healthyTimer)
    this.healthyTimer = undefined
    this.process?.kill()
    this.process = null
    this.ready = false
    this.activated.clear()

    // Anything still in flight dies with the process. `handleExit` normally does
    // this and now returns early, so it is done here instead — a quit that
    // leaves promises parked forever is a quit that can hang on them.
    for (const [, waiter] of this.waiters) {
      waiter.reject(
        new PluginError({ pluginId: "<host>", reason: "the plugin host was shut down" })
      )
    }
    this.waiters.clear()

    const stranded = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of stranded) {
      waiter.reject(
        new PluginError({ pluginId: "<host>", reason: "the plugin host was shut down" })
      )
    }
  }
}

/**
 * The Effect service wrapper.
 *
 * Thin on purpose: the runtime above is a plain class because its whole job is
 * mutable process state and message correlation, which Effect models no more
 * clearly than a `Map` does. The service exists so main can reach it through the
 * same layer mechanism as everything else, and so `before-quit` can shut it down.
 */
export class PluginHost extends Effect.Service<PluginHost>()("@jingler/PluginHost", {
  accessors: true,
  effect: Effect.gen(function* () {
    const runtimeRef = yield* Ref.make<PluginHostRuntime | null>(null)
    const installed = yield* Deferred.make<void>()

    return {
      /** Install the runtime. Called once from main, which owns Electron. */
      install: (runtime: PluginHostRuntime) =>
        Effect.gen(function* () {
          yield* Ref.set(runtimeRef, runtime)
          yield* Deferred.succeed(installed, undefined)
        }),

      /** The runtime, or a typed failure when the host is not available here. */
      get: () =>
        Effect.flatMap(Ref.get(runtimeRef), (runtime) =>
          runtime
            ? Effect.succeed(runtime)
            : Effect.fail(
                new PluginError({
                  pluginId: "<host>",
                  reason: "the plugin host is not running in this build"
                })
              )
        ),

      shutdown: () =>
        Effect.flatMap(Ref.get(runtimeRef), (runtime) =>
          Effect.sync(() => runtime?.shutdown())
        )
    }
  })
}) {}
