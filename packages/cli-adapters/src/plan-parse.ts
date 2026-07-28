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
  DEFAULT_PLAN_TEMPLATE,
  PLAN_EVIDENCE_INSTRUCTIONS
} from "@jingler/core"
import { planFromMdx } from "./plan-mdx.js"

/**
 * Turn the plan text Claude produces via `ExitPlanMode` into a structured `Plan`.
 *
 * We can't rely on the model to emit JSON, so we ask it (via
 * `planModeInstructions`) to include a safe PRD ` ````mdx plan ` block and
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

export const PLAN_MDX_REFORMAT = [
  "The submitted PRD is not valid Jingler plan MDX.",
  "Return the SAME plan as one complete four-backtick fenced ````mdx plan block.",
  "Use Markdown plus only Stage, Acceptance, and Annotation components.",
  "Every Stage needs a stable id, title, intent, and at least one Acceptance with a stable id.",
  "Do not change the substance of the plan; change only its format."
].join(" ")

const OPENING: Readonly<Record<PlanChannel, string>> = {
  tool: "When you present your plan with ExitPlanMode, put a four-backtick fenced ````mdx plan block at the top of the plan text, then your normal human-readable markdown below it.",
  reply:
    "When your plan is ready, put a four-backtick fenced ````mdx plan block at the top of your reply, then your normal human-readable markdown below it — and STOP there, without editing anything."
}

const SUBMIT_RULE: Readonly<Record<PlanChannel, string>> = {
  tool: "Only ExitPlanMode; do not edit files or run commands in plan mode.",
  reply:
    "Emit the block and stop — do not edit files or run commands in plan mode. The block is parsed into an interactive plan the operator approves, comments on, or sends back for revision; if they approve it you will be prompted again, with write access, to carry it out."
}

/**
 * The plan output protocol injected for a plan-mode turn. Documents the
 * ` ````mdx plan ` block so what the agent submits parses into structured steps. Kept
 * declarative: one block, documented field names, no per-call string assembly
 * elsewhere.
 */
export const planInstructions = (
  channel: PlanChannel,
  template: string = DEFAULT_PLAN_TEMPLATE
): string =>
  `${OPENING[channel]} Jingler renders the MDX as an interactive PRD.

${SUBMIT_RULE[channel]}

Return one four-backtick fenced \`\`\`\`mdx plan block containing the COMPLETE PRD. Markdown is
allowed. The only components are <Stage>, <Acceptance>, and <Annotation>. Do not
use imports, exports, JavaScript expressions, or arbitrary React components.
Every Stage requires a stable unique id, title, Intent section, and at least one
Acceptance with its own stable unique id and status.

Use this configured structure as the source of truth. Preserve its sections while
replacing placeholders with task-specific content:

\`\`\`mdx
${template.trim()}
\`\`\`

After the operator approves the plan, implementation may continue in this same
turn. Follow this completion protocol then:

${PLAN_EVIDENCE_INSTRUCTIONS.join("\n")}`

/** The Claude variant, passed to the SDK as `planModeInstructions`. */
export const planModeInstructions = (template: string = DEFAULT_PLAN_TEMPLATE): string =>
  planInstructions("tool", template)

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
 * Whether the agent actually emitted the ` ````mdx plan ` fence we asked for.
 *
 * `planModeInstructions` documents the format, but prompt compliance is never
 * guaranteed — the adapter uses this to bounce a fence-less plan back for one
 * reformat rather than degrading straight to the raw fallback.
 */
const fencedMdxPlan = (raw: string): string | null => {
  const opening = /^[ \t]*(`{3,})mdx[ \t]+plan[ \t]*\r?\n/im.exec(raw)
  if (opening === null) return null

  const fenceLength = opening[1]!.length
  const bodyStart = opening.index + opening[0].length
  const body = raw.slice(bodyStart)
  const closings = body.matchAll(/^[ \t]*(`{3,})[ \t]*$/gm)
  for (const closing of closings) {
    if (closing[1]!.length < fenceLength) continue
    return body.slice(0, closing.index).replace(/\s+$/, "")
  }
  return null
}

export const hasPlanBlock = (raw: string): boolean =>
  fencedMdxPlan(raw) !== null || fenced(raw, "plan") !== null

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
export const parsePlan = (raw: string, id: string): Plan => {
  const mdx = fencedMdxPlan(raw)
  if (mdx !== null) {
    const plan = planFromMdx(mdx, id)
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
