/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-conditional-empty-object-spread -- Adapter JSON/YAML is an external config boundary normalized immediately below. */
import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import defaults from "./defaults.json" with { type: "json" }
import type { DapAdapterConfig, DapResolvedAdapter, JsonObject } from "./types.js"

const YAML_FILE = /ya?ml$/iu
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : []
const object = (value: unknown): JsonObject => record(value) ? { ...value } : {}

const normalize = (value: unknown): DapAdapterConfig | null => {
  if (!record(value) || typeof value.command !== "string" || value.command.length === 0) return null
  return {
    command: value.command,
    args: strings(value.args),
    languages: strings(value.languages),
    fileTypes: strings(value.fileTypes).map((item) => item.toLowerCase()),
    rootMarkers: strings(value.rootMarkers),
    launchDefaults: object(value.launchDefaults),
    attachDefaults: object(value.attachDefaults),
    acceptsDirectoryProgram: value.acceptsDirectoryProgram === true,
    ...(value.connectMode === "socket" || value.connectMode === "tcp"
      ? { connectMode: value.connectMode }
      : {})
  }
}

const builtins = (): Record<string, DapAdapterConfig> => Object.fromEntries(
  Object.entries(defaults).flatMap(([name, value]) => {
    const config = normalize(value)
    return config ? [[name, config]] : []
  })
)

const configPaths = (cwd: string): string[] => {
  const names = ["dap.json", ".dap.json", "dap.yaml", ".dap.yaml", "dap.yml", ".dap.yml"]
  const directories = [cwd, join(cwd, ".jingler"), join(cwd, ".omp"), join(homedir(), ".jingler"), join(homedir(), ".omp", "agent")]
  return directories.flatMap((directory) => names.map((name) => join(directory, name)))
}

const overrides = (cwd: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const file of configPaths(cwd).reverse()) {
    if (!existsSync(file)) continue
    try {
      const parsed = YAML_FILE.test(file) ? parseYaml(readFileSync(file, "utf8")) : JSON.parse(readFileSync(file, "utf8"))
      const source = record(parsed) && record(parsed.adapters) ? parsed.adapters : parsed
      if (record(source)) Object.assign(result, source)
    } catch {
      // A malformed optional config does not hide working built-ins.
    }
  }
  return result
}

export const adapterConfigs = (cwd: string): Record<string, DapAdapterConfig> => {
  const result = builtins()
  for (const [name, value] of Object.entries(overrides(cwd))) {
    const base = result[name]
    const merged = base && record(value)
      ? { ...base, ...value, launchDefaults: { ...base.launchDefaults, ...object(value.launchDefaults) }, attachDefaults: { ...base.attachDefaults, ...object(value.attachDefaults) } }
      : value
    const config = normalize(merged)
    if (config) result[name] = config
  }
  return result
}

const executable = (command: string, cwd: string): string | null => {
  const direct = isAbsolute(command) || command.includes("/") || command.includes("\\")
  const bases = direct
    ? [resolve(cwd, command)]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, command))
  const extensions = process.platform === "win32" && extname(command) === ""
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""]
  const candidates = bases.flatMap((base) => extensions.map((extension) => `${base}${extension}`))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  return null
}

export const resolveAdapter = (cwd: string, name: string): DapResolvedAdapter => {
  const config = adapterConfigs(cwd)[name]
  if (!config) throw new Error(`Unknown debug adapter: ${name}`)
  const commandPath = executable(config.command, cwd)
  if (!commandPath) throw new Error(`Debug adapter ${name} is not installed (${config.command}).`)
  return { ...config, name, commandPath }
}

export const selectLaunchAdapter = (cwd: string, program: string, requested?: string): DapResolvedAdapter => {
  if (requested) return resolveAdapter(cwd, requested)
  const extension = extname(program).toLowerCase()
  const configs = adapterConfigs(cwd)
  const ranked = Object.entries(configs)
    .filter(([, config]) => executable(config.command, cwd) !== null)
    .sort(([, left], [, right]) => {
      const leftExt = left.fileTypes.includes(extension) ? 1 : 0
      const rightExt = right.fileTypes.includes(extension) ? 1 : 0
      if (leftExt !== rightExt) return rightExt - leftExt
      const marker = (config: DapAdapterConfig) => config.rootMarkers.some((name) => existsSync(join(cwd, name))) ? 1 : 0
      return marker(right) - marker(left)
    })
  const chosen = ranked[0]
  if (!chosen) throw new Error("No compatible debug adapter is installed. Configure .jingler/dap.json.")
  return resolveAdapter(cwd, chosen[0])
}

export const selectAttachAdapter = (cwd: string, requested?: string): DapResolvedAdapter => {
  if (requested) return resolveAdapter(cwd, requested)
  for (const name of ["debugpy", "gdb", "lldb-dap", ...Object.keys(adapterConfigs(cwd))]) {
    try { return resolveAdapter(cwd, name) } catch { /* try next */ }
  }
  throw new Error("No debug adapter is installed. Configure .jingler/dap.json.")
}

export const resolveProgram = (cwd: string, program: string): string => isAbsolute(program) ? program : resolve(cwd, program)
export const projectRoot = (path: string): string => dirname(path)
