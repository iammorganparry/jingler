import type {
  DiffStat,
  Plan,
  PlanEdge,
  PlanFileChange,
  PlanGraph,
  PlanGuard,
  PlanNode,
  PlanNodeKind,
  PlanStep,
  PlanStepCode
} from "@jingler/core"
import {
  compileOrchestrationPlanHtml,
  DEFAULT_PLAN_TEMPLATE_HTML,
  PLAN_EVIDENCE_INSTRUCTIONS,
  type WorkerRoutingConfig
} from "@jingler/core"
import type { OrchestrationRoute } from "./adapter.js"
import { parsePlanHtml, planFromHtml } from "./plan-html.js"

/**
 * Turn the plan text Claude produces via `ExitPlanMode` into a structured `Plan`.
 *
 * We can't rely on the model to emit JSON, so we ask it (via
 * `planModeInstructions`) to include a safe PRD ` ````html ` block and
 * parse that here. Everything is best-effort and forgiving: a missing/garbled
 * block falls back to a single step that carries the raw markdown, so the plan is
 * always renderable and never lost. Pure and deterministic given `(raw, id)` —
 * the primary unit-test seam for plan mode.
 */

// ── The output protocol injected into the plan-mode system prompt ─────────────

/**
 * How the agent hands its finished plan back. Claude has a real `ExitPlanMode`
 * tool the adapter intercepts; every other harness has nothing to call, so it
 * ends its reply with the block and stops, and the adapter reads it out of the
 * message text.
 *
 * Parameterised rather than duplicated because the GRAMMAR is the contract with
 * `parsePlan` and must not drift between harnesses — only the two sentences
 * about how to submit it legitimately differ.
 */
export type PlanChannel = "tool" | "reply"

const PLAN_HTML_FENCE_RULE =
  "The opening fence must be exactly ````html on its own line and the closing fence must be exactly ````."

export const PLAN_HTML_REFORMAT = [
  "The submitted PRD is not valid Jingler plan HTML.",
  "Return the SAME plan as one complete four-backtick fenced HTML block.",
  PLAN_HTML_FENCE_RULE,
  "Use HTML with <section data-stage>, <div data-acceptance data-status>, and <aside data-annotation> for structure.",
  "Every stage needs a stable id + title and at least one acceptance with a stable id and status.",
  "Do not change the substance of the plan; change only its format."
].join(" ")

const OPENING: Readonly<Record<PlanChannel, string>> = {
  tool: `When you present your plan with ExitPlanMode, put a four-backtick fenced HTML block at the top of the plan text, then your normal human-readable markdown below it. ${PLAN_HTML_FENCE_RULE}`,
  reply: `When your plan is ready, put a four-backtick fenced HTML block at the top of your reply, then your normal human-readable markdown below it — and STOP there, without editing anything. ${PLAN_HTML_FENCE_RULE}`
}

const DIRECT_SUBMIT_RULE: Readonly<Record<PlanChannel, string>> = {
  tool: "Only ExitPlanMode; do not edit files or run commands in plan mode.",
  reply:
    "Emit the block and stop — do not edit files or run commands in plan mode. The block is parsed into an interactive plan the operator approves, comments on, or sends back for revision; if they approve it you will be prompted again, with write access, to carry it out."
}

const ORCHESTRATOR_SUBMIT_RULE: Readonly<Record<PlanChannel, string>> = {
  tool:
    "Only ExitPlanMode; do not edit files or run commands. After submission, stop: Jingler—not this planning harness—executes an approved plan through assigned workers.",
  reply:
    "Emit the block and stop — do not edit files or run commands. Jingler parses it for approval and delegates an approved plan to assigned workers; this planning harness never implements it."
}

/**
 * The plan output protocol injected for a plan-mode turn. Documents the
 * ` ````html ` block so what the agent submits parses into structured steps. Kept
 * declarative: one block, documented field names, no per-call string assembly
 * elsewhere.
 */
export const planInstructions = (
  channel: PlanChannel,
  template: string = DEFAULT_PLAN_TEMPLATE_HTML,
  orchestration?: ReadonlyArray<OrchestrationRoute>,
  _workerRouting?: WorkerRoutingConfig
): string =>
  `${OPENING[channel]} Jingler renders the HTML as an interactive PRD in a Notion-style editor.

${orchestration === undefined
  ? DIRECT_SUBMIT_RULE[channel]
  : ORCHESTRATOR_SUBMIT_RULE[channel]}

${orchestration === undefined
  ? ""
  : `ORCHESTRATOR PROCEDURE — the planning harness never implements an approved plan.
Jingler hands approved stages to provider-neutral worker agents.
- Every executable stage MUST declare data-complexity="low|medium|high".
- Use data-depends-on="stage-id ..." for dependencies.
- Every stage MUST include <ul data-files>. List each repository-relative path it may
  edit, normalized without "." or ".."; use an empty <ul data-files></ul> only when
  the stage cannot edit repository files. Undeclared stages are serialized together.
- Use stable stage and acceptance ids across amendments. Do not mark criteria passed or
  add evidence: workers own mechanical progress and PLAN_RESULT evidence.
- Do NOT add data-assignment elements, agent ids, harnesses, models, reasoning, or
  execution statuses. Jingler deterministically compiles dependency/file components,
  preserves stable worker identities across amendments, and applies operator routing.

`}
Return one four-backtick fenced HTML block containing the COMPLETE PRD as HTML.
${PLAN_HTML_FENCE_RULE}
Treat the plan as an operational visual aid, not an essay:
- Keep prose terse: one sentence of context, short labels, and compact bullets. Prefer a
  small Mermaid flow only when it clarifies dependencies or branching better than text.
- Every stage is one self-contained, independently reviewable deliverable. It must be
  deterministic from the repository state left by its declared dependencies and safe to
  repeat. Never create vague discovery, coordination, or "continue implementation" stages.
- Name the concrete output, exact repository-relative files, bounded implementation actions,
  and observable verification. A stage is complete only when its deliverable and tests can be
  reviewed together; acceptance criteria are assertions, not aspirations.
- When the operator changes scope, revise this canonical HTML with stable ids instead of
  restating the plan in chat. Keep chat for a required decision, a blocker, or the final result.

Use ordinary HTML for prose (h1 title, h2 sections, p, ul/ol/li, strong/em, code, pre,
blockquote, table). Carry structure on data-attributes — never <script>, <style>, event
handlers, inline styles, or JavaScript:

- Title: <h1>PRD: ...</h1>
- Section: <h2>Context</h2> then prose.
- Stage: <section data-stage="01" data-title="..."> with a one-sentence <h3>Intent</h3>,
  a bounded <h3>Approach</h3>, exact <ul data-files>, and acceptance criteria inside it.
- Acceptance: <div data-acceptance="01.1" data-status="pending">observable assertion</div>
  (status is one of pending | passed | failed | waived).
- Flow diagram: <div data-diagram="mermaid"><pre>graph TD; A--&gt;B</pre></div>
- Comment: <aside data-annotation="a1" data-stage="01">note for the agent</aside>

Every stage needs a stable unique id + title and at least one acceptance with its own
stable unique id and status.

Use this configured structure as the source of truth. Preserve its sections while
replacing placeholders with task-specific content:

\`\`\`html
${template.trim()}
\`\`\`

${orchestration === undefined
  ? `After the operator approves the plan, implementation may continue in this same
turn. Follow this completion protocol then:

${PLAN_EVIDENCE_INSTRUCTIONS.join("\n")}`
  : `After submission, STOP. Do not wait for approval, implement stages, mutate files,
or claim progress or evidence. Jingler owns approval, worker execution, mechanical
status updates, and PLAN_RESULT evidence.`}`

/** The Claude variant, passed to the SDK as `planModeInstructions`. */
export const planModeInstructions = (
  template: string = DEFAULT_PLAN_TEMPLATE_HTML,
  orchestration?: ReadonlyArray<OrchestrationRoute>,
  workerRouting?: WorkerRoutingConfig
): string => planInstructions("tool", template, orchestration, workerRouting)

// ── Parsing ───────────────────────────────────────────────────────────────────

const GUARD_STATUS: Record<string, PlanGuard["status"]> = {
  warn: "warn",
  open: "open",
  ok: "ok",
  review: "under-review"
}

/**
 * Extract the first fenced block whose info string is EXACTLY `lang`, or null.
 *
 * The info string must be the language alone (trailing spaces are fine) — a
 * prefix match would let a ` ```planning ` block masquerade as the plan spec:
 * the reformat bounce would be skipped and its contents parsed as steps.
 */
const fenced = (raw: string, lang: string): string | null => {
  const re = new RegExp("```" + lang + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "i")
  const m = re.exec(raw)
  return m ? m[1]!.replace(/\s+$/, "") : null
}

/**
 * Whether the agent actually emitted the ` ````html ` fence we asked for.
 *
 * `planModeInstructions` documents the format, but prompt compliance is never
 * guaranteed — the adapter uses this to bounce a fence-less plan back for one
 * reformat rather than degrading straight to the raw fallback.
 */
export interface HtmlPlanSubmission {
  readonly body: string
  readonly block: string
  readonly start: number
  readonly end: number
}

/**
 * Explicit reply-channel handoff used when an orchestrator deliberately chooses
 * delegation without entering a provider-native plan mode. A plan fence alone
 * is content and may legitimately appear in an explanation or review.
 */
export const ORCHESTRATOR_PLAN_SUBMISSION_MARKER =
  "<!-- jingler:submit-plan -->"

export const ORCHESTRATOR_PLAN_HTML_REFORMAT = `${PLAN_HTML_REFORMAT} Start the reply with exactly ${ORCHESTRATOR_PLAN_SUBMISSION_MARKER} on its own line to resubmit it.`

/**
 * Find every complete, structurally valid HTML plan submission.
 *
 * `html` is the canonical CommonMark info string. `html plan` remains accepted
 * for agents prompted before the contract was corrected. Both forms require the
 * exact four-backtick transport documented by the prompt; ordinary triple-fenced
 * HTML examples are user-visible content, never protocol.
 *
 * This is a forward parser rather than an opening-fence scan. Advancing past each
 * outer block makes the returned ranges disjoint and prevents a nested
 * triple-backtick HTML example from becoming a top-level candidate.
 */
export const completeHtmlPlanSubmissions = (
  raw: string
): ReadonlyArray<HtmlPlanSubmission> => {
  const found: Array<HtmlPlanSubmission> = []
  const openings = /^[ \t]*`{4}(?!`)html(?:[ \t]+plan)?[ \t]*\r?\n/gim
  const closings = /^[ \t]*`{4}(?!`)[ \t]*(?=\r?$)/gm
  let cursor = 0
  while (cursor < raw.length) {
    openings.lastIndex = cursor
    const opening = openings.exec(raw)
    if (opening === null) break
    const bodyStart = opening.index + opening[0].length
    closings.lastIndex = bodyStart
    const closing = closings.exec(raw)
    if (closing === null) break
    const end = closing.index + closing[0].length
    const body = raw.slice(bodyStart, closing.index).replace(/\s+$/, "")
    cursor = end
    found.push({
      body,
      block: raw.slice(opening.index, end),
      start: opening.index,
      end
    })
  }
  return found
}

const htmlPlanSubmissions = (
  raw: string
): ReadonlyArray<HtmlPlanSubmission> =>
  completeHtmlPlanSubmissions(raw).filter(({ body }) => parsePlanHtml(body).valid)

const compiledHtmlPlanSubmission = (
  raw: string,
  workerRouting: WorkerRoutingConfig
): { readonly submission: HtmlPlanSubmission; readonly html: string } | null => {
  for (const submission of completeHtmlPlanSubmissions(raw)) {
    const compiled = compileOrchestrationPlanHtml(
      submission.body,
      workerRouting
    )
    if (compiled.valid) return { submission, html: compiled.html }
  }
  return null
}

/**
 * The protocol requires one block at the top. Select the first valid submission
 * so later human-readable HTML examples cannot replace it; malformed earlier
 * attempts are filtered before selection, so a corrected retry still wins.
 */
export const fencedHtmlPlanSubmission = (
  raw: string,
  workerRouting?: WorkerRoutingConfig
): HtmlPlanSubmission | null =>
  workerRouting === undefined
    ? htmlPlanSubmissions(raw)[0] ?? null
    : compiledHtmlPlanSubmission(raw, workerRouting)?.submission ?? null

export const orchestratorPlanSubmission = (
  raw: string
): HtmlPlanSubmission | null => {
  const markerEnd = raw.indexOf(ORCHESTRATOR_PLAN_SUBMISSION_MARKER)
  if (markerEnd < 0 || raw.slice(0, markerEnd).trim().length > 0) return null
  // Intent and validity are separate concerns. A complete canonical transport
  // with the explicit marker is a deliberate submission even when its HTML is
  // malformed; the adapter must intercept that reply so it can request the one
  // bounded reformat retry instead of leaking it into ordinary chat.
  const submission = completeHtmlPlanSubmissions(raw)[0] ?? null
  if (submission === null) return null
  const between = raw.slice(
    markerEnd + ORCHESTRATOR_PLAN_SUBMISSION_MARKER.length,
    submission.start
  )
  return between.trim().length === 0 ? submission : null
}

export const hasOrchestratorPlanSubmission = (raw: string): boolean =>
  orchestratorPlanSubmission(raw) !== null

export const fencedHtmlPlan = (raw: string): string | null =>
  fencedHtmlPlanSubmission(raw)?.body ?? null

/** Remove one selected plan transport while preserving every other HTML block. */
export const stripHtmlPlanBlock = (
  raw: string,
  submittedBlock?: string
): string => {
  const selected =
    submittedBlock === undefined
      ? fencedHtmlPlanSubmission(raw)
      : (() => {
          const start = raw.indexOf(submittedBlock)
          return start < 0
            ? null
            : { start, end: start + submittedBlock.length }
        })()
  if (selected === null) return raw.trim()
  const stripped =
    raw.slice(0, selected.start) + raw.slice(selected.end)
  return stripped.replace(/\n{3,}/g, "\n\n").trim()
}

/** @deprecated Use `stripHtmlPlanBlock`; only one protocol block is selected. */
export const stripHtmlPlanBlocks = stripHtmlPlanBlock

export const hasPlanBlock = (raw: string): boolean =>
  fencedHtmlPlan(raw) !== null || fenced(raw, "plan") !== null

/** Numeric-only ordinals pad to two digits ("4" → "04"); arms ("4a") stay as-is. */
const normNum = (n: string): string => (/^\d+$/.test(n) ? n.padStart(2, "0") : n)

const stepId = (n: string): string => `s_${normNum(n)}`

/** The branch step id an arm hangs off — "4a" → the parent's id "s_04". */
const parentIdOf = (armNumber: string): string | null => {
  const m = /^(\d+)[a-z]$/.exec(armNumber)
  return m ? `s_${m[1]!.padStart(2, "0")}` : null
}

const clean = (parts: ReadonlyArray<string>): ReadonlyArray<string> =>
  parts.map((s) => s.trim()).filter((s) => s.length > 0)

/**
 * Split a prose/code field — `approach`, `guards`, `files`.
 *
 * Semicolons ONLY. The format documents these as semicolon-separated precisely
 * because their values are prose and code, which are full of commas: splitting
 * on commas too tears `meetsMinVersion(raw, min)` into "…meetsMinVersion(raw"
 * and "min)", and turns the guard "fires once, even on repeated 401s" into two
 * fragments that each say nothing.
 */
const splitProse = (v: string): ReadonlyArray<string> => clean(v.split(";"))

/**
 * Split a list of step ordinals — `depends`, `blocks`.
 *
 * Commas are fine here, unlike the prose fields: an ordinal ("01", "4a") can't
 * contain one, so "01, 02" and "01; 02" can safely mean the same two steps.
 */
const splitRefs = (v: string): ReadonlyArray<string> => clean(v.split(/[;,]/))

/** The relation fields — the only ones the format puts two-to-a-line. */
const RELATION = /^\s*(depends|blocks)\s*:\s*(.*)$/i

/**
 * Peel a trailing relation field out of a value.
 *
 * The format writes both relations on ONE line — `depends: 01; blocks: 03` — so
 * reading that line as a single field swallows the second: `blocks` goes unset
 * while `dependsOn` gains a junk "blocks: 03" entry. Applied only to relation
 * fields, so prose that happens to contain "…; blocks: …" is left alone.
 */
const splitRelations = (key: string, value: string): ReadonlyArray<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = []
  let k = key
  let buf: Array<string> = []
  for (const token of value.split(";")) {
    const m = RELATION.exec(token)
    if (m) {
      out.push([k, buf.join(";")] as const)
      k = m[1]!.toLowerCase()
      buf = [m[2]!]
    } else buf.push(token)
  }
  out.push([k, buf.join(";")] as const)
  return out
}

const parseFile = (token: string): PlanFileChange | null => {
  const m = /^([AMD])\s+(\S+)(?:\s+\+(\d+))?(?:\s+-(\d+))?/.exec(token.trim())
  if (!m) return null
  return { path: m[2]!, change: m[1] as PlanFileChange["change"], added: Number(m[3] ?? 0), removed: Number(m[4] ?? 0) }
}

const parseGuard = (token: string): PlanGuard => {
  const m = /^(.*?)\s*(?:\((warn|open|ok|review)\))?\s*$/i.exec(token.trim())
  const text = (m?.[1] ?? token).trim()
  const status = m?.[2] ? GUARD_STATUS[m[2].toLowerCase()]! : "ok"
  return { text, status }
}

const sumDiff = (files: ReadonlyArray<PlanFileChange>): DiffStat | null => {
  if (files.length === 0) return null
  return files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), {
    added: 0,
    removed: 0
  })
}

/** A mutable working copy of a step, assembled field-by-field then frozen as `PlanStep`. */
type MutableStep = { -readonly [K in keyof PlanStep]: PlanStep[K] }

/** A blank, well-formed step keyed by its ordinal. */
const emptyStep = (number: string, title: string): MutableStep => {
  const arm = /^\d+[a-z]$/.test(number)
  return {
    id: stepId(number),
    number: normNum(number),
    title,
    intent: "",
    approach: [],
    kind: arm ? "branch-arm" : "step",
    condition: null,
    parentId: arm ? parentIdOf(number) : null,
    dependsOn: [],
    blocks: [],
    files: [],
    guards: [],
    code: null,
    diff: null,
    status: "proposed",
    flagged: false
  }
}

const STEP_HEADER = /^\s*(\d+[a-z]?)\s+(.+?)\s*$/
const FIELD = /^\s+([a-z]+)\s*:\s*(.+?)\s*$/i

/** Parse the lines inside a `plan` block into steps + a summary. */
const parseBlock = (block: string): { summary: string; steps: PlanStep[] } => {
  const steps: MutableStep[] = []
  let summary = ""
  let current: MutableStep | null = null
  const setDiff = (s: MutableStep): MutableStep => ({ ...s, diff: sumDiff(s.files) })

  const flush = () => {
    if (current) steps.push(setDiff(current))
    current = null
  }

  for (const line of block.split("\n")) {
    if (line.trim().length === 0) continue
    const summaryMatch = /^\s*summary\s*:\s*(.+?)\s*$/i.exec(line)
    if (summaryMatch && current === null) {
      summary = summaryMatch[1]!
      continue
    }
    const field = current ? FIELD.exec(line) : null
    const header = STEP_HEADER.exec(line)
    // A field only counts when it's more-indented than a step header would be
    // and matches a known key — otherwise a header wins (e.g. "04 Handle…").
    if (field && (!header || line.startsWith("  "))) {
      const key = field[1]!.toLowerCase()
      const value = field[2]!
      const s = current!
      // One line can carry both relations (`depends: 01; blocks: 03`), so a
      // relation field may yield two; everything else is a single field whose
      // value is taken whole.
      const fields =
        key === "depends" || key === "blocks"
          ? splitRelations(key, value)
          : [[key, value] as const]
      for (const [k, v] of fields) {
        switch (k) {
          case "intent":
            s.intent = v
            break
          case "approach":
            s.approach = splitProse(v)
            break
          case "files":
            s.files = splitProse(v).map(parseFile).filter((f): f is PlanFileChange => f !== null)
            break
          case "guards":
            s.guards = splitProse(v).map(parseGuard)
            break
          case "depends":
            s.dependsOn = splitRefs(v).map(normNum)
            break
          case "blocks":
            s.blocks = splitRefs(v).map(normNum)
            break
          case "branch":
            s.kind = "branch"
            s.condition = v
            break
        }
      }
      continue
    }
    if (header) {
      flush()
      current = emptyStep(header[1]!, header[2]!)
    }
  }
  flush()

  // Any step that an arm hangs off is a branch, even without an explicit field.
  const parents = new Set(steps.filter((s) => s.kind === "branch-arm").map((s) => s.parentId))
  for (const s of steps) {
    if (parents.has(s.id) && s.kind !== "branch") s.kind = "branch"
  }
  return { summary, steps }
}

const NODE_KINDS = new Set<PlanNodeKind>(["start", "decision", "action", "io", "terminal", "note"])
const NODE_LINE = /^(start|decision|action|io|terminal|note)\s+(\S+)\s+"([^"]*)"(.*)$/
const EDGE_LINE = /^(\S+)\s*->\s*(\S+)(?:\s*:\s*(.+?))?\s*$/

const parseNode = (m: RegExpExecArray): PlanNode => {
  const rest = m[4] ?? ""
  const step = /\bstep\s+(\S+)/.exec(rest)
  const file = /\bfile\s+(\S+)/.exec(rest)
  const detailQuoted = /"([^"]*)"/.exec(rest)
  return {
    id: m[2]!,
    label: m[3]!,
    kind: m[1] as PlanNodeKind,
    detail: file?.[1] ?? detailQuoted?.[1] ?? null,
    stepId: step ? stepId(step[1]!) : null
  }
}

/**
 * Parse the body of a flow block into a decision graph (nodes + edges). Node
 * lines start with a kind keyword; every other `a -> b` line is an edge whose
 * optional `: label` carries the condition. Returns null when there's nothing
 * renderable, so the Flow view falls back to its empty state.
 */
const graphFromBlock = (block: string): PlanGraph | null => {
  const nodes: Array<PlanNode> = []
  const edges: Array<PlanEdge> = []
  for (const line of block.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const nodeMatch = NODE_LINE.exec(trimmed)
    if (nodeMatch && NODE_KINDS.has(nodeMatch[1] as PlanNodeKind)) {
      nodes.push(parseNode(nodeMatch))
      continue
    }
    const edgeMatch = EDGE_LINE.exec(trimmed)
    if (edgeMatch) {
      edges.push({
        id: `e_${edges.length}`,
        from: edgeMatch[1]!,
        to: edgeMatch[2]!,
        label: edgeMatch[3]?.trim() || null
      })
    }
  }
  // Drop edges that dangle (reference a node we never declared) — keeps the layout sane.
  const known = new Set(nodes.map((n) => n.id))
  const kept = edges.filter((e) => known.has(e.from) && known.has(e.to))
  return nodes.length > 0 ? { nodes, edges: kept } : null
}

/** Matches every fenced ` ```flow … ` block, capturing its info string + body. */
const FLOW_BLOCK = /```flow[ \t]*([^\n]*)\n([\s\S]*?)```/gi

/**
 * Legacy: parse a single UNtagged ` ```flow ` block (per-step flows use
 * ` ```flow step NN `). Returns null when there's no untagged block, so old
 * single-flow plans keep rendering while new plans carry flows per step.
 */
export const parseFlow = (raw: string): PlanGraph | null => {
  FLOW_BLOCK.lastIndex = 0
  // `for (;;)` with an explicit break, not an assignment in the loop condition:
  // the latter reads as a comparison at a glance, and the re-scan can't move to
  // the end of the body because the body `continue`s past it.
  for (;;) {
    const m = FLOW_BLOCK.exec(raw)
    if (m === null) break
    if (/\bstep\b/i.test(m[1] ?? "")) continue
    return graphFromBlock(m[2] ?? "")
  }
  return null
}

/**
 * Parse every ` ```flow step NN ` block into a map of normalized step number →
 * that step's own decision/logic flow. A step without a flow block simply isn't
 * in the map (its `graph` stays null). First block per step wins.
 */
export const parseStepFlows = (raw: string): Map<string, PlanGraph> => {
  const out = new Map<string, PlanGraph>()
  FLOW_BLOCK.lastIndex = 0
  for (;;) {
    const m = FLOW_BLOCK.exec(raw)
    if (m === null) break
    const step = /\bstep\s*=?\s*(\d+[a-z]?)\b/i.exec(m[1] ?? "")
    if (!step) continue
    const num = normNum(step[1]!)
    if (out.has(num)) continue
    const graph = graphFromBlock(m[2] ?? "")
    if (graph) out.set(num, graph)
  }
  return out
}

/**
 * Scan every fenced code block whose info string links it to a step (e.g.
 * ` ```ts step 02 `) into a map of normalized step number → `PlanStepCode`. The
 * ` ```plan ` block carries no `step`, and ` ```flow step NN ` blocks are
 * explicitly excluded (they're parsed as per-step flows, not code samples).
 */
export const parseStepCode = (raw: string): Map<string, PlanStepCode> => {
  const out = new Map<string, PlanStepCode>()
  const re = /```([^\n]*)\n([\s\S]*?)```/g
  for (;;) {
    const m = re.exec(raw)
    if (m === null) break
    const info = (m[1] ?? "").trim()
    // Per-step flow blocks (` ```flow step NN `) also carry a step tag — they're
    // graphs, not code, so never treat them as a code sample.
    if (/^flow\b/i.test(info)) continue
    const stepMatch = /\bstep\s*=?\s*(\d+[a-z]?)\b/i.exec(info)
    if (!stepMatch) continue
    const num = normNum(stepMatch[1]!)
    if (out.has(num)) continue // first sample per step wins
    const first = info.split(/\s+/)[0] ?? ""
    const lang = first.length > 0 && first.toLowerCase() !== "step" && !/^step=/i.test(first) ? first : null
    const body = (m[2] ?? "").replace(/\s+$/, "")
    if (body.length > 0) out.set(num, { lang, body })
  }
  return out
}

/**
 * Parse a raw `ExitPlanMode` plan into a structured `Plan`. Falls back to a
 * single step wrapping the markdown when there's no parseable ` ```plan ` block.
 */
export const parsePlan = (
  raw: string,
  id: string,
  workerRouting?: WorkerRoutingConfig
): Plan => {
  if (workerRouting !== undefined) {
    const compiled = compiledHtmlPlanSubmission(raw, workerRouting)
    if (compiled !== null) {
      const plan = planFromHtml(compiled.html, id)
      if (plan !== null) return plan
    }
  }
  const html = fencedHtmlPlan(raw)
  if (html !== null) {
    const plan = planFromHtml(html, id)
    if (plan !== null) return plan
  }
  const block = fenced(raw, "plan")
  const graph = parseFlow(raw)
  const code = parseStepCode(raw)
  const flows = parseStepFlows(raw)
  const parsed = block ? parseBlock(block) : { summary: "", steps: [] as PlanStep[] }

  if (parsed.steps.length === 0) {
    // Fallback: no structured block — surface the first heading as the summary and
    // keep one step so the tab/badge still work. `structured: false` is what tells
    // the UI to render `raw`; without it the plan's actual content is invisible.
    const firstLine = raw.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 0)
    const summary = parsed.summary || firstLine || "Proposed plan"
    return {
      id,
      summary,
      structured: false,
      graph,
      steps: [
        {
          id: "s_01",
          number: "01",
          title: summary,
          intent: "The agent didn't use the structured plan format — its full plan is below.",
          approach: [],
          kind: "step",
          condition: null,
          parentId: null,
          dependsOn: [],
          blocks: [],
          files: [],
          guards: [],
          code: null,
          // No structured steps — hang any single legacy flow on the one step so
          // it still renders per-step.
          graph,
          diff: null,
          status: "proposed",
          flagged: false
        }
      ],
      comments: [],
      status: "proposed",
      raw
    }
  }

  return {
    id,
    summary: parsed.summary || parsed.steps[0]!.title,
    structured: true,
    graph,
    // Attach any per-step code sample + per-step flow, keyed by the step's
    // normalized number.
    steps: parsed.steps.map((s) => ({
      ...s,
      ...(code.has(s.number) && { code: code.get(s.number)! }),
      ...(flows.has(s.number) && { graph: flows.get(s.number)! })
    })),
    comments: [],
    status: "proposed",
    raw
  }
}
