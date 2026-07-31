import { describe, expect, it } from "vitest"
import { parsePlanHtml, type WorkerRoutingConfig } from "@jingler/core"
import {
  fencedHtmlPlan,
  hasPlanBlock,
  hasOrchestratorPlanSubmission,
  parseFlow,
  parsePlan,
  parseStepCode,
  parseStepFlows,
  planModeInstructions,
  stripHtmlPlanBlock
} from "./plan-parse.js"

/**
 * `parsePlan` turns the free-form plan text Claude emits via ExitPlanMode into a
 * structured Plan. We assert the outcomes an operator sees: steps in order,
 * branches nested under their parent, files/guards/deps parsed, the decision-flow
 * graph, and a never-lose-the-plan fallback for garbled input.
 */

const FLOW = `\`\`\`flow
start n0 "HTTP request"
action n1 "authMiddleware" file src/auth/session.ts
decision n2 "token expired?"
action n3 "refresh() + retry" step 4a
action n4 "proceed" step 4b
terminal n5 "response"
n0 -> n1
n1 -> n2
n2 -> n3 : yes
n2 -> n4 : no
n3 -> n5
n4 -> n5
n9 -> n5
\`\`\``

const STRUCTURED = `\`\`\`plan
summary: Refactor auth flow
01 Audit session middleware
  intent: Understand how sessions read tokens today
  approach: Read session.ts; Trace the token path
02 Create TokenStore module
  files: A src/auth/token-store.ts +40
03 Swap MemoryStore to TokenStore
  files: M src/auth/session.ts +8 -3
04 Handle token refresh
  branch: token expired?
  4a refresh() + retry on 401
    intent: Mint a new token and replay once
    files: M src/auth/refresh.ts +18; A src/auth/retry.ts +15
    guards: New token written before replay; No refresh loop (warn)
    depends: 03
    blocks: 05
  4b Proceed with request
    intent: Token still valid — carry on
05 Update auth tests
06 Open PR #482
\`\`\`

Here's the human-readable version: I'll refactor the auth flow…`

const ROUTING: WorkerRoutingConfig = {
  default: { cli: "codex", model: "gpt-5" },
  low: { cli: "codex", model: "gpt-5" },
  medium: { cli: "codex", model: "gpt-5" },
  high: { cli: "claude", model: "opus" }
}

describe("parsePlan — structured block", () => {
  const plan = parsePlan(STRUCTURED, "plan_1")

  it("reads the summary and every step in order", () => {
    expect(plan.summary).toBe("Refactor auth flow")
    expect(plan.steps.map((s) => s.number)).toStrictEqual(["01", "02", "03", "04", "4a", "4b", "05", "06"])
    expect(plan.status).toBe("proposed")
    expect(plan.raw).toBe(STRUCTURED)
  })

  it("nests branch arms under the branch parent", () => {
    const branch = plan.steps.find((s) => s.number === "04")!
    expect(branch.kind).toBe("branch")
    expect(branch.condition).toBe("token expired?")
    const arm = plan.steps.find((s) => s.number === "4a")!
    expect(arm.kind).toBe("branch-arm")
    expect(arm.parentId).toBe(branch.id)
  })

  it("parses files (with a summed diff), guards, intent, approach and deps", () => {
    const arm = plan.steps.find((s) => s.number === "4a")!
    expect(arm.intent).toBe("Mint a new token and replay once")
    expect(arm.files).toStrictEqual([
      { path: "src/auth/refresh.ts", change: "M", added: 18, removed: 0 },
      { path: "src/auth/retry.ts", change: "A", added: 15, removed: 0 }
    ])
    expect(arm.diff).toStrictEqual({ added: 33, removed: 0 })
    expect(arm.guards).toStrictEqual([
      { text: "New token written before replay", status: "ok" },
      { text: "No refresh loop", status: "warn" }
    ])
    expect(arm.dependsOn).toStrictEqual(["03"])
    expect(arm.blocks).toStrictEqual(["05"])

    const audit = plan.steps.find((s) => s.number === "01")!
    expect(audit.approach).toStrictEqual(["Read session.ts", "Trace the token path"])
  })

  it("attaches the decision-flow graph from the ```flow block", () => {
    const withFlow = parsePlan(STRUCTURED + "\n" + FLOW, "plan_2")
    const graph = withFlow.graph
    expect(graph).not.toBeNull()
    expect(graph!.nodes.map((n) => n.kind)).toStrictEqual([
      "start",
      "action",
      "decision",
      "action",
      "action",
      "terminal"
    ])
    // The decision's out-edges carry the yes/no conditions.
    const decision = graph!.edges.filter((e) => e.from === "n2")
    expect(decision.map((e) => e.label)).toStrictEqual(["yes", "no"])
    // Node detail (file) + step link are parsed.
    const mw = graph!.nodes.find((n) => n.id === "n1")!
    expect(mw.detail).toBe("src/auth/session.ts")
    expect(graph!.nodes.find((n) => n.id === "n3")!.stepId).toBe("s_4a")
  })

  it("drops dangling edges that reference an undeclared node", () => {
    const graph = parseFlow(FLOW)!
    // `n9 -> n5` referenced n9 which was never declared → dropped.
    expect(graph.edges.some((e) => e.from === "n9")).toBe(false)
  })

  it("has no graph when the agent gave no ```flow block", () => {
    expect(parsePlan(STRUCTURED, "plan_3").graph).toBeNull()
  })
})

describe("parsePlan — fallback", () => {
  it("wraps unparseable markdown in a single step and keeps the raw text", () => {
    const raw = "# Ship the widget\n\n1. do a thing\n2. do another"
    const plan = parsePlan(raw, "plan_x")
    expect(plan.steps).toHaveLength(1)
    expect(plan.summary).toBe("Ship the widget")
    expect(plan.steps[0]!.title).toBe("Ship the widget")
    expect(plan.raw).toBe(raw)
    expect(plan.graph).toBeNull()
  })
})

describe("parseFlow", () => {
  it("returns null when there's no flow block", () => {
    expect(parseFlow("just some text")).toBeNull()
  })
})

describe("parseStepFlows — per-step flows", () => {
  const STEP_FLOW = `\`\`\`plan
summary: Refactor auth flow
01 Audit session middleware
03 Swap MemoryStore to TokenStore
04 Handle token refresh
\`\`\`

\`\`\`flow step 04
start n0 "request"
decision n1 "token expired?"
action n2 "refresh() + retry"
action n3 "proceed"
terminal n4 "response"
n0 -> n1
n1 -> n2 : yes
n1 -> n3 : no
n2 -> n4
n3 -> n4
\`\`\``

  it("keys each ```flow step NN``` block by its normalized step number", () => {
    const map = parseStepFlows(STEP_FLOW)
    expect([...map.keys()]).toStrictEqual(["04"])
    expect(map.get("04")!.nodes.map((n) => n.kind)).toStrictEqual([
      "start",
      "decision",
      "action",
      "action",
      "terminal"
    ])
  })

  it("attaches the flow onto the matching step (and leaves other steps without one)", () => {
    const plan = parsePlan(STEP_FLOW, "plan_f")
    expect(plan.steps.find((s) => s.number === "04")?.graph).not.toBeNull()
    expect(plan.steps.find((s) => s.number === "04")?.graph?.nodes.length).toBe(5)
    expect(plan.steps.find((s) => s.number === "01")?.graph ?? null).toBeNull()
  })

  it("does not treat a ```flow step NN``` block as a legacy plan-level flow or a code sample", () => {
    expect(parsePlan(STEP_FLOW, "plan_f").graph).toBeNull()
    expect(parseStepCode(STEP_FLOW).size).toBe(0)
  })
})

describe("parseStepCode", () => {
  const RAW = `\`\`\`plan
summary: x
02 Create TokenStore
\`\`\`

\`\`\`ts step 02
export class TokenStore {}
\`\`\`

\`\`\`step 3
const x = 1
\`\`\``

  it("links a fenced code block to its step by the `step NN` info string, capturing the language", () => {
    const map = parseStepCode(RAW)
    expect(map.get("02")).toStrictEqual({ lang: "ts", body: "export class TokenStore {}" })
  })

  it("normalizes the step number and treats a leading `step` token as no language", () => {
    const map = parseStepCode(RAW)
    expect(map.get("03")).toStrictEqual({ lang: null, body: "const x = 1" })
  })

  it("ignores plain code blocks with no step link (and the plan/flow blocks)", () => {
    expect(parseStepCode("```ts\nconst a = 1\n```").size).toBe(0)
  })

  it("attaches the sample onto the matching PlanStep in parsePlan", () => {
    const plan = parsePlan(RAW, "plan_1")
    expect(plan.steps.find((s) => s.number === "02")?.code).toStrictEqual({
      lang: "ts",
      body: "export class TokenStore {}"
    })
  })
})

describe("hasPlanBlock", () => {
  it("detects the fence, with or without an info string", () => {
    expect(hasPlanBlock("```plan\nsummary: x\n01 Step\n```")).toBe(true)
    expect(hasPlanBlock("prose first\n\n```plan\nsummary: x\n```\n\nmore prose")).toBe(true)
  })

  it("ignores a fence whose info string merely STARTS with 'plan'", () => {
    // A prefix match would parse ```planning as the plan spec and skip the
    // reformat bounce. (```plaintext is safe either way — it's "plai", not "plan".)
    expect(hasPlanBlock("```planning\nsummary: x\n```")).toBe(false)
    expect(hasPlanBlock("```plaintext\nsome output\n```")).toBe(false)
    // A trailing space after the language is still a plan block.
    expect(hasPlanBlock("```plan \nsummary: x\n```")).toBe(true)
  })

  it("is false for a plan that skipped the fence", () => {
    expect(hasPlanBlock("## My plan\n\n1. Do a thing\n2. Do another")).toBe(false)
    // A plan carrying OTHER fences but not `plan` still counts as non-compliant.
    expect(hasPlanBlock("```ts\nconst x = 1\n```")).toBe(false)
    expect(hasPlanBlock("")).toBe(false)
  })

  it("keeps nested code fences inside a four-backtick HTML plan", () => {
    const raw = [
      "````html",
      "<h1>PRD: Nested sample</h1>",
      "<h2>Context</h2><p>Keep examples intact.</p>",
      '<section data-stage="s1" data-title="Build parser">',
      "<h3>Intent</h3><p>Keep examples intact</p>",
      "<pre>```ts\nconst fence = \"nested\"\n```</pre>",
      '<div data-acceptance="a1" data-status="pending">The full stage survives.</div>',
      "</section>",
      "````"
    ].join("\n")

    expect(hasPlanBlock(raw)).toBe(true)
    const plan = parsePlan(raw, "plan_nested")
    expect(plan.structured).toBe(true)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.guards.map((guard) => guard.text)).toStrictEqual([
      "The full stage survives."
    ])
  })

  it("rejects ordinary triple-backtick HTML even when the example resembles a plan", () => {
    const ordinaryExample = [
      "```html",
      "<h1>PRD: Example only</h1>",
      '<section data-stage="01" data-title="Do not submit">',
      '<div data-acceptance="01.1" data-status="pending">This is only documentation.</div>',
      "</section>",
      "```"
    ].join("\n")

    expect(hasPlanBlock(ordinaryExample)).toBe(false)
    expect(parsePlan(ordinaryExample, "plan_example").structured).toBe(false)
  })

  it("ignores later invalid HTML examples and selects the first valid PRD submission", () => {
    const valid = [
      "````html",
      "<h1>PRD: Submitted plan</h1>",
      '<section data-stage="01" data-title="Implement">',
      '<div data-acceptance="01.1" data-status="pending">The implementation works.</div>',
      "</section>",
      "````"
    ].join("\n")
    const laterExample = [
      "````html",
      "<div>Useful HTML example, not a complete PRD.</div>",
      "````"
    ].join("\n")

    const raw = `${valid}\n\nHuman-readable notes:\n\n${laterExample}`
    expect(fencedHtmlPlan(raw)).toContain("PRD: Submitted plan")
    expect(parsePlan(raw, "plan_first_valid").summary).toBe("Submitted plan")
  })

  it("treats nested triple-backtick HTML as plan content and strips only the outer transport", () => {
    const raw = [
      "Before the plan.",
      "",
      "````html",
      "<h1>PRD: Nested HTML</h1>",
      '<section data-stage="01" data-title="Preserve examples">',
      "<pre>```html",
      '<section data-stage="example" data-title="Example only">',
      '<div data-acceptance="example.1" data-status="pending">Nested sample.</div>',
      "</section>",
      "```</pre>",
      '<div data-acceptance="01.1" data-status="pending">The outer plan survives.</div>',
      "</section>",
      "````",
      "",
      "After the plan."
    ].join("\n")

    expect(parsePlan(raw, "plan_nested_html").summary).toBe("Nested HTML")
    expect(stripHtmlPlanBlock(raw)).toBe("Before the plan.\n\nAfter the plan.")
  })

  it("strips only the selected plan transport and preserves later HTML fences", () => {
    const selected = [
      "````html",
      "<h1>PRD: Selected</h1>",
      '<section data-stage="01" data-title="Selected stage">',
      '<div data-acceptance="01.1" data-status="pending">Selected criterion.</div>',
      "</section>",
      "````"
    ].join("\n")
    const usefulExample = [
      "````html",
      "<h1>PRD: Documentation example</h1>",
      '<section data-stage="example" data-title="Example stage">',
      '<div data-acceptance="example.1" data-status="pending">Example criterion.</div>',
      "</section>",
      "````"
    ].join("\n")
    const raw = `${selected}\n\nKeep this example:\n\n${usefulExample}`

    const stripped = stripHtmlPlanBlock(raw)
    expect(stripped).toContain("Keep this example:")
    expect(stripped).toContain("PRD: Documentation example")
    expect(stripped).not.toContain("PRD: Selected")
  })

  it("accepts the canonical html fence and the legacy html plan fence", () => {
    const html = [
      "<h1>PRD: Canonical HTML</h1>",
      '<section data-stage="01" data-title="Parse it">',
      "<h3>Intent</h3><p>Render the plan.</p>",
      '<div data-acceptance="01.1" data-status="pending">The stage renders.</div>',
      "</section>"
    ].join("\n")

    for (const opening of ["````html", "````html plan"]) {
      const raw = `${opening}\n${html}\n\`\`\`\``
      expect(hasPlanBlock(raw)).toBe(true)
      expect(parsePlan(raw, `plan_${opening.length}`).structured).toBe(true)
    }
  })

  it("uses the newest complete HTML plan after a reformat attempt", () => {
    const invalid = [
      "````html",
      "<h1>PRD: Incomplete</h1>",
      "<p>No stage yet.</p>",
      "````"
    ].join("\n")
    const valid = [
      "````html",
      "<h1>PRD: Corrected</h1>",
      '<section data-stage="01" data-title="Correct">',
      "<h3>Intent</h3><p>Use the corrected submission.</p>",
      '<div data-acceptance="01.1" data-status="pending">The correction wins.</div>',
      "</section>",
      "````"
    ].join("\n")
    const raw = `${invalid}\n\nReformatted:\n\n${valid}`

    expect(fencedHtmlPlan(raw)).toContain("PRD: Corrected")
    expect(parsePlan(raw, "plan_corrected").summary).toBe("Corrected")
  })

  it("compiles assignment-free orchestrator HTML before accepting it", () => {
    const raw = [
      "````html",
      "<h1>PRD: Signals pricing</h1>",
      '<section data-stage="05" data-title="Pricing" data-complexity="high">',
      '<ul data-files><li>src/pricing.ts</li></ul>',
      '<div data-acceptance="05.1" data-status="pending">Pricing works.</div>',
      "</section>",
      '<section data-stage="06" data-title="Packaging" data-complexity="high">',
      '<ul data-files><li>src/packaging.ts</li></ul>',
      '<div data-acceptance="06.1" data-status="pending">Packaging works.</div>',
      "</section>",
      "````"
    ].join("\n")

    const plan = parsePlan(raw, "plan_routed", ROUTING)
    expect(plan.structured).toBe(true)
    expect(plan.summary).toBe("Signals pricing")
    expect(plan.raw).not.toContain("````")

    const parsed = parsePlanHtml(plan.raw)
    expect(parsed.valid).toBe(true)
    expect(
      parsed.projection?.stages.map((stage) => stage.assignment?.agentId)
    ).toStrictEqual(["agent-01", "agent-02"])
  })
})

describe("hasOrchestratorPlanSubmission", () => {
  const plan = [
    "<!-- jingler:submit-plan -->",
    "````html",
    "<h1>PRD: Ship</h1>",
    '<section data-stage="01" data-title="Ship"><div data-acceptance="01.1" data-status="pending">works</div></section>',
    "````"
  ].join("\n")

  it("recognises a deliberately marked structured submission", () => {
    expect(hasOrchestratorPlanSubmission(plan)).toBe(true)
  })

  it("does not infer submission intent from an unmarked plan fence", () => {
    expect(hasOrchestratorPlanSubmission(plan.replace("<!-- jingler:submit-plan -->\n", ""))).toBe(
      false
    )
  })

  it("recognises a marked but structurally malformed plan for reformatting", () => {
    expect(
      hasOrchestratorPlanSubmission(
        "<!-- jingler:submit-plan -->\n````html\n<h1>Incomplete</h1>\n````"
      )
    ).toBe(true)
  })

  it("does not treat a quoted marker and plan as a submission", () => {
    expect(hasOrchestratorPlanSubmission(`Here is the format to quote:\n\n${plan}`)).toBe(false)
  })
})

describe("parsePlan — the unstructured fallback", () => {
  const RAW_UNSTRUCTURED = "# Refactor auth\n\nFirst I'll extract the adapter, then migrate."

  it("flags the plan as unstructured and PRESERVES the raw markdown", () => {
    const plan = parsePlan(RAW_UNSTRUCTURED, "plan_1")
    // `raw` is the only surviving copy of the agent's work — the UI renders it.
    expect(plan.structured).toBe(false)
    expect(plan.raw).toBe(RAW_UNSTRUCTURED)
    expect(plan.summary).toBe("Refactor auth")
    expect(plan.steps).toHaveLength(1)
  })

  it("marks a properly fenced plan as structured", () => {
    const plan = parsePlan("```plan\nsummary: Do it\n01 First step\n  intent: because\n```", "plan_1")
    expect(plan.structured).toBe(true)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.title).toBe("First step")
  })
})

describe("planModeInstructions", () => {
  it("documents safe PRD HTML and forbids execution", () => {
    expect(planModeInstructions()).toContain("````html")
    expect(planModeInstructions()).not.toContain("````html plan")
    expect(planModeInstructions()).toContain("data-acceptance")
    expect(planModeInstructions()).toMatch(/ExitPlanMode/)
    expect(planModeInstructions().toLowerCase()).toContain("do not edit")
    expect(planModeInstructions()).toContain(
      "PLAN_RESULT criterion=<id> status=<passed|failed>"
    )
  })

  it("injects the configured source structure", () => {
    expect(planModeInstructions("# PRD: Custom")).toContain("# PRD: Custom")
  })
})

/**
 * A step is only worth reviewing if it survives the parser intact. These use the
 * shapes `planModeInstructions` actually tells the agent to emit — the older
 * fixture above quietly avoided them (no commas; relations on separate lines),
 * which is exactly how the corruption below went unnoticed.
 */
describe("parsePlan — fidelity of what the agent wrote", () => {
  const step = (fields: string) =>
    parsePlan(
      ["```plan", "summary: Support opencode", "01 Gate on version", fields, "```"].join("\n"),
      "p1"
    ).steps[0]!

  it("keeps a comma inside an approach step, rather than splitting there", () => {
    // The field is semicolon-separated BECAUSE its values are prose and code.
    // Splitting on commas too cuts a call signature in half.
    const s = step("  approach: Add CLI_SPECS.opencode; parse it through meetsMinVersion(raw, min); never bundle a binary")
    expect(s.approach).toStrictEqual([
      "Add CLI_SPECS.opencode",
      "parse it through meetsMinVersion(raw, min)",
      "never bundle a binary"
    ])
  })

  it("keeps a comma inside a guard", () => {
    const s = step("  guards: Refresh fires at most once, even on repeated 401s; absent binary stays unavailable")
    expect(s.guards.map((g) => g.text)).toStrictEqual([
      "Refresh fires at most once, even on repeated 401s",
      "absent binary stays unavailable"
    ])
  })

  it("still reads a guard's status marker after the comma fix", () => {
    const s = step("  guards: Concurrent requests share one refresh, even under load (warn)")
    expect(s.guards).toStrictEqual([
      { text: "Concurrent requests share one refresh, even under load", status: "warn" }
    ])
  })

  it("reads both relations when written on one line, as the format specifies", () => {
    // `depends: 01; blocks: 03` is the documented shape. Parsed as a single
    // field, `blocks` is lost and `dependsOn` gains a junk "blocks: 03".
    const s = step("  depends: 01; blocks: 03")
    expect(s.dependsOn).toStrictEqual(["01"])
    expect(s.blocks).toStrictEqual(["03"])
  })

  it("reads several ordinals per relation on one line", () => {
    const s = step("  depends: 02; 03; blocks: 05; 06")
    expect(s.dependsOn).toStrictEqual(["02", "03"])
    expect(s.blocks).toStrictEqual(["05", "06"])
  })

  it("still reads relations written on their own lines", () => {
    const s = step("  depends: 03\n  blocks: 05")
    expect(s.dependsOn).toStrictEqual(["03"])
    expect(s.blocks).toStrictEqual(["05"])
  })

  it("accepts comma-separated ordinals, where a comma can't be part of a value", () => {
    const s = step("  depends: 01, 02")
    expect(s.dependsOn).toStrictEqual(["01", "02"])
  })

  it("leaves prose containing a relation-looking phrase alone", () => {
    // Only relation fields get peeled apart, so intent/approach prose is safe.
    const s = step("  intent: Refuse 1.0.x; blocks: nothing ships until it's gated")
    expect(s.intent).toBe("Refuse 1.0.x; blocks: nothing ships until it's gated")
    expect(s.blocks).toStrictEqual([])
  })

  it("keeps a comma in a file path", () => {
    const s = step("  files: M packages/cli-adapters/src/discovery.ts +14 -1")
    expect(s.files).toStrictEqual([
      { path: "packages/cli-adapters/src/discovery.ts", change: "M", added: 14, removed: 1 }
    ])
  })
})
