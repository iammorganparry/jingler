import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../../..")
const connectionCheck = resolve(
  repoRoot,
  "skills/jingler-team-memory/scripts/check-connection.sh"
)
const recallHook = resolve(repoRoot, "skills/jingler-team-memory/hooks/recall.sh")
const persistHook = resolve(repoRoot, "skills/jingler-team-memory/hooks/persist.sh")

let fixtureDirectory = ""
let curlLog = ""

const hookEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${fixtureDirectory}:${process.env.PATH ?? ""}`,
  HOOK_CURL_LOG: curlLog,
  JINGLER_MEMORY_URL: "https://memory.example.test",
  JINGLER_MEMORY_TOKEN: "jmem_test-secret-never-logged",
  JINGLER_MEMORY_ORG: "org-test"
})

const runHook = (
  script: string,
  options: {
    readonly input?: string
    readonly args?: ReadonlyArray<string>
    readonly withoutJq?: boolean
  } = {}
) =>
  // Execute the committed entry point so its shebang selects the promised
  // shell. Forcing every script through `sh` masks this on macOS (where sh is
  // bash-compatible) but makes the bash connection checker exit 2 under
  // Ubuntu's dash before it ever reaches curl.
  spawnSync(script, options.args ?? [], {
    encoding: "utf8",
    env: {
      ...hookEnvironment(),
      ...(options.withoutJq ? { PATH: `${fixtureDirectory}:/usr/bin:/bin` } : {})
    },
    input: options.input ?? ""
  })

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(resolve(tmpdir(), "jingler-memory-hooks-"))
  curlLog = resolve(fixtureDirectory, "curl.log")
  const fakeCurl = resolve(fixtureDirectory, "curl")
  await writeFile(
    fakeCurl,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" >> "$HOOK_CURL_LOG"',
      "case \"$*\" in",
      "  *tools/list*) printf '%s' '{\"result\":{\"tools\":[{\"name\":\"memory_search\"}]}}' ;;",
      "  *memory_read*) printf '%s' '{\"result\":{\"structuredContent\":{\"data\":{\"page\":{\"id\":\"page-1\",\"title\":\"Team fact\",\"body\":\"Use the accepted shared limiter.\"},\"revision\":{\"id\":\"revision-1\"},\"sourceIds\":[\"source-1\"],\"citationIds\":[\"citation-1\"]}}}}' ;;",
      "  *) printf '%s' '{\"result\":{\"structuredContent\":{\"data\":{\"results\":[{\"title\":\"Team fact\",\"pageId\":\"page-1\",\"revisionId\":\"revision-1\",\"snippet\":\"Search-only snippet.\"}]}}}}' ;;",
      "esac",
      "case \"$*\" in *%{http_code}*) printf '\\n200' ;; esac"
    ].join("\n")
  )
  await chmod(fakeCurl, 0o755)
})

afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("team-memory connection check", () => {
  it("connection check uses per-request metadata without putting the token on argv", async () => {
    const result = runHook(connectionCheck, {
      args: ["https://memory.example.test", "org-test"]
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Connected")
    expect(result.stderr).not.toContain("jmem_test-secret-never-logged")
    const request = await readFile(curlLog, "utf8")
    expect(request).toContain("mcp-method: tools/list")
    expect(request).toContain('"io.modelcontextprotocol/protocolVersion":"2026-07-28"')
    expect(request).toContain('"name":"jingler-memory-connection-check"')
  })

})

describe("team-memory recall hook", () => {
  it("sends a self-contained stateless MCP request and injects bounded results", async () => {
    const result = runHook(recallHook, { input: '{"prompt":"How do refunds work?"}' })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("jmem_test-secret-never-logged")
    expect(result.stdout).toContain("<recalled-memories>")
    expect(result.stdout).toContain("Team fact")
    expect(result.stdout).toContain("Use the accepted shared limiter.")
    expect(result.stdout).toContain('"revisionId":"revision-1"')
    expect(result.stdout).toContain('"sourceIds":["source-1"]')
    expect(result.stdout).not.toContain("Search-only snippet")

    const request = await readFile(curlLog, "utf8")
    expect(request).toContain("mcp-protocol-version: 2026-07-28")
    expect(request).toContain("mcp-method: tools/call")
    expect(request).toContain("mcp-name: memory_search")
    expect(request).toContain("mcp-name: memory_read")
    expect(request).toContain('"io.modelcontextprotocol/protocolVersion":"2026-07-28"')
    expect(request).toContain('"name":"jingler-memory-recall-hook"')
  })

  it("retries a sentence-long miss with one focused keyword", async () => {
    const fakeCurl = resolve(fixtureDirectory, "curl")
    await writeFile(
      fakeCurl,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" >> "$HOOK_CURL_LOG"',
        "case \"$*\" in",
        "  *memory_read*) printf '%s' '{\"result\":{\"structuredContent\":{\"data\":{\"page\":{\"id\":\"page-qa\",\"title\":\"Hook QA\",\"body\":\"Deterministic hooks passed accepted-page QA.\"},\"revision\":{\"id\":\"revision-qa\"},\"sourceIds\":[],\"citationIds\":[]}}}}' ;;",
        "  *\\\"query\\\":\\\"deterministic\\\"*) printf '%s' '{\"result\":{\"structuredContent\":{\"data\":{\"results\":[{\"title\":\"Hook QA\",\"pageId\":\"page-qa\",\"snippet\":\"Deterministic hooks passed QA.\"}]}}}}' ;;",
        "  *) printf '%s' '{\"result\":{\"structuredContent\":{\"data\":{\"results\":[]}}}}' ;;",
        "esac"
      ].join("\n")
    )
    await chmod(fakeCurl, 0o755)

    const result = runHook(recallHook, {
      input: '{"prompt":"Did the deterministic hooks pass end-to-end QA?"}'
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Hook QA")
    expect(result.stdout).toContain("accepted-page QA")
    const request = await readFile(curlLog, "utf8")
    expect(request.match(/mcp-name: memory_search/g)).toHaveLength(2)
    expect(request.match(/mcp-name: memory_read/g)).toHaveLength(1)
    expect(request).toContain('"query":"deterministic"')
  })

  it("deduplicates before applying the accepted-page read limit", async () => {
    const fakeCurl = resolve(fixtureDirectory, "curl")
    await writeFile(
      fakeCurl,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" >> "$HOOK_CURL_LOG"',
        "case \"$*\" in",
        "  *memory_read*) printf '%s' '{\"result\":{\"structuredContent\":{\"data\":{\"page\":{\"id\":\"page-read\",\"title\":\"Accepted page\",\"body\":\"Accepted body.\"},\"revision\":{\"id\":\"revision-read\"},\"sourceIds\":[],\"citationIds\":[]}}}}' ;;",
        "  *) printf '%s' '{\"result\":{\"structuredContent\":{\"data\":{\"results\":[{\"pageId\":\"page-1\"},{\"pageId\":\"page-1\"},{\"pageId\":\"page-2\"},{\"pageId\":\"page-3\"}]}}}}' ;;",
        "esac"
      ].join("\n")
    )
    await chmod(fakeCurl, 0o755)

    const result = runHook(recallHook, { input: '{"prompt":"accepted pages"}' })

    expect(result.status).toBe(0)
    const request = await readFile(curlLog, "utf8")
    expect(request.match(/mcp-name: memory_read/g)).toHaveLength(3)
  })

})

describe("team-memory persist hook", () => {
  it("never publishes a Codex notification payload without an explicit marker", async () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "last-assistant-message": "Implemented the requested change."
    })
    const result = runHook(persistHook, { args: [payload] })

    expect(result.status).toBe(0)
    await expect(readFile(curlLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("publishes marked Codex memories with required MCP metadata", async () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "last-assistant-message": "Done.\nMEMORY: Refund retries share one limiter."
    })
    const result = runHook(persistHook, { args: [payload] })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("jmem_test-secret-never-logged")
    const request = await readFile(curlLog, "utf8")
    expect(request).toContain("mcp-name: memory_propose")
    expect(request).toContain('"markdown":"Refund retries share one limiter."')
    expect(request).toContain('"io.modelcontextprotocol/protocolVersion":"2026-07-28"')
    expect(request).not.toContain("agent-turn-complete")
  })

  it("keeps Codex marker persistence working without jq", async () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "last-assistant-message": "Done.\nMEMORY: Use the shared refund limiter."
    })
    const result = runHook(persistHook, { args: [payload], withoutJq: true })

    expect(result.status).toBe(0)
    const request = await readFile(curlLog, "utf8")
    expect(request).toContain('"markdown":"Use the shared refund limiter."')
    expect(request).not.toContain("agent-turn-complete")
  })

  it("keeps an explicit multiline note as one proposal", async () => {
    const result = runHook(persistHook, {
      args: ["First line.\nSecond line."]
    })

    expect(result.status).toBe(0)
    const request = await readFile(curlLog, "utf8")
    expect(request.match(/mcp-name: memory_propose/g)).toHaveLength(1)
    expect(request).toContain('"markdown":"First line.\\nSecond line."')
  })
})
