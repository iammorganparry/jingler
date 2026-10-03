import { worktreeEnv } from "./worktree-env.js"
import { createServer } from "node:net"
import type { Session, WorkspacePortConfig, WorkspacePorts } from "@jingler/core"

/** Bind probes detect listeners; the persisted store assignment is the reservation. */
const canBind = (port: number, host: string): Promise<boolean> => new Promise((resolve, reject) => {
  const server = createServer()
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false)
    else if (host === "::1" && (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")) resolve(true)
    else reject(error)
  })
  server.listen({ port, host, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve(true)))
})
export const workspacePortAvailable = async (port: number): Promise<boolean> =>
  await canBind(port, "127.0.0.1") && await canBind(port, "::1")

export const validateWorkspacePortConfig = (config: WorkspacePortConfig): void => {
  const validPort = (value: number) => Number.isInteger(value) && value >= 1024 && value <= 65535
  if (!validPort(config.primary) || config.extras.some((extra) => !validPort(extra.start))) throw new Error("Starting ports must be integers from 1024 to 65535.")
  const names = new Set<string>()
  for (const extra of config.extras) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(extra.name) || extra.name === "PORT" || names.has(extra.name)) {
      throw new Error("Extra port names must be unique uppercase identifiers (for example API).")
    }
    names.add(extra.name)
  }
  if (config.previewUrl !== undefined) resolveWorkspacePreview(config.previewUrl, { primary: config.primary, extras: Object.fromEntries(config.extras.map((extra) => [extra.name, extra.start])) })
}

/** Caller MUST hold the SessionStore write lock until this allocation is persisted. Archived assignments remain reserved. */
export const allocateWorkspacePorts = async (sessions: readonly Session[], config?: WorkspacePortConfig, available: (port: number) => Promise<boolean> = workspacePortAvailable): Promise<WorkspacePorts> => {
  if (config) validateWorkspacePortConfig(config)
  const used = new Set(sessions.flatMap((session) => session.workspacePorts ? [session.workspacePorts.primary, ...Object.values(session.workspacePorts.extras)] : []))
  const allocate = async (start: number): Promise<number> => {
    for (let port = start; port <= 65535; port++) {
      if (!used.has(port) && await available(port)) { used.add(port); return port }
    }
    throw new Error("No workspace ports available; choose a lower starting port.")
  }
  const primary = await allocate(config?.primary ?? 3100)
  const extras: Record<string, number> = {}
  for (const extra of config?.extras ?? []) extras[extra.name] = await allocate(extra.start)
  return { primary, extras }
}

export const workspaceEnvironment = (session: Pick<Session, "workspacePorts" | "worktreePath" | "repoPath" | "environmentId" | "workspaceMode">): Record<string, string> => {
  if (session.environmentId || session.workspaceMode === "direct" || !session.worktreePath) return {}
  return {
    JINGLER_WORKSPACE_PATH: session.worktreePath,
    ...(session.repoPath ? { JINGLER_ROOT_PATH: session.repoPath } : {}),
    ...(session.workspacePorts ? {
      JINGLER_PORT: String(session.workspacePorts.primary),
      ...Object.fromEntries(Object.entries(session.workspacePorts.extras).filter(([name]) => /^[A-Z][A-Z0-9_]*$/.test(name)).map(([name, port]) => [`JINGLER_${name}_PORT`, String(port)]))
    } : {})
  }
}

export const resolveWorkspacePreview = (template: string, ports: WorkspacePorts): string => {
  const resolved = template.replace(/\{(port|[A-Z][A-Z0-9_]*_port)\}/g, (_, name: string) => {
    const value = name === "port" ? ports.primary : ports.extras[name.slice(0, -5)]
    if (value === undefined) throw new Error(`Unknown preview port: ${name}`)
    return String(value)
  })
  if (/[{}]/.test(resolved)) throw new Error("Unknown preview URL placeholder.")
  const url = new URL(resolved)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Preview must be an HTTP(S) URL without credentials.")
  return url.href
}

/** Only the host-owned workspace keys may bypass native CLI credential filtering. */
export const trustedWorkspaceEnvironment = (environment: Readonly<Record<string, string>> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    (name === "JINGLER_WORKSPACE_PATH" || name === "JINGLER_ROOT_PATH") ? !value.includes("\0") : /^JINGLER_(PORT|[A-Z][A-Z0-9_]*_PORT)$/.test(name) && /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535))

export const workspaceProcessEnvironment = (environment: Record<string, string | undefined>, session: Pick<Session, "workspacePorts" | "worktreePath" | "repoPath" | "environmentId" | "workspaceMode">): Record<string, string> => ({
  ...worktreeEnv(environment, session.worktreePath ?? undefined), ...workspaceEnvironment(session)
})
