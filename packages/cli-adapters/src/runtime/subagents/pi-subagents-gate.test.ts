import { dirname, join } from "node:path"
import { createJiti } from "jiti"
import { describe, expect, it } from "vitest"
import { PI_SUBAGENTS_EXTENSION_PATH } from "./pi-subagents-bootstrap.js"

/**
 * Pins the Jingler-added hunk in `patches/pi-subagents@0.49.0.patch`: a
 * caller-supplied workflowScript wrapping exactly ONE child is rejected with a
 * corrective error steering the model to `{ agent, task }`. A workflow run has
 * no transcript of its own, so a single-child workflow hides its output from
 * the operator. If the patch is dropped on a version bump, this fails loudly.
 */
interface PublicExecutionModule {
  readonly normalizePublicSubagentExecution: <T extends Record<string, unknown>>(
    params: T
  ) => { ok: true; params: T } | { ok: false; error: string; mode: string }
  readonly isSingleChildWorkflowScript: (script: string) => boolean
}

interface ToolDescriptionModule {
  readonly FULL_SUBAGENT_TOOL_DESCRIPTION: string
  readonly COMPACT_SUBAGENT_TOOL_DESCRIPTION: string
}

const jiti = createJiti(import.meta.url)
const extensionSource = (file: string): string =>
  join(dirname(PI_SUBAGENTS_EXTENSION_PATH), "src", "extension", file)
const loadModule = (): Promise<PublicExecutionModule> =>
  jiti.import<PublicExecutionModule>(extensionSource("public-execution.ts"))
const loadToolDescription = (): Promise<ToolDescriptionModule> =>
  jiti.import<ToolDescriptionModule>(extensionSource("tool-description.ts"))

describe("patched pi-subagents single-child workflow gate", () => {
  it("rejects a workflowScript that wraps exactly one child", async () => {
    const { normalizePublicSubagentExecution } = await loadModule()
    const result = normalizePublicSubagentExecution({
      workflowScript: "return runs.run('review', { agent: 'reviewer', task: 'Review PR #12' })"
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("{ agent, task }")
      expect(result.mode).toBe("workflow")
    }
  })

  it("passes genuine multi-child orchestration through untouched", async () => {
    const { normalizePublicSubagentExecution } = await loadModule()
    const scripts = [
      // two explicit children
      "const a = runs.run('scout', { agent: 'scout', task: 'map' }); const b = runs.run('worker', { agent: 'worker', task: 'fix' }); return [a, b]",
      // fan-out via runs.all
      "return runs.all([{ agent: 'reviewer', task: 'a' }, { agent: 'reviewer', task: 'b' }])",
      // a loop that spawns per item — one call SITE, many children
      "for (const file of ['a.ts', 'b.ts']) { runs.run(file, { agent: 'worker', task: file }) } return 'started'",
      // resuming one retained child is only expressible as a runs.run item
      "return runs.run('r1', { resume: 'run-123', task: 'address review feedback' })"
    ]
    for (const workflowScript of scripts) {
      expect(normalizePublicSubagentExecution({ workflowScript })).toMatchObject({ ok: true })
    }
  })

  it("keeps structured single-child options on the direct executor path", async () => {
    const { normalizePublicSubagentExecution } = await loadModule()
    const childOptions = {
      task: "Review PR #12",
      async: false,
      context: "fork",
      model: "anthropic/claude-test",
      cwd: "/tmp/project",
      worktree: true,
      timeoutMs: 1_234,
      output: "review.md",
      toolBudget: { hard: 12 },
      acceptance: "checked"
    }
    const result = normalizePublicSubagentExecution({
      agent: " reviewer ",
      ...childOptions
    })
    expect(result).toEqual({
      ok: true,
      params: { agent: "reviewer", ...childOptions }
    })
    if (result.ok) expect(result.params).not.toHaveProperty("workflowScript")
  })

  it("advertises a direct single child and real multi-child workflows", async () => {
    const descriptions = await loadToolDescription()
    for (const description of [
      descriptions.FULL_SUBAGENT_TOOL_DESCRIPTION,
      descriptions.COMPACT_SUBAGENT_TOOL_DESCRIPTION
    ]) {
      expect(description).toContain("one direct child with its own transcript and controls")
      expect(description).toContain("two or more named children with distinct tasks")
      expect(description).not.toContain("through the workflow runtime")
    }
  })

  it("classifies scripts conservatively", async () => {
    const { isSingleChildWorkflowScript } = await loadModule()
    expect(isSingleChildWorkflowScript("return runs.run('x', { agent: 'worker' })")).toBe(true)
    expect(isSingleChildWorkflowScript("return runs.all([{ agent: 'worker' }])")).toBe(false)
    expect(isSingleChildWorkflowScript("return emit('no children at all')")).toBe(false)
    expect(
      isSingleChildWorkflowScript("items.map((i) => runs.run(i, { agent: 'worker', task: i }))")
    ).toBe(false)
  })
})
