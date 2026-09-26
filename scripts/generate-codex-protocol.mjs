import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const binary = process.env.JINGLER_CODEX_BINARY ?? "codex"
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
if (version !== "codex-cli 0.153.2") throw new Error(`Expected codex-cli 0.153.2; got ${version}`)
const temporary = mkdtempSync(join(tmpdir(), "jingler-codex-schema-"))
const destination = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/cli-adapters/src/runtime/codex/generated"
)
const roots = [
  "InitializeParams",
  "InitializeResponse",
  ...[
    "ThreadStartParams",
    "ThreadResumeParams",
    "ThreadForkParams",
    "TurnStartParams",
    "TurnSteerParams",
    "TurnInterruptParams",
    "ModelListParams",
    "ModelListResponse",
    "GetAccountParams",
    "GetAccountResponse",
    "LoginAccountParams",
    "LoginAccountResponse",
    "CancelLoginAccountParams",
    "CancelLoginAccountResponse",
    "ThreadItem",
    "ThreadTokenUsage",
    "ToolRequestUserInputParams",
    "ToolRequestUserInputResponse",
    "CommandExecutionRequestApprovalResponse",
    "FileChangeRequestApprovalResponse",
    "Turn",
    "PermissionsRequestApprovalParams",
    "PermissionsRequestApprovalResponse"
  ].map((name) => `v2/${name}`)
]
const visited = new Set()
const imports = /from "([^"]+)"/gu
const copy = (path) => {
  if (visited.has(path)) return
  visited.add(path)
  const content = readFileSync(path, "utf8")
  for (const match of content.matchAll(imports)) copy(resolve(dirname(path), `${match[1]}.ts`))
  const output = join(destination, relative(temporary, path))
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, content)
}
try {
  execFileSync(binary, ["app-server", "generate-ts", "--out", temporary], { stdio: "inherit" })
  for (const name of roots) copy(join(temporary, `${name}.ts`))
  console.log(`Copied ${visited.size} unmodified generated protocol types from ${version}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
