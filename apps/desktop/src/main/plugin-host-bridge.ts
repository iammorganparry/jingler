/**
 * Where the extension host meets Electron and the rest of main.
 *
 * `PluginHostRuntime` in `cli-adapters` deliberately knows nothing about
 * Electron or the filesystem — it correlates messages and manages a process
 * lifecycle, which is what makes its crash paths testable without spawning
 * anything. This file supplies the two things it is missing: how to actually
 * start a `utilityProcess`, and what to do when a plugin asks for something.
 *
 * Keeping the split here is the reason the three crash bugs found in review
 * (a leaked activation timer, an unhandled restart rejection, and ready-waiters
 * stranded across a crash) were reachable from a unit test at all.
 */
import { join } from "node:path"
import { utilityProcess } from "electron"
import type { HostProcess } from "@jingler/cli-adapters"
import type { AuthSessionRequestPayload, ExecRequest } from "@jingler/cli-adapters"
import { runShell } from "./plugin-exec.js"

/**
 * Start the extension host as an Electron `utilityProcess`.
 *
 * `utilityProcess` rather than `child_process.fork` because it is Electron's own
 * supervised child: it dies with the app rather than being reparented to init,
 * and it gets a `parentPort` message channel without us wiring up stdio.
 */
export const spawnHostProcess = (): HostProcess => {
  // `.js`, not `.mjs`. electron-vite emits main-process entries as `.js` (only
  // the preload gets `.mjs`), so the original path pointed at a file that never
  // existed: the host never booted, never sent `ready`, and every plugin with a
  // `main` half failed to activate in every build. Nothing caught it because the
  // unit tests drive a fake `HostProcess` and the e2e plugin was UI-only — the
  // real spawn path had zero coverage until the case added alongside this fix.
  const entry = join(import.meta.dirname, "plugin-host-entry.js")
  const child = utilityProcess.fork(entry, [], {
    // Named so it is identifiable in Activity Monitor / `ps` — an operator
    // wondering what is using CPU deserves better than a second "Electron".
    serviceName: "jingler-plugin-host",
    stdio: "inherit"
  })

  return {
    post: (message) => child.postMessage(message),
    onMessage: (handler) => {
      child.on("message", (message) => handler(message))
    },
    onExit: (handler) => {
      child.on("exit", (code) => handler(code))
    },
    kill: () => {
      child.kill()
    }
  }
}

/** A plugin's request, refused with a reason it can act on. */
const refuse = (message: string) => ({ ok: false as const, message })

/**
 * Serve one `host-request` from a plugin.
 *
 * Every op is dispatched explicitly. An unrecognised one is refused rather than
 * ignored, because a plugin awaiting a promise nobody will ever settle hangs
 * with no diagnosis at all — a refusal at least names the problem.
 */
export const makeHostRequestHandler = (deps: {
  storageGet: (pluginId: string, key: string) => Promise<unknown>
  storageSet: (pluginId: string, key: string, value: unknown) => Promise<void>
  storageDelete: (pluginId: string, key: string) => Promise<void>
  storageKeys: (pluginId: string) => Promise<ReadonlyArray<string>>
  /** The worktree an `exec` with no `cwd` should run in. */
  defaultCwd: () => string | undefined
  /** Resolve a credential grant, prompting the operator if there is none yet. */
  getSession: (
    pluginId: string,
    request: AuthSessionRequestPayload
  ) => Promise<{ accessToken: string; account?: string; scopes: readonly string[] } | null>
}) => {
  return async (
    pluginId: string,
    op: string,
    payload: unknown
  ): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> => {
    switch (op) {
      case "storage.get": {
        const { key } = payload as { key: string }
        return { ok: true, value: await deps.storageGet(pluginId, key) }
      }
      case "storage.set": {
        const { key, value } = payload as { key: string; value: unknown }
        await deps.storageSet(pluginId, key, value)
        return { ok: true, value: undefined }
      }
      case "storage.delete": {
        const { key } = payload as { key: string }
        await deps.storageDelete(pluginId, key)
        return { ok: true, value: undefined }
      }
      case "storage.keys":
        return { ok: true, value: await deps.storageKeys(pluginId) }

      case "exec": {
        const request = payload as ExecRequest
        try {
          const result = await runShell(request, deps.defaultCwd())
          return { ok: true, value: result }
        } catch (cause) {
          return refuse(cause instanceof Error ? cause.message : String(cause))
        }
      }

      case "auth.getSession": {
        const request = payload as AuthSessionRequestPayload
        try {
          // `null` — declined, or no credentials — is a VALUE, not a failure.
          // The SDK's prompting overload turns it into a rejection host-side;
          // `createIfNone: false` hands it straight back as undefined.
          return { ok: true, value: await deps.getSession(pluginId, request) }
        } catch (cause) {
          return refuse(cause instanceof Error ? cause.message : String(cause))
        }
      }

      default:
        return refuse(`unknown host operation "${op}"`)
    }
  }
}
