import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { link, lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { relative, resolve, sep } from "node:path"
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
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/u
const fail = (message: string): ToolError => new ToolError("execution-failed", message)
const contained = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)

const sourcePaths = (root: string): ReadonlyArray<string> => {
  const found: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isFile() && SOURCE_FILE.test(path)) found.push(path)
      else if (entry.isDirectory() && ![".git", ".jingler", "node_modules", "dist", "out", "release"].includes(entry.name)) visit(path)
    }
  }
  visit(root)
  return found.sort()
}

const configPaths = (root: string, file?: string): ReadonlyArray<string> => {
  if (file) {
    const requested = realpathSync(resolve(root, file))
    if (!contained(root, requested)) throw fail("Requested source resolves outside the workspace")
    let directory = SOURCE_FILE.test(requested) ? resolve(requested, "..") : requested
    while (contained(root, directory)) {
      const candidate = resolve(directory, "tsconfig.json")
      if (existsSync(candidate)) {
        const canonical = realpathSync(candidate)
        if (!contained(root, canonical)) throw fail("tsconfig.json resolves outside the workspace")
        return [canonical]
      }
      const parent = resolve(directory, "..")
      if (parent === directory) break
      directory = parent
    }
    throw fail(`No tsconfig.json contains ${file}`)
  }
  const found: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "tsconfig.json") {
        const canonical = realpathSync(resolve(directory, entry.name))
        if (!contained(root, canonical)) throw fail("tsconfig.json resolves outside the workspace")
        found.push(canonical)
      }
      else if (entry.isDirectory() && ![".git", ".jingler", "node_modules", "dist", "out", "release"].includes(entry.name)) visit(resolve(directory, entry.name))
    }
  }
  visit(root)
  if (found.length === 0) throw fail(`No TypeScript project found under ${root}`)
  return found
}

const withProjects = <Value>(cwd: string, file: string | undefined, run: (projects: ReadonlyArray<NativeProject>) => Value): AnalysisResult<Value> => {
  const root = realpathSync(cwd)
  const api = new API({ cwd: root, collectTiming: true })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [...configPaths(root, file)] })
    const projects = snapshot.getProjects().map((project) => ({ api, project, root }))
    if (projects.length === 0) throw fail(`No TypeScript project found under ${root}`)
    const value = run(projects)
    return { engine: "typescript-7-native", value, timing: api.getTimingInfo().totals }
  } finally {
    api.close()
  }
}

const withProject = <Value>(cwd: string, file: string, run: (project: NativeProject) => Value): AnalysisResult<Value> =>
  withProjects(cwd, file, (projects) => run(projects.find(({ project }) => project.program.getSourceFile(resolve(cwd, file))) ?? projects[0]!))

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
    return source && !source.isDeclarationFile && contained(native.root, resolve(source.fileName))
      ? identifiersIn(source)
      : []
  })

const targetIdentifier = (native: NativeProject, file: string, symbol: string, line?: number): Identifier => {
  const absolute = resolve(native.root, file)
  if (!(contained(native.root, absolute) && SOURCE_FILE.test(absolute))) throw fail("File must be TypeScript or JavaScript inside the workspace")
  const source = native.project.program.getSourceFile(absolute)
  if (!source) throw fail(`File is not part of the TypeScript project: ${file}`)
  const found = identifiersIn(source).find((node) => {
    if (node.text !== symbol) return false
    return line === undefined || source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === line
  })
  if (!found) throw fail(`Symbol not found: ${symbol}`)
  return found
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

export const semanticReferences = (cwd: string, file: string, symbol: string, line?: number): AnalysisResult<ReadonlyArray<CodeLocation>> =>
  withProject(cwd, file, (native) => resolvedReferences(native, targetIdentifier(native, file, symbol, line)).map((node) => location(native, node)))

export const codeDefinitions = (cwd: string, file: string, symbol: string, line?: number): AnalysisResult<ReadonlyArray<CodeLocation>> =>
  withProject(cwd, file, (native) => {
    const target = targetIdentifier(native, file, symbol, line)
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
  })

export const codeHover = (cwd: string, file: string, symbol: string, line?: number): AnalysisResult<{ readonly type: string }> =>
  withProject(cwd, file, (native) => {
    const target = targetIdentifier(native, file, symbol, line)
    const type = native.project.checker.getTypeAtLocation(target)
    if (!type) throw fail(`TypeScript could not resolve type: ${symbol}`)
    return { type: native.project.checker.typeToString(type, target) }
  })

export const codeDiagnostics = (cwd: string, file?: string): AnalysisResult<ReadonlyArray<CodeLocation & { readonly category: string; readonly code: number }>> =>
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
  }).slice(0, 200))

export const structuralMatches = (cwd: string, symbol: string, kind: "identifier" | "call"): AnalysisResult<ReadonlyArray<CodeLocation>> =>
  withProjects(cwd, undefined, (projects) => {
    const matches = projects.flatMap((native) => projectIdentifiers(native)
      .filter((node) => node.text === symbol && (kind === "identifier" || (isCallExpression(node.parent) && node.parent.expression === node)))
      .map((node) => location(native, node)))
    return [...new Map(matches.map((item) => [`${item.path}:${item.line}:${item.column}`, item])).values()]
  })

export const structuralPreview = (
  cwd: string,
  symbol: string,
  kind: "identifier" | "call"
): AnalysisResult<{
  readonly matchCount: number
  readonly matches: ReadonlyArray<CodeLocation>
  readonly previewToken: string
}> => {
  const result = structuralMatches(cwd, symbol, kind)
  const root = realpathSync(cwd)
  const hash = createHash("sha256").update(JSON.stringify(result.value))
  for (const path of sourcePaths(root)) hash.update(relative(root, path)).update(readFileSync(path))
  return {
    ...result,
    value: {
      matchCount: result.value.length,
      matches: result.value,
      previewToken: hash.digest("hex")
    }
  }
}

export const applyIdentifierEdits = async (
  cwd: string,
  locations: ReadonlyArray<CodeLocation>,
  oldName: string,
  newName: string,
  preview?: { readonly kind: "identifier" | "call"; readonly token: string }
): Promise<{ readonly files: ReadonlyArray<string>; readonly replacements: number }> => {
  if (!isIdentifierText(newName, ScriptTarget.Latest)) throw new ToolError("invalid-input", "newName must be a valid identifier")
  const grouped = new Map<string, CodeLocation[]>()
  for (const item of locations) grouped.set(item.path, [...(grouped.get(item.path) ?? []), item])
  const root = await realpath(cwd)
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
  if (preview && structuralPreview(cwd, oldName, preview.kind).value.previewToken !== preview.token) {
    throw fail("Structural preview changed before commit; run structural_search again")
  }
  await Promise.all(prepared.map(({ temporary, next, mode }) =>
    writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode })
  ))
  const linkProbes = await Promise.allSettled(prepared.map(async ({ temporary }) => {
    const probe = `${temporary}.link-probe`
    await link(temporary, probe)
    await rm(probe, { force: true })
  }))
  const unsupportedLink = linkProbes.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (unsupportedLink) {
    await Promise.all(prepared.flatMap(({ temporary }) => [
      rm(temporary, { force: true }),
      rm(`${temporary}.link-probe`, { force: true })
    ]))
    throw fail("Atomic file claiming is unsupported on this filesystem")
  }
  const restore = async (items: typeof prepared): Promise<void> => {
    const results = await Promise.allSettled(items.map(async ({ absolute, backup }) => {
      await link(backup, absolute)
      await rm(backup, { force: true })
    }))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed) throw fail("Automatic restore failed; original files remain in adjacent .jingler-*.backup files")
  }
  const claims = await Promise.allSettled(prepared.map(({ absolute, backup }) => rename(absolute, backup)))
  const claimed = prepared.filter((_, index) => claims[index]?.status === "fulfilled")
  const claimFailure = claims.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (claimFailure) {
    await restore(claimed)
    await Promise.all(prepared.map(({ temporary }) => rm(temporary, { force: true })))
    throw fail(claimFailure.reason instanceof Error ? claimFailure.reason.message : "Could not claim edit files")
  }
  const [claimedFiles, claimedContents] = await Promise.all([
    Promise.all(claimed.map(({ backup }) => lstat(backup))),
    Promise.all(claimed.map(({ backup }) => readFile(backup, "utf8")))
  ])
  if (claimedContents.some((content, index) => content !== claimed[index]?.original)) {
    await restore(claimed)
    await Promise.all(prepared.map(({ temporary }) => rm(temporary, { force: true })))
    throw fail("Edit target changed before commit")
  }
  if (claimedFiles.some((info) => !info.isFile())) {
    await restore(claimed)
    await Promise.all(prepared.map(({ temporary }) => rm(temporary, { force: true })))
    throw fail("Edit target changed type before commit")
  }
  const commits = await Promise.allSettled(prepared.map(({ temporary, absolute }) => link(temporary, absolute)))
  const committed = prepared.filter((_, index) => commits[index]?.status === "fulfilled")
  const commitFailure = commits.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (commitFailure) {
    await Promise.all(committed.map(({ absolute }) => rm(absolute, { force: true })))
    await restore(claimed)
    await Promise.all(prepared.map(({ temporary }) => rm(temporary, { force: true })))
    throw fail(commitFailure.reason instanceof Error ? commitFailure.reason.message : "Could not commit edits")
  }
  await Promise.all(prepared.flatMap(({ temporary, backup }) => [
    rm(temporary, { force: true }),
    rm(backup, { force: true })
  ]))
  return { files: [...grouped.keys()], replacements: locations.length }
}
