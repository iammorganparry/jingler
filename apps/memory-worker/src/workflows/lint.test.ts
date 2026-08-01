import { canonicalJson, type MemoryPage } from "@jingler/memory"
import { describe, expect, it } from "vitest"
import type {
  DurableObjectNamespaceLike,
  MemoryWorkerEnv,
  WorkflowBindingLike,
  WorkflowInstanceLike
} from "../env.js"
import worker from "../index.js"
import { InMemoryR2Bucket } from "../r2-store.js"
import {
  buildScheduledLintReport,
  runScheduledLintWorkflow,
  type LintAcceptedPage
} from "./lint.js"
import type { WorkflowStepLike } from "./compiler.js"
import type { ScheduledLintWorkflowInput } from "./lint.js"

class ImmediateStep implements WorkflowStepLike {
  readonly names: Array<string> = []

  async do<Result>(name: string, callback: () => Promise<Result> | Result): Promise<Result> {
    this.names.push(name)
    return callback()
  }
}

const page = (
  id: string,
  body: string,
  metadata: MemoryPage["metadata"] = { citationPolicy: "none" }
): MemoryPage => ({
  id,
  path: `${id}.md`,
  title: id.replace(/-/g, " "),
  revision: 1,
  aliases: [],
  tags: [],
  sources: [],
  citations: [],
  relationships: [],
  body,
  metadata
})

const fixtures: ReadonlyArray<LintAcceptedPage> = [
  {
    page: page(
      "orphan",
      "# Orphan\n\nThis factual orphan claim has no supporting citation.\n",
      { concept: "deployment-safety" }
    ),
    acceptedAt: "2026-06-01T00:00:00.000Z"
  },
  {
    page: {
      ...page("dependent", "# Dependent\n\nSee the dependency policy.\n", {
        citationPolicy: "none",
        concept: "deployment-safety",
        contradictions: ["the rollout is both required and forbidden"]
      }),
      relationships: [{ kind: "dependency", target: "dependency" }]
    },
    acceptedAt: "2026-05-01T00:00:00.000Z"
  },
  {
    page: page(
      "dependency",
      "# Dependency\n\nThe current policy points at [[Missing page]].\n"
    ),
    acceptedAt: "2026-07-01T00:00:00.000Z"
  }
]

describe("scheduled memory lint workflow", () => {
  it("reports all configured health categories deterministically without rewriting pages", async () => {
    const before = canonicalJson(fixtures)
    let reads = 0
    const step = new ImmediateStep()
    const report = await runScheduledLintWorkflow(
      {
        workflowId: "lint-2026-08-01-org",
        organizationId: "org-lint",
        asOf: "2026-08-01T00:00:00.000Z"
      },
      {
        listAcceptedPages: async () => {
          reads += 1
          return fixtures
        }
      },
      step
    )

    expect(reads).toBe(1)
    expect(step.names).toEqual(["01-read-accepted-pages", "02-build-read-only-lint-report"])
    expect(new Set(report.findings.map((finding) => finding.code))).toEqual(
      new Set([
        "orphaned-page",
        "stale-dependency",
        "duplicate-concept",
        "uncited-claim",
        "contradiction",
        "broken-link"
      ])
    )
    expect(report.counts).toMatchObject({
      "orphaned-page": 1,
      "stale-dependency": 1,
      "duplicate-concept": 2,
      "uncited-claim": 1,
      contradiction: 1,
      "broken-link": 1
    })
    expect(canonicalJson(fixtures)).toBe(before)
    expect(
      buildScheduledLintReport(
        "lint-2026-08-01-org",
        "org-lint",
        fixtures,
        "2026-08-01T00:00:00.000Z"
      )
    ).toEqual(report)
  })

  it("starts deterministic per-organization scheduled workflow handles", async () => {
    const created: Array<string> = []
    const instances = new Map<string, WorkflowInstanceLike>()
    const lintBinding: WorkflowBindingLike<ScheduledLintWorkflowInput> = {
      create: async ({ id }) => {
        const existing = instances.get(id)
        if (existing !== undefined) return existing
        const instance: WorkflowInstanceLike = {
          id,
          status: async () => ({ status: "queued" })
        }
        instances.set(id, instance)
        created.push(id)
        return instance
      },
      get: async (id) => {
        const instance = instances.get(id)
        if (instance === undefined) throw new Error("workflow not found")
        return instance
      }
    }
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => ({ name, toString: () => name }),
      get: () => ({ fetch: async () => new Response(null, { status: 404 }) })
    }
    const env: MemoryWorkerEnv = {
      MEMORY_R2: new InMemoryR2Bucket(),
      MEMORY_VAULTS: namespace,
      MEMORY_SERVICE_SECRET: "test-service-secret",
      MEMORY_LINT: lintBinding,
      MEMORY_LINT_ORGANIZATIONS: "org-b, org-a, org-a"
    }
    const event = { scheduledTime: Date.parse("2026-08-01T03:17:00.000Z") }
    await worker.scheduled(event, env)
    await worker.scheduled(event, env)
    expect(created).toHaveLength(2)
    expect(created.every((id) => id.startsWith("lint-2026-08-01-"))).toBe(true)
    expect(new Set(created).size).toBe(2)
  })
})
