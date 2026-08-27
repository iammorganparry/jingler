import { realpathSync } from "node:fs"
import { readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { promisify } from "node:util"
import { basename, dirname, extname, relative, resolve, sep } from "node:path"
import { parse } from "jsonc-parser"
import { lock } from "proper-lockfile"
import { API, DiagnosticCategory, type Project, type TimingInfo } from "typescript/unstable/sync"
import { ScriptTarget } from "typescript/unstable/ast"
import { isCallExpression, isIdentifier } from "typescript/unstable/ast/is"
import { isIdentifierText } from "typescript/unstable/ast/scanner"
import type { Identifier, Node, SourceFile } from "typescript/unstable/ast"
import { ToolError } from "./tool-registry.js"

export interface CodeLocation {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly text: string
}

export interface AnalysisResult<Value> {
  readonly engine: "typescript-7-native"
  readonly value: Value
  readonly timing: TimingInfo["totals"]
}

interface NativeProject {
  readonly api: API
  readonly project: Project
  readonly root: string
  readonly allowedPaths: ReadonlySet<string> | null
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/u
const PROJECT_RESOURCE = /\.(?:json|[cm]?[jt]sx?)$/u
const fail = (message: string): ToolError => new ToolError("execution-failed", message)
const contained = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)

const MAX_WORKSPACE_PATHS = 20_000
const MAX_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_SINGLE_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_DEPENDENCY_FILES = 100_000
const MAX_DEPENDENCY_BYTES = 1024 * 1024 * 1024
const MAX_PROJECTS = 64
const MAX_CONFIG_BYTES = 1024 * 1024
const execFileAsync = promisify(execFile)
const EXCLUDED_DIRECTORIES = new Set([".git", ".jingler", "node_modules", "dist", "out", "release"])

const fallbackWorkspacePaths = async (root: string, signal?: AbortSignal): Promise<ReadonlyArray<string>> => {
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (found.length >= MAX_WORKSPACE_PATHS) throw fail(`Workspace analysis exceeds ${MAX_WORKSPACE_PATHS} files`)
      const path = resolve(directory, entry.name)
      if (entry.isFile()) found.push(relative(root, path))
      else if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path)
    }
  }
  await visit(root)
  return found.sort()
}

const SOURCE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(|\bimport\s*|\brequire\s*\(|<reference\s+path=)\s*["']([^"']+)["']/gu
const preflightCache = new Map<string, { readonly expiresAt: number; readonly value: Promise<void> }>()

const inspectBoundedSourceTree = async (root: string, signal?: AbortSignal): Promise<void> => {
  let workspaceFiles = 0
  let workspaceBytes = 0
  let dependencyFiles = 0
  let dependencyBytes = 0
  const visited = new Set<string>()
  const inspectFile = async (path: string, dependency: boolean): Promise<void> => {
    if (!PROJECT_RESOURCE.test(path)) return
    const size = (await stat(path)).size
    if (size > MAX_SINGLE_SOURCE_BYTES) throw fail("Workspace is too large for synchronous TypeScript analysis")
    if (dependency) {
      dependencyFiles += 1
      dependencyBytes += size
      if (dependencyFiles > MAX_DEPENDENCY_FILES || dependencyBytes > MAX_DEPENDENCY_BYTES) {
        throw fail("TypeScript dependency graph is too large for synchronous analysis")
      }
      return
    }
    workspaceFiles += 1
    workspaceBytes += size
    if (workspaceFiles > MAX_WORKSPACE_PATHS || workspaceBytes > MAX_SOURCE_BYTES) {
      throw fail("Workspace is too large for synchronous TypeScript analysis")
    }
    if (!SOURCE_FILE.test(path)) return
    const source = await readFile(path, "utf8")
    for (const match of source.matchAll(SOURCE_IMPORT)) {
      const specifier = match[1]!
      if (!(specifier.startsWith(".") || specifier.startsWith("/"))) {
        if (specifier.startsWith("node:")) continue
        try {
          if (!contained(root, await realpath(createRequire(path).resolve(specifier)))) {
            throw fail("TypeScript dependency resolves outside the workspace")
          }
        } catch (cause) {
          if (cause instanceof ToolError) throw cause
        }
        continue
      }
      const target = resolve(dirname(path), specifier)
      if (!contained(root, target)) throw fail("TypeScript source import escapes the workspace")
      for (const candidate of [target, ...[".ts", ".tsx", ".js", ".jsx", ".json"].map((extension) => `${target}${extension}`)]) {
        try {
          if (!contained(root, await realpath(candidate))) throw fail("TypeScript source import resolves outside the workspace")
          break
        } catch (cause) {
          if (cause instanceof ToolError) throw cause
          if (!(cause instanceof Error && Reflect.get(cause, "code") === "ENOENT")) throw cause
        }
      }
    }
  }
  const visit = async (directory: string, dependency: boolean): Promise<void> => {
    signal?.throwIfAborted()
    const canonicalDirectory = await realpath(directory)
    if (!contained(root, canonicalDirectory) || visited.has(canonicalDirectory)) return
    visited.add(canonicalDirectory)
    for (const entry of await readdir(canonicalDirectory, { withFileTypes: true })) {
      if ([".git", ".jingler", ".agents"].includes(entry.name)) continue
      const path = resolve(canonicalDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(path, dependency || entry.name === "node_modules")
      } else if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        if (!contained(root, target)) throw fail("TypeScript project symlink resolves outside the workspace")
        const targetStat = await stat(target)
        if (targetStat.isDirectory()) await visit(target, dependency)
        else if (targetStat.isFile()) await inspectFile(target, dependency)
      } else if (entry.isFile()) {
        await inspectFile(path, dependency)
      }
    }
  }
  await visit(root, false)
}

const assertBoundedSourceTree = async (root: string, signal?: AbortSignal): Promise<void> => {
  const cached = preflightCache.get(root)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const value = inspectBoundedSourceTree(root, signal)
  preflightCache.set(root, { expiresAt: Date.now() + 30_000, value })
  try {
    await value
  } catch (cause) {
    preflightCache.delete(root)
    throw cause
  }
}

const workspacePaths = async (root: string, signal?: AbortSignal): Promise<ReadonlyArray<string>> => {
  let stdout: string
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal }
    ))
  } catch (cause) {
    if (signal?.aborted) throw cause
    return fallbackWorkspacePaths(root, signal)
  }
  const paths = stdout.split("\0").filter(Boolean)
  if (paths.length > MAX_WORKSPACE_PATHS) throw fail(`Workspace analysis exceeds ${MAX_WORKSPACE_PATHS} files`)
  return paths.sort()
}

const sourcePaths = async (root: string, signal?: AbortSignal): Promise<ReadonlyArray<string>> =>
  (await workspacePaths(root, signal)).filter((path) => SOURCE_FILE.test(path)).map((path) => resolve(root, path))

const configPaths = async (root: string, file?: string, signal?: AbortSignal): Promise<ReadonlyArray<string>> => {
  if (file) {
    const requested = await realpath(resolve(root, file))
    if (!contained(root, requested)) throw fail("Requested source resolves outside the workspace")
    let directory = SOURCE_FILE.test(requested) ? resolve(requested, "..") : requested
    while (contained(root, directory)) {
      signal?.throwIfAborted()
      const candidate = resolve(directory, "tsconfig.json")
      try {
        const canonical = await realpath(candidate)
        if (!contained(root, canonical)) throw fail("tsconfig.json resolves outside the workspace")
        return [canonical]
      } catch (cause) {
        if (!(cause instanceof Error && Reflect.get(cause, "code") === "ENOENT")) throw cause
      }
      const parent = resolve(directory, "..")
      if (parent === directory) break
      directory = parent
    }
    throw fail(`No tsconfig.json contains ${file}`)
  }
  const found = await Promise.all((await workspacePaths(root, signal))
    .filter((path) => basename(path) === "tsconfig.json")
    .map((path) => realpath(resolve(root, path))))
  if (found.length === 0) throw fail(`No TypeScript project found under ${root}`)
  if (found.length > MAX_PROJECTS) throw fail(`Workspace analysis exceeds ${MAX_PROJECTS} TypeScript projects`)
  if (found.some((path) => !contained(root, path))) throw fail("tsconfig.json resolves outside the workspace")
  return found
}

const objectRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const strings = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const validateProjectConfigs = async (
  root: string,
  initial: ReadonlyArray<string>,
  signal?: AbortSignal
): Promise<void> => {
  const pending = [...initial]
  const visited = new Set<string>()
  let bytes = 0
  const containedPath = (base: string, path: string): string => {
    const absolute = resolve(base, path)
    if (!contained(root, absolute)) throw fail("TypeScript project path escapes the workspace")
    return absolute
  }
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const config = await realpath(pending.pop()!)
    if (!contained(root, config)) throw fail("TypeScript config resolves outside the workspace")
    if (visited.has(config)) continue
    visited.add(config)
    if (visited.size > MAX_PROJECTS) throw fail(`Workspace analysis exceeds ${MAX_PROJECTS} TypeScript projects`)
    const size = (await stat(config)).size
    bytes += size
    if (bytes > MAX_CONFIG_BYTES) throw fail("TypeScript configuration exceeds 1 MB")
    const source = await readFile(config, "utf8")
    const parsed = objectRecord(parse(source))
    const base = dirname(config)
    for (const value of strings(parsed.extends)) {
      let target: string
      if (value.startsWith(".") || value.startsWith("/") || value.startsWith("..")) {
        target = containedPath(base, value)
        if (extname(target) === "") target = `${target}.json`
      } else {
        target = createRequire(config).resolve(value)
      }
      const canonical = await realpath(target)
      if (!contained(root, canonical)) throw fail("Extended TypeScript config escapes the workspace")
      pending.push(canonical)
    }
    for (const reference of Array.isArray(parsed.references) ? parsed.references : []) {
      const path = objectRecord(reference).path
      if (typeof path !== "string") continue
      const target = containedPath(base, path)
      pending.push(await realpath(extname(target) === ".json" ? target : resolve(target, "tsconfig.json")))
    }
    for (const path of [...strings(parsed.files), ...strings(parsed.include), ...strings(parsed.exclude)]) {
      containedPath(base, path.replace(/[?*].*$/u, ""))
    }
    const compiler = objectRecord(parsed.compilerOptions)
    for (const key of ["baseUrl", "rootDir", "outDir", "declarationDir"] as const) {
      for (const path of strings(compiler[key])) containedPath(base, path)
    }
    for (const key of ["typeRoots", "rootDirs"] as const) {
      for (const path of strings(compiler[key])) containedPath(base, path)
    }
    for (const targets of Object.values(objectRecord(compiler.paths))) {
      for (const path of strings(targets)) containedPath(base, path.replace(/[?*].*$/u, ""))
    }
  }
}

const withProjects = async <Value>(
  cwd: string,
  file: string | undefined,
  run: (projects: ReadonlyArray<NativeProject>) => Value,
  signal?: AbortSignal
): Promise<AnalysisResult<Value>> => {
  const root = await realpath(cwd)
  await assertBoundedSourceTree(root, signal)
  const configs = await configPaths(root, file, signal)
  await validateProjectConfigs(root, configs, signal)
  const api = new API({ cwd: root, collectTiming: true })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [...configs] })
    const allowedPaths = file === undefined ? new Set(await workspacePaths(root, signal)) : null
    const projects = snapshot.getProjects().map((project) => ({ api, project, root, allowedPaths }))
    if (projects.length === 0) throw fail(`No TypeScript project found under ${root}`)
    const value = run(projects)
    return { engine: "typescript-7-native", value, timing: api.getTimingInfo().totals }
  } finally {
    api.close()
  }
}

const withProject = <Value>(
  cwd: string,
  file: string,
  run: (project: NativeProject) => Value,
  signal?: AbortSignal
): Promise<AnalysisResult<Value>> => withProjects(cwd, file, (projects) => {
  const project = projects.find((candidate) => candidate.project.program.getSourceFile(resolve(cwd, file))) ?? projects[0]!
  return run(project)
}, signal)

const location = (project: NativeProject, node: Node): CodeLocation => {
  const source = node.getSourceFile()
  const canonical = realpathSync(source.fileName)
  if (!contained(project.root, canonical)) throw fail("TypeScript result resolves outside the workspace")
  const point = source.getLineAndCharacterOfPosition(node.getStart(source))
  return {
    path: relative(project.root, source.fileName),
    line: point.line + 1,
    column: point.character + 1,
    text: node.getText(source).slice(0, 160)
  }
}

const identifiersIn = (source: SourceFile): ReadonlyArray<Identifier> => {
  const result: Identifier[] = []
  const visit = (node: Node): void => {
    if (isIdentifier(node)) result.push(node)
    node.forEachChild((child) => { visit(child) })
  }
  visit(source)
  return result
}

const projectIdentifiers = (native: NativeProject): ReadonlyArray<Identifier> =>
  native.project.program.getSourceFileNames().flatMap((file) => {
    const source = native.project.program.getSourceFile(file)
    const path = relative(native.root, resolve(file))
    return source &&
      !source.isDeclarationFile &&
      contained(native.root, resolve(source.fileName)) &&
      (native.allowedPaths === null || native.allowedPaths.has(path))
      ? identifiersIn(source)
      : []
  })

const targetIdentifier = (
  native: NativeProject,
  file: string,
  symbol: string,
  line?: number,
  column?: number
): Identifier => {
  const absolute = resolve(native.root, file)
  if (!(contained(native.root, absolute) && SOURCE_FILE.test(absolute))) throw fail("File must be TypeScript or JavaScript inside the workspace")
  const source = native.project.program.getSourceFile(absolute)
  if (!source) throw fail(`File is not part of the TypeScript project: ${file}`)
  const matches = identifiersIn(source).filter((node) => {
    if (node.text !== symbol) return false
    const point = source.getLineAndCharacterOfPosition(node.getStart(source))
    return (line === undefined || point.line + 1 === line) &&
      (column === undefined || point.character + 1 === column)
  })
  if (matches.length === 0) throw fail(`Symbol not found: ${symbol}`)
  if (matches.length > 1) throw fail(`Symbol is ambiguous on line ${line}; provide column`)
  return matches[0]!
}

const resolvedReferences = (native: NativeProject, target: Identifier): ReadonlyArray<Node> => {
  const entries = native.project.checker.getReferencedSymbolsForNode(target, target.getStart())
  const nodes = entries.flatMap((entry) => [entry.definition.resolve(native.project), ...entry.references.map((handle) => handle.resolve(native.project))])
    .filter((node): node is Node => node !== undefined)
  if (nodes.length > 0) {
    const exact = nodes.flatMap((node) => {
      if (isIdentifier(node) && node.text === target.text) return [node]
      const source = node.getSourceFile()
      return identifiersIn(source).filter((identifier) =>
        identifier.text === target.text &&
        identifier.getStart(source) >= node.getStart(source) &&
        identifier.getEnd() <= node.getEnd()
      )
    })
    return [...new Map(exact.map((node) => [`${node.getSourceFile().fileName}:${node.getStart()}`, node])).values()]
  }
  const symbol = native.project.checker.getSymbolAtLocation(target)
  if (!symbol) throw fail(`TypeScript could not resolve symbol: ${target.text}`)
  return projectIdentifiers(native).filter((node) => native.project.checker.getSymbolAtLocation(node)?.id === symbol.id)
}

export const semanticReferences = (
  cwd: string,
  file: string,
  symbol: string,
  line?: number,
  column?: number,
  signal?: AbortSignal
): Promise<AnalysisResult<ReadonlyArray<CodeLocation>>> =>
  withProject(cwd, file, (native) => resolvedReferences(native, targetIdentifier(native, file, symbol, line, column)).map((node) => location(native, node)), signal)

export const codeDefinitions = (
  cwd: string,
  file: string,
  symbol: string,
  line?: number,
  column?: number,
  signal?: AbortSignal
): Promise<AnalysisResult<ReadonlyArray<CodeLocation>>> =>
  withProject(cwd, file, (native) => {
    const target = targetIdentifier(native, file, symbol, line, column)
    const queue: Node[] = [target]
    const definitions = new Map<string, Node>()
    for (let depth = 0; depth < 4 && queue.length > 0; depth++) {
      const current = queue.splice(0)
      for (const candidate of current) {
        for (const { definition } of native.project.checker.getReferencedSymbolsForNode(candidate, candidate.getStart())) {
          const node = definition.resolve(native.project)
          if (!node) continue
          const key = `${node.getSourceFile().fileName}:${node.getStart()}`
          if (definitions.has(key)) continue
          definitions.set(key, node)
          const source = node.getSourceFile()
          queue.push(...identifiersIn(source).filter((identifier) =>
            identifier.getStart(source) >= node.getStart(source) && identifier.getEnd() <= node.getEnd()
          ))
        }
      }
    }
    if (definitions.size > 0) return [...definitions.values()].map((node) => location(native, node))
    const resolved = native.project.checker.getSymbolAtLocation(target)
    if (!resolved) throw fail(`TypeScript could not resolve symbol: ${symbol}`)
    return resolved.declarations.map((handle) => handle.resolve(native.project)).filter((node): node is Node => node !== undefined).map((node) => location(native, node))
  }, signal)

export const codeHover = (
  cwd: string,
  file: string,
  symbol: string,
  line?: number,
  column?: number,
  signal?: AbortSignal
): Promise<AnalysisResult<{ readonly type: string }>> =>
  withProject(cwd, file, (native) => {
    const target = targetIdentifier(native, file, symbol, line, column)
    const type = native.project.checker.getTypeAtLocation(target)
    if (!type) throw fail(`TypeScript could not resolve type: ${symbol}`)
    return { type: native.project.checker.typeToString(type, target) }
  }, signal)

export const codeDiagnostics = (
  cwd: string,
  file?: string,
  signal?: AbortSignal,
  limit = 200
): Promise<AnalysisResult<ReadonlyArray<CodeLocation & { readonly category: string; readonly code: number }>>> =>
  withProjects(cwd, file, (projects) => projects.flatMap((native) => {
    const absolute = file ? resolve(native.root, file) : undefined
    if (absolute && !contained(native.root, absolute)) throw fail("Diagnostic file is outside the workspace")
    return [
      ...native.project.program.getSyntacticDiagnostics(absolute),
      ...native.project.program.getSemanticDiagnostics(absolute)
    ].filter((item) => item.fileName && item.pos >= 0).map((item) => {
      const source = native.project.program.getSourceFile(item.fileName!)
      if (!source) throw fail(`Diagnostic source unavailable: ${item.fileName}`)
      const point = source.getLineAndCharacterOfPosition(item.pos)
      return {
        path: relative(native.root, source.fileName),
        line: point.line + 1,
        column: point.character + 1,
        text: item.text.slice(0, 500),
        category: DiagnosticCategory[item.category] ?? "Unknown",
        code: item.code
      }
    })
  }).slice(0, limit), signal)

export const structuralMatches = (
  cwd: string,
  symbol: string,
  kind: "identifier" | "call",
  signal?: AbortSignal
): Promise<AnalysisResult<ReadonlyArray<CodeLocation>>> =>
  withProjects(cwd, undefined, (projects) => {
    const matches = projects.flatMap((native) => projectIdentifiers(native)
      .filter((node) => node.text === symbol && (kind === "identifier" || (isCallExpression(node.parent) && node.parent.expression === node)))
      .map((node) => location(native, node)))
    return [...new Map(matches.map((item) => [`${item.path}:${item.line}:${item.column}`, item])).values()]
  }, signal)

export const structuralPreview = async (
  cwd: string,
  symbol: string,
  kind: "identifier" | "call",
  signal?: AbortSignal
): Promise<AnalysisResult<{
  readonly matchCount: number
  readonly matches: ReadonlyArray<CodeLocation>
  readonly previewToken: string
}>> => {
  const result = await structuralMatches(cwd, symbol, kind, signal)
  const root = await realpath(cwd)
  const hash = createHash("sha256").update(JSON.stringify(result.value))
  for (const path of await sourcePaths(root, signal)) hash.update(relative(root, path)).update(await readFile(path))
  return {
    ...result,
    value: {
      matchCount: result.value.length,
      matches: result.value,
      previewToken: hash.digest("hex")
    }
  }
}

const acquireEditLocks = async (
  root: string,
  paths: ReadonlyArray<string>
): Promise<() => Promise<void>> => {
  const releases = await Promise.allSettled([...paths].sort().map((path) => {
    const absolute = resolve(root, path)
    if (!contained(root, absolute)) throw fail("Edit path escaped the workspace")
    return lock(absolute, {
      lockfilePath: `${absolute}.jingler-edit.lock`,
      stale: 5_000,
      update: 1_000,
      retries: 0,
      realpath: true
    })
  }))
  const acquired = releases.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
  const failure = releases.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure) {
    await Promise.all(acquired.map((release) => release()))
    throw fail("Another Jingler edit is already changing these files")
  }
  return () => Promise.all(acquired.map((release) => release())).then(() => undefined)
}

export const applyIdentifierEdits = async (
  cwd: string,
  locations: ReadonlyArray<CodeLocation>,
  oldName: string,
  newName: string,
  options?: {
    readonly preview?: { readonly kind: "identifier" | "call"; readonly token: string }
    readonly validate?: () => Promise<void>
  }
): Promise<{ readonly files: ReadonlyArray<string>; readonly replacements: number }> => {
  if (!isIdentifierText(newName, ScriptTarget.Latest)) throw new ToolError("invalid-input", "newName must be a valid identifier")
  const grouped = new Map<string, CodeLocation[]>()
  for (const item of locations) grouped.set(item.path, [...(grouped.get(item.path) ?? []), item])
  const root = await realpath(cwd)
  const releaseLocks = await acquireEditLocks(root, [...grouped.keys()])
  try {
  const prepared = await Promise.all([...grouped].map(async ([path, entries]) => {
    const absolute = resolve(root, path)
    if (!contained(root, absolute)) throw fail("Edit path escaped the workspace")
    const canonical = await realpath(absolute)
    if (canonical !== absolute || !contained(root, canonical)) throw fail(`Edit path crosses a symlink: ${path}`)
    const [original, metadata] = await Promise.all([readFile(canonical, "utf8"), stat(canonical)])
    const lines = original.split("\n")
    for (const entry of [...entries].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const row = entry.line - 1
      const column = entry.column - 1
      if (lines[row]?.slice(column, column + oldName.length) !== oldName) throw fail(`File changed before edit: ${path}`)
      lines[row] = lines[row]!.slice(0, column) + newName + lines[row]!.slice(column + oldName.length)
    }
    return {
      absolute,
      mode: metadata.mode,
      original,
      next: lines.join("\n"),
      temporary: `${absolute}.jingler-${process.pid}-${randomUUID()}.tmp`,
      backup: `${absolute}.jingler-${process.pid}-${randomUUID()}.backup`
    }
  }))
  if (options?.preview && (await structuralPreview(cwd, oldName, options.preview.kind)).value.previewToken !== options.preview.token) {
    throw fail("Structural preview changed before commit; run structural_search again")
  }
  await Promise.all(prepared.map(({ temporary, next, mode }) =>
    writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode })
  ))
  const backups = await Promise.allSettled(prepared.map(({ backup, original, mode }) =>
    writeFile(backup, original, { encoding: "utf8", flag: "wx", mode })
  ))
  const backupFailure = backups.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (backupFailure) {
    await Promise.all(prepared.flatMap(({ temporary, backup }) => [rm(temporary, { force: true }), rm(backup, { force: true })]))
    throw fail(backupFailure.reason instanceof Error ? backupFailure.reason.message : "Could not prepare edit backups")
  }
  const restore = async (items: typeof prepared): Promise<void> => {
    const results = await Promise.allSettled(items.map(({ absolute, backup }) => rename(backup, absolute)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed) throw fail("Automatic restore failed; original files remain in adjacent .jingler-*.backup files")
  }
  const [currentFiles, currentContents] = await Promise.all([
    Promise.all(prepared.map(({ absolute }) => stat(absolute))),
    Promise.all(prepared.map(({ absolute }) => readFile(absolute, "utf8")))
  ])
  if (currentContents.some((content, index) => content !== prepared[index]?.original) || currentFiles.some((info) => !info.isFile())) {
    await Promise.all(prepared.flatMap(({ temporary, backup }) => [rm(temporary, { force: true }), rm(backup, { force: true })]))
    throw fail("Edit target changed before commit")
  }
  const commits = await Promise.allSettled(prepared.map(({ temporary, absolute }) => rename(temporary, absolute)))
  const committed = prepared.filter((_, index) => commits[index]?.status === "fulfilled")
  const commitFailure = commits.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (commitFailure) {
    await restore(committed)
    await Promise.all(prepared.flatMap(({ temporary, backup }) => [rm(temporary, { force: true }), rm(backup, { force: true })]))
    throw fail(commitFailure.reason instanceof Error ? commitFailure.reason.message : "Could not commit edits")
  }
  try {
    await options?.validate?.()
  } catch (cause) {
    await restore(prepared)
    throw cause
  }
  await Promise.all(prepared.flatMap(({ temporary, backup }) => [
    rm(temporary, { force: true }),
    rm(backup, { force: true })
  ]))
  return { files: [...grouped.keys()], replacements: locations.length }
  } finally {
    await releaseLocks()
  }
}

const shiftedLocations = (
  locations: ReadonlyArray<CodeLocation>,
  oldName: string,
  newName: string
): ReadonlyArray<CodeLocation> => locations.map((location) => ({
  ...location,
  column: location.column + locations.filter((candidate) =>
    candidate.path === location.path &&
    candidate.line === location.line &&
    candidate.column < location.column
  ).length * (newName.length - oldName.length),
  text: newName
}))

const locationKeys = (locations: ReadonlyArray<CodeLocation>): ReadonlyArray<string> =>
  locations.map(({ path, line, column }) => `${path}:${line}:${column}`).sort()

export const semanticRename = async (
  cwd: string,
  file: string,
  symbol: string,
  line: number,
  column: number | undefined,
  newName: string,
  signal?: AbortSignal
): Promise<{ readonly files: ReadonlyArray<string>; readonly replacements: number }> => {
  const references = (await semanticReferences(cwd, file, symbol, line, column, signal)).value
  const baselineDiagnostics = (await codeDiagnostics(cwd, undefined, signal, Number.MAX_SAFE_INTEGER)).value
  const expected = shiftedLocations(references, symbol, newName)
  const targetPath = relative(await realpath(cwd), await realpath(resolve(cwd, file)))
  const targetIndex = references.findIndex((item) =>
    item.path === targetPath && item.line === line && (column === undefined || item.column === column)
  )
  const target = expected[targetIndex]
  if (!target) throw fail(`Rename target not found in semantic references: ${symbol}`)
  return applyIdentifierEdits(cwd, references, symbol, newName, {
    validate: async () => {
      const renamed = (await semanticReferences(cwd, file, newName, line, target.column, signal)).value
      const diagnostics = (await codeDiagnostics(cwd, undefined, signal, Number.MAX_SAFE_INTEGER)).value
      const baseline = new Set(baselineDiagnostics.map(({ path, line, column, code }) => `${path}:${line}:${column}:${code}`))
      const introducedDiagnostic = diagnostics.some(({ path, line, column, code }) =>
        !baseline.has(`${path}:${line}:${column}:${code}`)
      )
      if (introducedDiagnostic || JSON.stringify(locationKeys(renamed)) !== JSON.stringify(locationKeys(expected))) {
        throw fail(`Rename to ${newName} would change symbol binding`)
      }
    }
  })
}
