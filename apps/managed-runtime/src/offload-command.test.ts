import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"

const RUNNER = join(import.meta.dirname, "..", "bin", "offload-exec.mjs")
const roots: string[] = []

const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "jingler-offload-command-"))
  roots.push(root)
  execFileSync("git", ["init", "--initial-branch=main", "--quiet"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@jingler.dev"], { cwd: root })
  execFileSync("git", ["config", "user.name", "Jingler Test"], { cwd: root })
  writeFileSync(join(root, "tracked.txt"), "base\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root })
  return root
}

const runner = (root: string, args: string[]) => spawnSync(
  process.execPath,
  [RUNNER, ...args],
  {
    cwd: root,
    env: { ...process.env, JINGLER_OFFLOAD_WORKSPACE: root },
    encoding: "utf8"
  }
)

const manifest = (root: string): string => {
  const result = runner(root, ["manifest"])
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}

const runCommand = (
  root: string,
  command: { executable: string; args: string[]; timeoutMs?: number }
) => {
  const commandPath = `${root}.command.json`
  const resultPath = `${root}.result.json`
  writeFileSync(commandPath, JSON.stringify({
    ...command,
    cwd: ".",
    timeoutMs: command.timeoutMs ?? 5_000,
    outputBytes: 64 * 1024,
    sourceDigest: manifest(root),
    startAllowed: true
  }))
  const executed = runner(root, ["run", commandPath, resultPath])
  if (executed.status !== 0) throw new Error(executed.stderr)
  return JSON.parse(readFileSync(resultPath, "utf8")) as {
    exitCode: number
    stdout: string
    stderr: string
    timedOut: boolean
    sourceMutated: boolean
    outputTruncated: boolean
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.command.json`, { force: true })
    rmSync(`${root}.result.json`, { force: true })
    rmSync(`${root}.result.json.lock`, { force: true })
  }
})

describe("offload argv executor", () => {
  it("passes metacharacters literally without invoking a shell", () => {
    const root = repository()
    const marker = join(root, "shell-was-invoked")
    const metacharacter = `$(touch ${marker})`
    const result = runCommand(root, {
      executable: "node",
      args: ["-e", "process.stdout.write(process.argv[1])", metacharacter]
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(metacharacter)
    expect(() => readFileSync(marker)).toThrow()
    expect(result.sourceMutated).toBe(false)
  })

  it("reuses its durable result marker instead of executing twice", () => {
    const root = repository()
    const counter = `${root}.counter`
    const commandPath = `${root}.command.json`
    const resultPath = `${root}.result.json`
    writeFileSync(commandPath, JSON.stringify({
      executable: "node",
      args: [
        "-e",
        `const fs=require('node:fs');const p=${JSON.stringify(counter)};const n=Number(fs.existsSync(p)?fs.readFileSync(p):0);fs.writeFileSync(p,String(n+1))`
      ],
      cwd: ".",
      timeoutMs: 5_000,
      outputBytes: 1024,
      sourceDigest: manifest(root),
      startAllowed: true
    }))
    expect(runner(root, ["run", commandPath, resultPath]).status).toBe(0)
    expect(runner(root, ["run", commandPath, resultPath]).status).toBe(0)
    expect(readFileSync(counter, "utf8")).toBe("1")
    rmSync(counter, { force: true })
  })

  it("refuses to restart a command when durable execution ownership is already running", () => {
    const root = repository()
    const marker = `${root}.must-not-run`
    const commandPath = `${root}.command.json`
    const resultPath = `${root}.result.json`
    writeFileSync(commandPath, JSON.stringify({
      executable: "node",
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      cwd: ".",
      timeoutMs: 100,
      outputBytes: 1024,
      sourceDigest: manifest(root),
      startAllowed: false
    }))
    expect(runner(root, ["run", commandPath, resultPath]).status).not.toBe(0)
    expect(() => readFileSync(marker)).toThrow()
    rmSync(marker, { force: true })
  })

  it("bounds buffered output while preserving truncation metadata", () => {
    const root = repository()
    const result = runCommand(root, {
      executable: "node",
      args: ["-e", "process.stdout.write('x'.repeat(1024 * 1024))"]
    })
    expect(Buffer.byteLength(result.stdout)).toBe(64 * 1024)
    expect(result.outputTruncated).toBe(true)
  })

  it("kills the entire command process group on timeout", () => {
    const root = repository()
    const marker = `${root}.descendant`
    const script = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),200)`) }],{stdio:'ignore'})`,
      "setTimeout(()=>{},10000)"
    ].join(";")
    const result = runCommand(root, {
      executable: "node",
      args: ["-e", script],
      timeoutMs: 20
    })
    expect(result.timedOut).toBe(true)
    execFileSync("sleep", ["0.4"])
    expect(() => readFileSync(marker)).toThrow()
    rmSync(marker, { force: true })
  })

  it("detects source mutation and timeout as structured outcomes", () => {
    const mutationRoot = repository()
    const mutated = runCommand(mutationRoot, {
      executable: "node",
      args: [
        "-e",
        "require('node:fs').writeFileSync('tracked.txt', 'changed\\n')"
      ]
    })
    expect(mutated.sourceMutated).toBe(true)

    const timeoutRoot = repository()
    const timedOut = runCommand(timeoutRoot, {
      executable: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 20
    })
    expect(timedOut.timedOut).toBe(true)
  })

  it("rejects a snapshot whose decompressed bytes exceed admission", () => {
    const root = repository()
    const snapshotPath = `${root}.bomb.gz`
    writeFileSync(snapshotPath, gzipSync(Buffer.alloc(1024 * 1024, 65)))
    const restored = runner(root, ["restore", snapshotPath, "128"])
    expect(restored.status).not.toBe(0)
    rmSync(snapshotPath, { force: true })
  })

  it("restores a self-contained local-only HEAD and staged patch", () => {
    const root = repository()
    writeFileSync(join(root, "local-head.txt"), "only in the local commit\n")
    execFileSync("git", ["add", "local-head.txt"], { cwd: root })
    execFileSync("git", ["commit", "--quiet", "-m", "local only"], { cwd: root })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8"
    }).trim()
    const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: root })
    writeFileSync(join(root, "staged.txt"), "staged file\n")
    execFileSync("git", ["add", "staged.txt"], { cwd: root })
    const stagedPatch = execFileSync(
      "git",
      ["diff", "--binary", "--cached", "--no-ext-diff"],
      { cwd: root, encoding: "utf8" }
    )
    const snapshotPath = `${root}.snapshot.gz`
    const encoded = Buffer.from(JSON.stringify({
      version: 1,
      headSha,
      headArchiveBase64: archive.toString("base64"),
      headArchiveBytes: archive.byteLength,
      headArchiveDigest: createHash("sha256").update(archive).digest("hex"),
      headFileCount: 2,
      stagedPatch,
      unstagedPatch: ""
    }))
    writeFileSync(snapshotPath, gzipSync(encoded))
    const restored = runner(root, ["restore", snapshotPath, String(encoded.byteLength)])
    expect(restored.status).toBe(0)
    expect(readFileSync(join(root, "local-head.txt"), "utf8")).toBe("only in the local commit\n")
    expect(readFileSync(join(root, "staged.txt"), "utf8")).toBe("staged file\n")
    rmSync(snapshotPath, { force: true })
  })
})
