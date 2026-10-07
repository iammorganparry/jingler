import { createRequire } from "node:module"
import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface AnchoredExpectation { sha256: string; permissions: number }
export interface AnchoredRequest {
  expected?: AnchoredExpectation | null
  op: "mkdir" | "read" | "stat" | "list" | "remove" | "unlink" | "rename" | "write" | "git"
  path: string
  to?: string
  bytes?: string
  mode?: number
  limit?: number
  exclusive?: boolean
  createParents?: boolean
  args?: string[]
  env?: Record<string, string>
}
export interface AnchoredProcess {
  post(message: unknown): void
  onMessage(handler: (message: { id: number; value?: unknown; error?: string; code?: string | number }) => void): void
  onExit(handler: () => void): void
  kill(): void
}
let launch: (() => AnchoredProcess) | undefined
/** Electron injects its official utilityProcess launcher; never rely on RunAsNode. */
export const configureAnchoredFsProcess = (factory: () => AnchoredProcess): void => { launch = factory }
const nodeProcess = (): AnchoredProcess => {
  if (process.versions.electron) throw new Error("Anchored filesystem utility process is not configured.")
  const child = fork(fileURLToPath(new URL("./anchored-fs-worker.ts", import.meta.url)), [], { execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")], cwd: "/", stdio: ["ignore", "ignore", "ignore", "ipc"] })
  return { post: (message) => child.send(message as object), onMessage: (handler) => child.on("message", handler), onExit: (handler) => child.on("exit", handler), kill: () => { child.kill() } }
}
let worker: AnchoredProcess | undefined
let sequence = 0
let idle: ReturnType<typeof setTimeout> | undefined
const pending = new Map<number, { resolve(value: unknown): void; reject(cause: Error): void }>()
const request = <T>(input: AnchoredRequest): Promise<T> => {
  if (idle) clearTimeout(idle)
  if (!worker) {
    const current = (launch ?? nodeProcess)()
    worker = current
    current.onMessage((reply) => {
      const waiter = pending.get(reply.id)
      if (!waiter) return
      pending.delete(reply.id)
      if (reply.error) waiter.reject(Object.assign(new Error(reply.error), { code: reply.code }))
      else waiter.resolve(reply.value)
      if (pending.size === 0) {
        idle = setTimeout(() => { if (worker === current) { worker = undefined; current.kill() } }, 100)
        idle.unref?.()
      }
    })
    current.onExit(() => {
      if (worker !== current) return
      worker = undefined
      for (const waiter of pending.values()) waiter.reject(new Error("Anchored filesystem worker exited; operation refused."))
      pending.clear()
    })
  }
  const id = ++sequence
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject })
    worker!.post({ ...input, id })
  })
}
export interface AnchoredStat { mode: number; size: number; file: boolean; directory: boolean; symlink: boolean; nlink: number }
export const anchoredFs = {
  mkdir: (path: string) => request<void>({ op: "mkdir", path }),
  stat: (path: string) => request<AnchoredStat | null>({ op: "stat", path }),
  read: async (path: string, limit?: number): Promise<{ bytes: Buffer; mode: number; nlink: number }> => {
    const value = await request<{ bytes: string; mode: number; nlink: number }>({ op: "read", path, limit })
    return { ...value, bytes: Buffer.from(value.bytes, "base64") }
  },
  write: (path: string, bytes: Buffer | string, mode = 0o600, exclusive = false, expected?: AnchoredExpectation | null) => request<void>({ op: "write", expected, path, bytes: Buffer.from(bytes).toString("base64"), mode, exclusive, createParents: true }),
  list: (path: string) => request<string[]>({ op: "list", path }),
  unlink: (path: string, expected?: AnchoredExpectation | null) => request<void>({ op: "unlink", path, expected }),
  remove: (path: string) => request<void>({ op: "remove", path }),
  rename: (path: string, to: string) => request<void>({ op: "rename", path, to }),
  git: async (path: string, args: string[], env?: Record<string, string>, bytes?: Buffer) => Buffer.from(await request<string>({ op: "git", path, args, env, bytes: bytes?.toString("base64") }), "base64")
}
