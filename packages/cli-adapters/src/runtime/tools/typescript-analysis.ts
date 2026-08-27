import { readFile, rename, writeFile } from "node:fs/promises"
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

const fail = (message: string): ToolError => new ToolError("execution-failed", message)
const contained = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)

const openProject = (cwd: string): NativeProject => {
  const root = resolve(cwd)
  const configPath = resolve(root, "tsconfig.json")
  const api = new API({ cwd: root, collectTiming: true })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] })
    const project = snapshot.getProject(configPath) ?? snapshot.getProjects()[0]
    if (!project) throw fail(`No TypeScript project found under ${root}`)
    return { api, project, root }
  } catch (cause) {
    api.close()
    throw cause
  }
}

const withProject = <Value>(cwd: string, run: (project: NativeProject) => Value): AnalysisResult<Value> => {
  const native = openProject(cwd)
  try {
    const value = run(native)
    return { engine: "typescript-7-native", value, timing: native.api.getTimingInfo().totals }
  } finally {
    native.api.close()
  }
}

const location = (project: NativeProject, node: Node): CodeLocation => {
  const source = node.getSourceFile()
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
  if (!contained(native.root, absolute) || !/\.[cm]?[jt]sx?$/u.test(absolute)) throw fail("File must be TypeScript or JavaScript inside the workspace")
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
  withProject(cwd, (native) => resolvedReferences(native, targetIdentifier(native, file, symbol, line)).map((node) => location(native, node)))

export const codeDefinitions = (cwd: string, file: string, symbol: string, line?: number): AnalysisResult<ReadonlyArray<CodeLocation>> =>
  withProject(cwd, (native) => {
    const target = targetIdentifier(native, file, symbol, line)
    const resolved = native.project.checker.getSymbolAtLocation(target)
    if (!resolved) throw fail(`TypeScript could not resolve symbol: ${symbol}`)
    return resolved.declarations.map((handle) => handle.resolve(native.project)).filter((node): node is Node => node !== undefined).map((node) => location(native, node))
  })

export const codeHover = (cwd: string, file: string, symbol: string, line?: number): AnalysisResult<{ readonly type: string }> =>
  withProject(cwd, (native) => {
    const target = targetIdentifier(native, file, symbol, line)
    const type = native.project.checker.getTypeAtLocation(target)
    if (!type) throw fail(`TypeScript could not resolve type: ${symbol}`)
    return { type: native.project.checker.typeToString(type, target) }
  })

export const codeDiagnostics = (cwd: string, file?: string): AnalysisResult<ReadonlyArray<CodeLocation & { readonly category: string; readonly code: number }>> =>
  withProject(cwd, (native) => {
    const absolute = file ? resolve(native.root, file) : undefined
    if (absolute && !contained(native.root, absolute)) throw fail("Diagnostic file is outside the workspace")
    const diagnostics = [
      ...native.project.program.getSyntacticDiagnostics(absolute),
      ...native.project.program.getSemanticDiagnostics(absolute)
    ]
    return diagnostics.filter((item) => item.fileName && item.pos >= 0).slice(0, 200).map((item) => {
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
  })

export const structuralMatches = (cwd: string, symbol: string, kind: "identifier" | "call"): AnalysisResult<ReadonlyArray<CodeLocation>> =>
  withProject(cwd, (native) => projectIdentifiers(native)
    .filter((node) => node.text === symbol && (kind === "identifier" || (isCallExpression(node.parent) && node.parent.expression === node)))
    .map((node) => location(native, node)))

export const applyIdentifierEdits = async (
  cwd: string,
  locations: ReadonlyArray<CodeLocation>,
  oldName: string,
  newName: string
): Promise<{ readonly files: ReadonlyArray<string>; readonly replacements: number }> => {
  if (!isIdentifierText(newName, ScriptTarget.Latest)) throw new ToolError("invalid-input", "newName must be a valid identifier")
  const grouped = new Map<string, CodeLocation[]>()
  for (const item of locations) grouped.set(item.path, [...(grouped.get(item.path) ?? []), item])
  const originals = new Map<string, string>()
  const next = new Map<string, string>()
  for (const [path, entries] of grouped) {
    const absolute = resolve(cwd, path)
    if (!contained(resolve(cwd), absolute)) throw fail("Edit path escaped the workspace")
    const text = await readFile(absolute, "utf8")
    originals.set(absolute, text)
    const lines = text.split("\n")
    for (const entry of [...entries].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const row = entry.line - 1
      const column = entry.column - 1
      if (lines[row]?.slice(column, column + oldName.length) !== oldName) throw fail(`File changed before edit: ${path}`)
      lines[row] = lines[row]!.slice(0, column) + newName + lines[row]!.slice(column + oldName.length)
    }
    next.set(absolute, lines.join("\n"))
  }
  const written: string[] = []
  try {
    for (const [absolute, text] of next) {
      const temporary = `${absolute}.jingler-${process.pid}.tmp`
      await writeFile(temporary, text, "utf8")
      await rename(temporary, absolute)
      written.push(absolute)
    }
  } catch (cause) {
    await Promise.all(written.map((absolute) => writeFile(absolute, originals.get(absolute)!, "utf8")))
    throw fail(cause instanceof Error ? cause.message : "Could not apply edits")
  }
  return { files: [...grouped.keys()], replacements: locations.length }
}
