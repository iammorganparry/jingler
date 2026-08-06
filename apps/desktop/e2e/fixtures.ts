import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { expect, test as base } from "@playwright/test"
import type { ElectronApplication, Page } from "@playwright/test"
import { _electron as electron } from "playwright"
import { startFakeAuthServer, type FakeAuthServer } from "./fake-auth.js"
import { MAIN_ENTRY } from "./global-setup.js"
import { FALLBACK_MODELS } from "@jingler/core"

/**
 * Model labels read from the catalogue rather than written out in each spec.
 *
 * `FALLBACK_MODELS` is what the app shows when live discovery has no credentials,
 * which is exactly the e2e's situation — so these ARE the labels on screen. Taking
 * them from the source matters because they move: one commit re-cased and
 * re-versioned the whole Claude list (`opus` → `Opus 5`, and the bare `sonnet` id
 * became `sonnet[1m]`/"Sonnet 5 1M") without touching a spec, and six assertions
 * across four specs had been matching `/opus/` case-sensitively ever since.
 * Because this suite is not in CI, nothing reported it.
 */
const CLAUDE_MODELS = FALLBACK_MODELS.claude
/** The composer chip's initial reading: `defaultModel` takes index 0. */
export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0]!.label
/**
 * A different Claude model to switch to. Selected by id prefix rather than label
 * because ids are the stable half of the catalogue, and from index 1 onwards so it
 * stays distinct from the default even if Sonnet is ever promoted to first.
 */
export const ALT_CLAUDE_MODEL = CLAUDE_MODELS.slice(1).find((m) =>
  m.id.startsWith("sonnet")
)!.label

/** Match PlanStore's collision-proof directory for one physical checkout. */
export const planDirectory = (
  home: string,
  worktreePath: string
): string => {
  let canonical: string
  try {
    canonical = realpathSync(worktreePath)
  } catch {
    canonical = resolve(worktreePath)
  }
  const suffix = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12)
  return join(
    home,
    "jingler",
    ".jingler",
    `${basename(canonical)}-${suffix}`
  )
}

/**
 * Put the sidebar's Status filter on `archived` (or `all`) so archived sessions
 * are listed at all.
 *
 * They used to live in a permanent "Archived" group pinned to the bottom of the
 * sidebar. That group is gone: archived is a FILTER now, and the default hides it
 * (see `session-filters.ts` — "one model, and the default hides them"). Specs
 * written against the old group had been asserting on a heading that no longer
 * exists, which reads as "archiving is broken" when it is working exactly as
 * designed. Going through the real menu also tests the route a user actually has.
 */
export const showSessions = async (
  window: Page,
  status: "Active" | "Archived" | "All"
): Promise<void> => {
  await window.getByTestId("session-filter-menu").click()
  // Both rows are matched by PREFIX, never exactly: the axis trigger appends the
  // current value ("Status Active") so it can state the filter while shut, and
  // each option appends its match count ("Archived 1"). An exact matcher finds
  // neither.
  await window.getByRole("menuitem", { name: /^Status/ }).click()
  await window.getByRole("menuitem", { name: new RegExp(`^${status}`) }).click()
  // Close the menu so it cannot sit over the rows the caller is about to assert on.
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("session-filter-menu")).toBeVisible()
}

/**
 * "The app shell is on screen" — the sentinel ~19 specs assert before doing
 * anything else.
 *
 * It used to be `getByText("Sessions", { exact: true })`, repeated 56 times. The
 * sidebar header then merged into one row and lost that label, and every one of
 * those specs failed at once for a reason that had nothing to do with what they
 * were testing.
 *
 * The search field is a better sentinel than a heading anyway: it is a control
 * the operator uses rather than decoration, so it is far less likely to be
 * restyled away — and if it ever is, this is one line rather than fifty-six.
 *
 * That prediction was half right. The sidebar's "Filter sessions…" field WAS
 * removed — search went global and moved to the title bar — and this being one
 * line is the only reason the whole suite did not fail with it. The sentinel is
 * now the title bar's search control, found by its accessible name rather than
 * by a placeholder: it is a button dressed as a field (it opens the command
 * palette rather than accepting text), so `getByPlaceholder` has nothing to
 * match and the label is the stabler handle regardless.
 */
export const appShell = (window: Page) =>
  window.getByRole("button", { name: "Search sessions and actions" })

/**
 * The SIDEBAR row for a session, found by its title.
 *
 * ## Why `getByText(title)` stopped working
 *
 * The tab-chrome redesign folded the Conversation tab into a chip that wears the
 * session's name. So an OPEN session's title is now on screen twice — once in the
 * sidebar row, once in its pane's header — and `getByText("Alpha session")`
 * resolves to two elements, which Playwright's strict mode treats as an error
 * rather than picking one.
 *
 * Every spec that clicked a session by its title broke at once, and the fix is not
 * "pick the first": the two elements do different jobs, and a spec that means
 * "switch to this session" wants the sidebar unambiguously.
 *
 * ## Why by title rather than by id
 *
 * `session-row-<id>` is the canonical handle and is what a spec should use when it
 * has the id to hand. This exists for the many call sites that only ever knew the
 * title — converting those to ids means threading a constant through each spec for
 * no gain, while a prefix locator filtered by text is exact enough: the prefix
 * confines it to the sidebar list, and the title picks the row.
 */
export const sessionRow = (window: Page, title: string) =>
  window.locator("[data-testid^='session-row-']").filter({ hasText: title })

/**
 * Click a session in the sidebar. The common case of {@link sessionRow}.
 *
 * `.first()` is safe HERE and not a fudge: the locator is already confined to the
 * sidebar, so more than one match means two sessions share a title — and clicking
 * either satisfies what such a spec asked for.
 */
export const openSessionByTitle = async (window: Page, title: string): Promise<void> => {
  await sessionRow(window, title).first().click()
}

/** A seeded session written to sessions.json (valid `Session` shape). */
export interface SeedSession {
  readonly id: string
  readonly repo: string
  readonly branch: string
  readonly title: string
  readonly status: "idle" | "running" | "thinking" | "needs-input" | "done"
  readonly cli: "claude" | "codex" | "cursor" | "opencode"
  readonly diff: { added: number; removed: number }
  readonly prNumber: number | null
  readonly issueNumber?: number | null
  readonly costUsd: number
  readonly tokens: number
  readonly contextTokens?: number
  readonly updatedAt: string
  readonly worktreePath?: string
  /**
   * The repo's absolute path. Distinct from `repo`, which is only the display
   * name — the two disagree exactly when the directory has been renamed since
   * the session was created, which is what `migrateRepoName` exists to fix.
   */
  readonly repoPath?: string
  readonly baseBranch?: string
  readonly model?: string
  readonly resumeId?: string
  readonly mode?: "ask" | "accept-edits" | "auto"
  readonly archived?: boolean
  readonly archiveReason?: "merged" | "closed"
  readonly archivedAt?: string
  readonly persistent?: boolean
  readonly workspaceMode?: "worktree" | "direct"
}

export interface LaunchOptions {
  /**
   * Route turns through the deterministic in-process adapter by default.
   * Set false only when a spec needs a fake harness process end to end.
   */
  readonly scriptedAgent?: boolean
  /**
   * Relaunch against an EXISTING `~/jingler` (a previous launch's `home`) —
   * i.e. a real app restart, reading whatever the last run persisted rather than
   * what the test seeded. Pass `reposDir` alongside it to keep the same repos.
   * The original launch still owns teardown for both.
   */
  readonly home?: string
  /** Reuse a previous launch's repos dir; pair with `home` for a restart. */
  readonly reposDir?: string
  /**
   * Reuse a previous launch's Chromium profile, so `localStorage` survives the
   * restart too. `home` alone restarts the app's JSON state but hands it a FRESH
   * profile — which silently resets anything stored in localStorage (panel
   * widths, dock sides, the session grid layout). Pass this alongside `home`
   * when the thing under test is one of those. The original launch still owns
   * teardown.
   */
  readonly userDataDir?: string
  /** Seed config.json so the app boots configured (past first-run). */
  readonly configured?: boolean
  /** Additional persisted workspace config for settings/routing scenarios. */
  readonly config?: Readonly<Record<string, unknown>>
  /** Create a real git repo in the seeded repos dir (for the create-session flow). */
  readonly withRepo?: boolean
  /**
   * Seed sessions.json — either a fixed list, or a function of the launch context
   * (so a session's `worktreePath` can point at the just-created repo).
   */
  readonly sessions?:
    | ReadonlyArray<SeedSession>
    | ((ctx: { reposDir: string; repoPath: string }) => ReadonlyArray<SeedSession>)
  /**
   * Seed persisted transcripts, keyed by session id → the message array written to
   * `~/jingler/transcripts/<id>.json`. Lets a test load a conversation with, e.g.,
   * an orphaned pending gate (to assert it settles on load).
   */
  readonly transcripts?: Record<string, ReadonlyArray<unknown>>
  /**
   * Seed a finished reviewer's event stream, keyed by session id → the events
   * written to `~/jingler/reviews/<id>.transcript.json`. A fresh launch with one
   * of these IS the "restored after a restart" case: the app has no live reviewer,
   * so a Reviewer tab can only come from the disk.
   */
  readonly reviewTranscripts?: Record<string, ReadonlyArray<unknown>>
  /** Seed extra fixtures (e.g. project skills) after repo creation, before launch. */
  readonly seed?: (ctx: { reposDir: string; repoPath: string }) => void
  /**
   * Whether to boot past the sign-in wall (default true). When true the fixture
   * seeds a valid token so the app lands signed in; set false to assert the wall
   * itself (auth.spec).
   */
  readonly signedIn?: boolean
  /**
   * Reuse one stateful offline auth/MCP/memory fake across several launches.
   * This is the teammate and organization-isolation boundary: accepted state
   * survives app instances, while each launch still has isolated local files.
   * The caller owns the supplied server and closes it after the scenario.
   */
  readonly authServer?: FakeAuthServer

  /**
   * Install a deterministic fake `opencode` on PATH so discovery, the version
   * gate, the model catalogue and the provider list all run offline — instead of
   * depending on whether this host happens to have opencode installed.
   */
  readonly opencode?: {
    /** What `--version` reports. Below 1.18 the version gate must reject it. */
    readonly version?: string
    /** Make storing a key fail, to drive the UI's failure path. */
    readonly authFails?: boolean
    /** Providers `/config/providers` reports, mirroring the real response. */
    readonly providers?: ReadonlyArray<{
      readonly id: string
      readonly name?: string
      /** Where the credential came from; omit for "unconfigured". */
      readonly source?: "env" | "config" | "custom" | "api"
      readonly env?: ReadonlyArray<string>
      readonly models?: ReadonlyArray<string>
    }>
  }
  /**
   * Install a deterministic fake `gh` on PATH so the GitHub flows run offline:
   * `gh` reports authenticated, `gh pr list` returns these PRs, and
   * `gh pr checkout <n>` checks out the matching head branch (pre-created in the
   * repo). Lets the "new session from a PR" flow run end-to-end against real git.
   */
  readonly gh?: {
    readonly login: string
    readonly prs?: ReadonlyArray<{
      number: number
      title: string
      headRefName: string
      baseRefName: string
      author: { login: string }
      state?: string
      isDraft?: boolean
      additions?: number
      deletions?: number
      updatedAt?: string
      /** The PR description, as `gh pr view --json body` reports it. */
      body?: string
      labels?: ReadonlyArray<{ name: string; color?: string }>
      /** `CLEAN` | `BEHIND` | `BLOCKED` | `DIRTY` — drives the merge box. */
      mergeStateStatus?: string
      /** `statusCheckRollup` entries, for the Checks rail. */
      checks?: ReadonlyArray<{
        name: string
        conclusion?: string
        status?: string
        detailsUrl?: string
      }>
    }>
    /** The unified diff served by `gh pr diff` (what an adversarial review reads). */
    readonly diff?: string
    /** Open issues served by `gh issue list` (for the "new session from an issue" flow). */
    readonly issues?: ReadonlyArray<{
      number: number
      title: string
      url?: string
      body?: string
      labels?: ReadonlyArray<{ name: string; color?: string }>
      author: { login: string }
      assignees?: ReadonlyArray<{ login: string }>
      updatedAt?: string
    }>
  }
}

/**
 * Install a fake harness in the pinned discovery dir that only answers `--version`.
 *
 * Discovery is pinned to that dir (`JINGLER_DISCOVERY_BIN_DIR`), so without this
 * the suite would find NO harness and every flow gated on one — creating a
 * session, the harness picker, the model chip — would skip. A shim is enough
 * because `JINGLER_SCRIPTED_AGENT` routes actual turns to the scripted harness:
 * the binary is only ever asked for its version.
 *
 * This is what makes those specs both hermetic AND still run. Previously they
 * depended on the developer having the real CLI installed, which meant the suite
 * tested something different on every machine — and on CI, nothing at all. The
 * provider-switch spec is the clearest case: it skipped unless you personally had
 * Codex installed, and its own comment conceded "there's no fixture for it".
 */
const installVersionOnlyHarness = (binDir: string, bin: string, version: string): void => {
  mkdirSync(binDir, { recursive: true })
  const shim = `#!/usr/bin/env node
// Discovery runs \`--version\`. Anything else (e.g. the codex app-server model
// probe) exits immediately, so the catalogue degrades to the static fallback
// list rather than hanging — deterministic either way.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("${version}\\n")
}
process.exit(0)
`
  const path = join(binDir, bin)
  writeFileSync(path, shim)
  chmodSync(path, 0o755)
}

/**
 * Install a fake `codex` that answers `--version` AND speaks enough of the
 * app-server JSON-RPC protocol to serve a model catalogue.
 *
 * A version-only shim isn't enough: the provider-switch spec picks a Codex model
 * by its displayed label, and without a catalogue the chip falls back to the
 * static list — whose ids are lowercase, so the spec's `/^GPT-5\./` finds nothing.
 * That regex was written against the REAL CLI's labels, which is precisely the
 * machine-dependence being removed here, so the fixture reproduces the real
 * response rather than the assertion being relaxed to fit a weaker fake.
 */
const installFakeCodex = (binDir: string): void => {
  mkdirSync(binDir, { recursive: true })
  const shim = `#!/usr/bin/env node
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("codex-cli 0.144.1\\n")
  process.exit(0)
}
if (!process.argv.includes("app-server")) process.exit(0)

const fs = require("node:fs")
const models = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
  { id: "gpt-5.5", displayName: "GPT-5.5" }
]
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
const notifyUsage = (tokens, turnId) =>
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-e2e",
      turnId,
      tokenUsage: {
        total: { totalTokens: tokens },
        last: { totalTokens: tokens },
        modelContextWindow: 258400
      }
    }
  })
const record = (method) => {
  if (process.env.JINGLER_E2E_CODEX_LOG) {
    fs.appendFileSync(process.env.JINGLER_E2E_CODEX_LOG, method + "\\n")
  }
}
const configOverride = (key) => {
  for (let index = 2; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] !== "-c") continue
    const entry = process.argv[index + 1]
    const prefix = key + "="
    if (!entry.startsWith(prefix)) continue
    const encoded = entry.slice(prefix.length)
    try {
      return JSON.parse(encoded)
    } catch {
      throw new Error("Invalid Codex MCP override for " + key)
    }
  }
  return undefined
}
const browserMcpTarget = (input) => {
  const prefix = "[[browser-control-mcp="
  const start = input.indexOf(prefix)
  if (start < 0) return null
  const valueStart = start + prefix.length
  const end = input.indexOf("]]", valueStart)
  if (end < 0) throw new Error("Browser MCP fixture marker is missing ]]")
  return input.slice(valueStart, end)
}
const browserMcpRequest = async (id, method, params, protocolVersion) => {
  const url = configOverride("mcp_servers.jingler-browser.url")
  const duplicateToolApproval = configOverride(
    "features.tool_call_mcp_elicitation"
  )
  const authorizationEnvironment = configOverride(
    "mcp_servers.jingler-browser.env_http_headers.Authorization"
  )
  const authorization =
    typeof authorizationEnvironment === "string"
      ? process.env[authorizationEnvironment]
      : undefined
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Codex launch is missing the jingler-browser URL override")
  }
  if (duplicateToolApproval !== false) {
    throw new Error("Codex launch still enables duplicate MCP tool approvals")
  }
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new Error("Codex launch is missing the jingler-browser Authorization environment")
  }
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: authorization,
    "Content-Type": "application/json"
  }
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error("Browser MCP " + method + " returned " + response.status + ": " + raw)
  }
  if (response.status === 202) return null
  const message = JSON.parse(raw)
  if (message.error) {
    throw new Error("Browser MCP " + method + " failed: " + message.error.message)
  }
  return message.result
}
const initializeBrowserMcp = async () => {
  const initialized = await browserMcpRequest(901, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "jingler-e2e-codex", version: "1.0.0" }
  })
  const protocolVersion = initialized?.protocolVersion
  if (typeof protocolVersion !== "string") {
    throw new Error("Browser MCP initialize did not return a protocol version")
  }
  record("browser-mcp:initialize")
  await browserMcpRequest(
    undefined,
    "notifications/initialized",
    {},
    protocolVersion
  )
  return protocolVersion
}
const navigateBrowserMcp = async (targetUrl) => {
  const protocolVersion = await initializeBrowserMcp()
  const result = await browserMcpRequest(
    903,
    "tools/call",
    { name: "navigate", arguments: { url: targetUrl } },
    protocolVersion
  )
  if (result?.isError === true) {
    const detail = JSON.stringify(result.content ?? [])
    throw new Error("Browser MCP navigate returned a tool error: " + detail)
  }
  record("browser-mcp:tools/call:navigate")
  // A real agent commonly reads immediately after navigating. Keep that exact
  // sequence in the fixture so navigate cannot report success while Chromium
  // is still exposing the previous document to the next tool call.
  const readResult = await browserMcpRequest(
    904,
    "tools/call",
    { name: "read_text", arguments: {} },
    protocolVersion
  )
  if (readResult?.isError === true) {
    throw new Error(
      "Browser MCP read_text returned a tool error: " +
        JSON.stringify(readResult.content ?? [])
    )
  }
  const text = Array.isArray(readResult?.content)
    ? readResult.content
        .filter((item) => item?.type === "text")
        .map((item) => item.text)
        .join(" ")
    : ""
  record("browser-mcp:tools/call:read_text:" + text)
}
const assertAutoTurnPolicy = (params) => {
  if (params?.approvalPolicy !== "never") {
    throw new Error("Codex Auto turn is missing approvalPolicy=never")
  }
  if (params?.sandboxPolicy?.type !== "dangerFullAccess") {
    throw new Error("Codex Auto turn is missing dangerFullAccess")
  }
  record("permissions:auto")
}
const completeBrowserMcpTurn = async (targetUrl, params) => {
  try {
    assertAutoTurnPolicy(params)
    // Leave a deterministic window for split-pane specs to move focus after
    // submitting the turn, proving a background run cannot steal the overlay.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await navigateBrowserMcp(targetUrl)
    send({
      method: "item/completed",
      params: {
        threadId: "thread-e2e",
        turnId: "turn-e2e",
        item: {
          type: "agentMessage",
          id: "message-e2e",
          text: "Codex browser MCP complete."
        }
      }
    })
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-e2e",
        turn: { id: "turn-e2e", status: "completed", error: null }
      }
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    record("browser-mcp:error:" + message)
    send({
      method: "item/completed",
      params: {
        threadId: "thread-e2e",
        turnId: "turn-e2e",
        item: {
          type: "agentMessage",
          id: "message-e2e",
          text: "Codex browser MCP failed: " + message
        }
      }
    })
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-e2e",
        turn: { id: "turn-e2e", status: "failed", error: { message } }
      }
    })
  }
}
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString()
  let index = buffer.indexOf("\\n")
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      const msg = JSON.parse(line)
      if (msg.method) record(msg.method)
      if (msg.method === "initialize") send({ id: msg.id, result: {} })
      if (msg.method === "model/list") send({ id: msg.id, result: { data: models } })
      if (msg.method === "thread/start") {
        send({ id: msg.id, result: { thread: { id: "thread-e2e" } } })
      }
      if (msg.method === "thread/resume") {
        send({ id: msg.id, result: { thread: { id: "thread-e2e" } } })
        // Deliver replay in a later stdout chunk, as the real server may. This is
        // high enough to require compaction before turn/start.
        setTimeout(() => notifyUsage(206000, "turn-previous"), 100)
      }
      if (msg.method === "thread/compact/start") {
        send({ id: msg.id, result: {} })
        setTimeout(
          () =>
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-e2e",
                turn: { id: "compact-e2e", status: "completed", error: null }
              }
            }),
          20
        )
      }
      if (msg.method === "turn/start") {
        send({ id: msg.id, result: { turn: { id: "turn-e2e" } } })
        const input = JSON.stringify(msg.params?.input ?? "")
        const isDigest = input.includes(
          "You are compacting a coding session's context"
        )
        const holdForSteer = input.includes(
          "Exercise native steering"
        )
        const browserTarget = browserMcpTarget(input)
        if (browserTarget !== null) {
          void completeBrowserMcpTurn(browserTarget, msg.params)
          index = buffer.indexOf("\\n")
          continue
        }
        const reply = isDigest
          ? '{"goal":"Continue the legacy Codex session.","recentWork":["Loaded the existing session transcript."],"nextStep":"Continue the implementation.","decisions":[],"filesTouched":[],"openThreads":["The implementation is still active."],"preferences":[],"midFlow":true,"midFlowReason":"The implementation is still active."}'
          : "Codex E2E complete."
        // Occupancy arrives after turn/start has resolved, like the real server.
        // The completion delay gives Playwright a deterministic interval to see
        // the meter and Stop while the transport remains active.
        if (!isDigest) setTimeout(() => notifyUsage(120000, "turn-e2e"), 500)
        setTimeout(
          () =>
            send({
              method: "item/completed",
              params: {
                threadId: "thread-e2e",
                turnId: "turn-e2e",
                item: {
                  type: "agentMessage",
                  id: "message-e2e",
                  text: reply
                }
              }
            }),
          isDigest ? 20 : 1000
        )
        setTimeout(
          () =>
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-e2e",
                turn: { id: "turn-e2e", status: "completed", error: null }
              }
            }),
          isDigest ? 40 : holdForSteer ? 60000 : 3000
        )
      }
      if (msg.method === "turn/steer") {
        send({ id: msg.id, result: { turnId: msg.params?.expectedTurnId } })
      }
      if (msg.method === "turn/interrupt") {
        send({ id: msg.id, result: {} })
      }
    }
    index = buffer.indexOf("\\n")
  }
})
`
  const path = join(binDir, "codex")
  writeFileSync(path, shim)
  chmodSync(path, 0o755)
}

/**
 * Install a fake `opencode` on PATH: a node shim that answers `--version` and,
 * on `serve`, boots a tiny HTTP server speaking just enough of opencode's API
 * for discovery and the model catalogue (`/config/providers`).
 *
 * Why a fake rather than the real binary: discovery probes PATH, so today's
 * model-chip tests `test.skip()` on any host without the harness installed —
 * which means the provider-switching path is untested in exactly the situation
 * that matters. A shim makes it deterministic and offline, and lets us drive the
 * cases a real install *can't* reach: a too-old version, or a provider whose key
 * is missing.
 *
 * Returns the env vars the shim reads.
 */
const installFakeOpencode = (
  binDir: string,
  opencode: NonNullable<LaunchOptions["opencode"]>
): Record<string, string> => {
  mkdirSync(binDir, { recursive: true })
  // Providers as `GET /config/providers` reports them, shaped exactly like the
  // real 1.18 response the adapter parses.
  const providers = (opencode.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    source: p.source ?? null,
    env: p.env ?? [],
    models: Object.fromEntries(
      (p.models ?? []).map((m) => [m, { id: m, name: m, providerID: p.id }])
    )
  }))

  const script = `#!/usr/bin/env node
const version = process.env.JINGLER_E2E_OPENCODE_VERSION || "1.18.0"
const providers = JSON.parse(process.env.JINGLER_E2E_OPENCODE_PROVIDERS || "[]")
const argv = process.argv.slice(2)

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(version + "\\n")
  process.exit(0)
}

if (argv[0] === "serve") {
  const http = require("node:http")
  // A provider is "connected" iff the fixture gave it a source — mirroring the
  // real server, where /config/providers returns ONLY what resolves while
  // /provider returns the whole registry plus a connected list.
  const connected = providers.filter((p) => p.source !== null).map((p) => p.id)
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json")
    if (req.url.startsWith("/provider")) {
      // The registry stamps a source on everything regardless of whether it
      // resolves — reproduced here, because the fold must ignore it and trust
      // \`connected\` instead.
      res.end(
        JSON.stringify({
          all: providers.map((p) => ({ ...p, source: "custom" })),
          connected,
          default: {}
        })
      )
      return
    }
    if (req.url.startsWith("/config/providers")) {
      const live = providers.filter((p) => connected.includes(p.id))
      // The real server also returns a per-provider default; mirroring it keeps
      // the fold under test identical to production.
      const def = {}
      for (const p of live) {
        const first = Object.keys(p.models)[0]
        if (first) def[p.id] = first
      }
      res.end(JSON.stringify({ providers: live, default: def }))
      return
    }
    if (req.method === "PUT" && req.url.startsWith("/auth/")) {
      // Record the write so a test can assert the key went to opencode's own
      // store rather than anywhere of Jingler's.
      const id = decodeURIComponent(req.url.slice("/auth/".length))
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        require("node:fs").appendFileSync(
          process.env.JINGLER_E2E_OPENCODE_AUTH_LOG,
          JSON.stringify({ id, body: JSON.parse(body || "{}") }) + "\\n"
        )
        // Refusing the write is a state a real server reaches (its credential
        // store unwritable) and the one the row itself can't show — the UI has
        // to say so rather than close as though the key landed.
        if (process.env.JINGLER_E2E_OPENCODE_AUTH_FAILS === "1") {
          res.statusCode = 500
          res.end(JSON.stringify({ error: "cannot write auth.json" }))
          return
        }
        res.end("true")
      })
      return
    }
    res.end("{}")
  })
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(
      "opencode server listening on http://127.0.0.1:" + server.address().port + "\\n"
    )
  })
  const bye = () => { server.close(); process.exit(0) }
  process.on("SIGTERM", bye)
  process.on("SIGINT", bye)
  return
}
process.exit(0)
`
  const path = join(binDir, "opencode")
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return {
    JINGLER_E2E_OPENCODE_VERSION: opencode.version ?? "1.18.0",
    JINGLER_E2E_OPENCODE_PROVIDERS: JSON.stringify(providers),
    JINGLER_E2E_OPENCODE_AUTH_LOG: join(binDir, "auth-writes.jsonl"),
    JINGLER_E2E_OPENCODE_AUTH_FAILS: opencode.authFails === true ? "1" : "0"
  }
}

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly window: Page
  /** The throwaway home; `~/jingler` lives at `<home>/jingler`. */
  readonly home: string
  /** The seeded repos directory (when `configured`). */
  readonly reposDir: string
  /**
   * This launch's Chromium profile. Pass it back as `userDataDir` on a restart
   * to carry `localStorage` across — panel widths, dock sides, the grid layout.
   */
  readonly userDataDir: string
  /** The seeded repo's path (when `withRepo`). */
  readonly repoPath: string
  /** The offline fake auth backend this launch talks to. */
  readonly authServer: FakeAuthServer
  /**
   * Keys the fake opencode was asked to store, in the order it was asked. The
   * point of the assertion is WHERE a key lands: opencode's own credential
   * store, never Jingler's SecretStore.
   */
  readonly opencodeAuthWrites: () => ReadonlyArray<{ id: string; body: { type: string; key: string } }>
  /** Ordered JSON-RPC methods received by the fake Codex app-server. */
  readonly codexCalls: () => ReadonlyArray<string>
  /**
   * Drive a `jingler://` sign-in callback into the running app (the OS would
   * normally do this after the browser flow). Emits the main-process `open-url`.
   */
  readonly completeDeepLinkSignIn: () => Promise<void>
  /**
   * The `gh pr merge|update-branch|ready` invocations the fake gh recorded, in
   * order — one raw argv line each. Lets a test assert WHICH command ran (the
   * merge strategy, say) rather than only that the button stopped spinning.
   */
  readonly ghCalls: () => ReadonlyArray<string>
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })

const initRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.email", "e2e@jingler.dev"])
  git(dir, ["config", "user.name", "Jingler E2E"])
  git(dir, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(dir, "README.md"), "# e2e repo\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init", "--no-gpg-sign"])
}

/**
 * Install a fake `gh` into `binDir` and pre-create each PR's head branch in the
 * repo, so `gh pr checkout` has a real branch to switch onto. Returns the env
 * vars the shim reads (the PR-list JSON + a number→head-ref map). The shim is a
 * tiny bash script — deterministic, offline, no real GitHub.
 */
const installFakeGh = (
  binDir: string,
  repoPath: string,
  gh: NonNullable<LaunchOptions["gh"]>
): Record<string, string> => {
  mkdirSync(binDir, { recursive: true })
  const prs = (gh.prs ?? []).map((p) => ({
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    author: p.author,
    state: p.state ?? "OPEN",
    isDraft: p.isDraft ?? false,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    updatedAt: p.updatedAt ?? "2026-07-11T00:00:00Z"
  }))
  const issues = (gh.issues ?? []).map((i) => ({
    number: i.number,
    title: i.title,
    url: i.url ?? `https://github.com/acme/widget/issues/${i.number}`,
    body: i.body ?? "",
    labels: (i.labels ?? []).map((l) => ({ name: l.name, color: l.color ?? "cccccc" })),
    author: i.author,
    assignees: i.assignees ?? [],
    updatedAt: i.updatedAt ?? "2026-07-11T00:00:00Z"
  }))
  // Per-issue `gh issue view` payloads (the Issue tab fetches these).
  for (const i of issues) {
    writeFileSync(
      join(binDir, `issue-${i.number}.json`),
      JSON.stringify({
        number: i.number,
        title: i.title,
        url: i.url,
        state: "OPEN",
        body: i.body,
        author: i.author,
        assignees: i.assignees,
        labels: i.labels,
        createdAt: i.updatedAt,
        comments: []
      })
    )
  }
  // Per-PR `gh pr view --json <PR_VIEW_FIELDS>` payloads — what the Pull Request
  // tab reads. Kept separate from the cheap `--json state` poll below, which the
  // shim answers inline.
  for (const p of gh.prs ?? []) {
    writeFileSync(
      join(binDir, `pr-${p.number}.json`),
      JSON.stringify({
        number: p.number,
        state: p.state ?? "OPEN",
        title: p.title,
        body: p.body ?? "",
        url: `https://github.com/acme/widget/pull/${p.number}`,
        headRefName: p.headRefName,
        baseRefName: p.baseRefName,
        isDraft: p.isDraft ?? false,
        author: p.author,
        createdAt: p.updatedAt ?? "2026-07-11T00:00:00Z",
        commits: [{ oid: "c1" }],
        files: [{ path: "a.ts", additions: p.additions ?? 0, deletions: p.deletions ?? 0 }],
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        labels: (p.labels ?? []).map((l) => ({ name: l.name, color: l.color ?? "cccccc" })),
        reviews: [],
        comments: [],
        reviewRequests: [],
        statusCheckRollup: (p.checks ?? []).map((c) => ({
          name: c.name,
          status: c.status ?? "COMPLETED",
          conclusion: c.conclusion ?? "SUCCESS",
          detailsUrl: c.detailsUrl ?? null,
          startedAt: "2026-07-11T00:00:00Z",
          completedAt: "2026-07-11T00:00:48Z"
        })),
        mergeable: "MERGEABLE",
        mergeStateStatus: p.mergeStateStatus ?? "CLEAN"
      })
    )
  }
  // Pre-create the head branches off main so `gh pr checkout` can land on them.
  for (const p of prs) {
    if (repoPath) git(repoPath, ["branch", p.headRefName, "main"])
  }
  const heads = prs.map((p) => `${p.number}:${p.headRefName}`).join(",")
  const states = prs.map((p) => `${p.number}:${p.state}`).join(",")
  const script = `#!/usr/bin/env bash
case "$1" in
  --version) echo "gh version 2.60.0 (2026-01-01)"; exit 0;;
esac
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "github.com" 1>&2
  echo "  ✓ Logged in to github.com account ${gh.login} (keyring)" 1>&2
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s' "$JINGLER_E2E_GH_PRS"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  # The adversarial-review de-dupe reads the head SHA on its own cadence, as a
  # single-field query — answer that separately from the state read above.
  case "$*" in
    *headRefOid*) printf '{"headRefOid":"e2ehead%s"}' "$3"; exit 0;;
    # statusCheckRollup appears only in the Pull Request tab's full field list,
    # never in the cheap state poll — so it's the marker for "serve the whole PR".
    *statusCheckRollup*) cat "$JINGLER_E2E_GH_DIR/pr-$3.json" 2>/dev/null || echo '{}'; exit 0;;
  esac
  st=$(printf '%s' "$JINGLER_E2E_GH_STATES" | tr ',' '\\n' | awk -F: -v n="$3" '$1==n{print $2}')
  [ -z "$st" ] && st="OPEN"
  printf '{"state":"%s"}' "$st"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  printf '%s' "$JINGLER_E2E_GH_DIFF"; exit 0
fi
# Record write commands so a test can assert WHICH one ran (e.g. the merge
# strategy). Appended, one invocation per line, to $JINGLER_E2E_GH_LOG.
if [ "$1" = "pr" ] && { [ "$2" = "merge" ] || [ "$2" = "update-branch" ] || [ "$2" = "ready" ]; }; then
  printf '%s\\n' "$*" >> "$JINGLER_E2E_GH_LOG"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checkout" ]; then
  ref=$(printf '%s' "$JINGLER_E2E_GH_HEADS" | tr ',' '\\n' | awk -F: -v n="$3" '$1==n{print $2}')
  git checkout "$ref" >/dev/null 2>&1; exit $?
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s' "$JINGLER_E2E_GH_ISSUES"; exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  cat "$JINGLER_E2E_GH_DIR/issue-$3.json" 2>/dev/null || echo '{}'; exit 0
fi
if [ "$1" = "issue" ]; then
  exit 0
fi
exit 0
`
  const ghPath = join(binDir, "gh")
  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)
  return {
    // A reviewer refuses to run on an empty diff (that would cache a false
    // all-clear), so `gh pr diff` has to return something real.
    JINGLER_E2E_GH_DIFF:
      gh.diff ??
      "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n const a = 1\n+const token = refresh()\n",
    JINGLER_E2E_GH_PRS: JSON.stringify(prs),
    JINGLER_E2E_GH_ISSUES: JSON.stringify(issues),
    JINGLER_E2E_GH_DIR: binDir,
    JINGLER_E2E_GH_HEADS: heads,
    JINGLER_E2E_GH_STATES: states,
    JINGLER_E2E_GH_LOG: join(binDir, "gh-calls.log")
  }
}

export const test = base.extend<{ launchApp: (options?: LaunchOptions) => Promise<LaunchedApp> }>({
  // The first argument is Playwright's fixture bag, which this fixture uses none
  // of — but it has to be there for `use` to be the second parameter.
  // biome-ignore lint/correctness/noEmptyPattern: required by Playwright's signature
  launchApp: async ({}, use) => {
    const cleanups: Array<() => void> = []
    const apps: ElectronApplication[] = []

    const launch = async (options: LaunchOptions = {}): Promise<LaunchedApp> => {
      // Reusing a previous launch's `home`/`reposDir` is what makes a REAL
      // restart testable: the second launch reads the state the first one wrote,
      // rather than state the test seeded. Without it, "survives a restart" can
      // only ever assert that seeded fixtures render. Skip re-registering
      // cleanups so the first launch's teardown isn't run twice.
      const reused = options.home !== undefined
      const home = options.home ?? mkdtempSync(join(tmpdir(), "jingler-e2e-home-"))
      const jinglerDir = join(home, "jingler")
      const reposDir = options.reposDir ?? mkdtempSync(join(tmpdir(), "jingler-e2e-repos-"))
      if (!reused) {
        cleanups.push(() => rmSync(home, { recursive: true, force: true }))
        cleanups.push(() => rmSync(reposDir, { recursive: true, force: true }))
      }

      let repoPath = ""
      if (options.withRepo) {
        repoPath = join(reposDir, "widget")
        // A reused home already has its repo; re-initialising would wipe it.
        if (!existsSync(repoPath)) initRepo(repoPath)
      }

      /**
       * Seed config.json — but NEVER over a reused home's existing one.
       *
       * A restart (`home` + `configured`) is supposed to read what the previous
       * launch persisted. Re-seeding threw that away silently: settings the app
       * wrote (a per-harness MCP opt-out, say) vanished, and the spec read the
       * absence as "it didn't persist" rather than "the fixture deleted it".
       */
      const configPath = join(jinglerDir, "config.json")
      if (options.configured && !(reused && existsSync(configPath))) {
        mkdirSync(jinglerDir, { recursive: true })
        writeFileSync(
          configPath,
          JSON.stringify(
            {
              reposDir,
              createdAt: "2026-07-11T00:00:00.000Z",
              ...options.config
            },
            null,
            2
          )
        )
      }
      if (options.sessions) {
        const sessions =
          typeof options.sessions === "function"
            ? options.sessions({ reposDir, repoPath })
            : options.sessions
        mkdirSync(jinglerDir, { recursive: true })
        writeFileSync(join(jinglerDir, "sessions.json"), JSON.stringify(sessions, null, 2))
      }
      if (options.transcripts) {
        const dir = join(jinglerDir, "transcripts")
        mkdirSync(dir, { recursive: true })
        for (const [sessionId, messages] of Object.entries(options.transcripts)) {
          writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(messages, null, 2))
        }
      }
      if (options.reviewTranscripts) {
        const dir = join(jinglerDir, "reviews")
        mkdirSync(dir, { recursive: true })
        for (const [sessionId, events] of Object.entries(options.reviewTranscripts)) {
          writeFileSync(join(dir, `${sessionId}.transcript.json`), JSON.stringify(events))
        }
      }

      // Seed extra fixtures (e.g. project skills) before launch, so they exist
      // when the app first scans them.
      options.seed?.({ reposDir, repoPath })

      // A fake harness home for EVERY launch. Anything that reads the harness's own
      // config — now just the subscription-auth check behind the billing panel —
      // otherwise reads the developer's real `~` and reports whatever they happen to
      // be signed into, so the same test says different things on different machines.
      const mcpEnv: Record<string, string> = {
        JINGLER_HARNESS_HOME: join(home, "harness-home")
      }

      // Optional fake `gh` / `opencode` on PATH (offline + deterministic). Both
      // land in the same bin dir, which is prefixed onto PATH so the shims win
      // over any real install on this host — that's what makes these tests say
      // the same thing on every machine.
      let ghEnv: Record<string, string> = {}
      let opencodeEnv: Record<string, string> = {}
      let pathPrefix = ""
      const binDir = join(home, "bin")
      if (options.gh) {
        ghEnv = installFakeGh(binDir, repoPath, options.gh)
        pathPrefix = `${binDir}:`
      }
      if (options.opencode) {
        opencodeEnv = installFakeOpencode(binDir, options.opencode)
        pathPrefix = `${binDir}:`
      }

      /**
       * Harness discovery is PINNED to this dir, so the suite can never find the
       * developer's real `claude`/`opencode`. That matters for more than speed:
       * `withOpencodeServer` inherits the environment untouched (the BYOK
       * contract), so an unpinned run boots the developer's own opencode against
       * their own credentials — and spawns one per launch.
       *
       * A fake `claude` always goes in, because pinning an EMPTY dir would make
       * every harness-gated flow (create-session, harness picker, model chip)
       * silently skip. Specs that want opencode install their own shim above.
       */
      installVersionOnlyHarness(binDir, "claude", "2.0.0 (Claude Code)")
      installFakeCodex(binDir)
      pathPrefix = `${binDir}:`

      // Offline auth backend. Signed-in by default: seed the token file that the
      // e2e plaintext SecretStore reads, so the app boots past the wall.
      const authServer = options.authServer ?? await startFakeAuthServer()
      if (options.authServer === undefined) {
        cleanups.push(() => {
          authServer.close().catch(() => {})
        })
      }
      const signedIn = options.signedIn ?? true
      if (signedIn) {
        mkdirSync(jinglerDir, { recursive: true })
        writeFileSync(join(jinglerDir, "auth.enc"), authServer.token)
      }

      // A throwaway Chromium profile per launch. `JINGLER_HOME` isolates the
      // app's own JSON state, but NOT `localStorage` — which lives in Electron's
      // userData dir and backs the renderer's UI chrome prefs (browser-preview
      // visibility + dock side, panel widths). Without this the default profile is
      // shared by every test AND every run, so `previews.spec.ts` opening the
      // preview leaked into later tests forever: at the 1320px default window the
      // extra rail squeezed the Plan Review step spec to zero width, and its
      // assertions failed on an element that was rendered but had no box.
      const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), "jingler-e2e-userdata-"))
      // Only the launch that CREATED the profile tears it down, or a restart
      // would delete the directory its predecessor is still cleaning up.
      if (!options.userDataDir) {
        cleanups.push(() => rmSync(userDataDir, { recursive: true, force: true }))
      }

      const app = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          ...ghEnv,
          ...opencodeEnv,
          ...mcpEnv,
          PATH: `${pathPrefix}${process.env.PATH ?? ""}`,
          JINGLER_HOME: home,
          // Pin harness discovery to the fixture's own bin dir. PATH alone can't
          // do this: `CLI_SPECS.candidates` hardcodes absolute install paths
          // (/opt/homebrew/bin/opencode), so a real install would still be found.
          JINGLER_DISCOVERY_BIN_DIR: binDir,
          // The Anthropic model catalogue is a live HTTP call whenever this is
          // set. Blank it so the suite falls back to the static list instead of
          // hitting the network with the developer's key.
          ANTHROPIC_API_KEY: "",
          ELECTRON_RENDERER_URL: "",
          // Auth: talk to the offline fake backend, and store the token as a plain
          // file (no OS keychain prompts under headless Playwright).
          JINGLER_AUTH_URL: authServer.url,
          JINGLER_SECRET_STORE: "memory",
          // Force the deterministic scripted agent so chat e2e never spawns a
          // real harness (no auth, no network, reproducible).
          JINGLER_SCRIPTED_AGENT: options.scriptedAgent === false ? "0" : "1",
          JINGLER_E2E_CODEX_LOG: join(binDir, "codex-calls.log"),
          // Keep the window hidden and off the dock. The suite launches a real
          // Electron app dozens of times, and a visible window steals focus on
          // every launch — which makes running the suite locally (its only home;
          // it's not in CI) incompatible with using the machine at the same time.
          // Set JINGLER_E2E_HEADED=1 to watch a run instead.
          JINGLER_E2E_HEADLESS: process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1"
        }
      })
      apps.push(app)
      const window = await app.firstWindow()
      await window.waitForLoadState("domcontentloaded")

      const completeDeepLinkSignIn = async () => {
        await app.evaluate(
          ({ app: electronApp }, url) => {
            electronApp.emit("open-url", { preventDefault() {} }, url)
          },
          `jingler://auth/callback?token=${authServer.token}`
        )
      }

      const opencodeAuthWrites = () => {
        const log = join(home, "bin", "auth-writes.jsonl")
        if (!existsSync(log)) return []
        return readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as { id: string; body: { type: string; key: string } })
      }

      const ghCalls = () => {
        const log = join(home, "bin", "gh-calls.log")
        if (!existsSync(log)) return []
        return readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0)
      }

      const codexCalls = () => {
        const log = join(home, "bin", "codex-calls.log")
        if (!existsSync(log)) return []
        return readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0)
      }

      return {
        app,
        window,
        home,
        reposDir,
        userDataDir,
        repoPath,
        authServer,
        completeDeepLinkSignIn,
        opencodeAuthWrites,
        codexCalls,
        ghCalls
      }
    }

    await use(launch)

    for (const app of apps) await app.close().catch(() => {})
    for (const cleanup of cleanups) cleanup()
  }
})

export { expect } from "@playwright/test"
