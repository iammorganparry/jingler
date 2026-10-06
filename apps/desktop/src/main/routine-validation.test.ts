import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Project, ProviderConnectionId, ProviderCatalog, RoutineInput, piEndpointId } from "@jingler/core"
import { normalizeWorkflow } from "@jingler/cli-adapters/project-workflow"
import { validateRoutineModel, validateRoutineProject } from "./routine-validation.js"
const project = Schema.decodeUnknownSync(Project)({ id: "local", name: "repo", path: "/repo", availability: "available", updatedAt: "2026-01-01", createdAt: "2026-01-01T00:00:00Z" })
const input = Schema.decodeUnknownSync(RoutineInput)({ name: "Inspect", projectId: "local", prompt: "Inspect", baseBranch: "main", runtimeId: "pi", endpointId: piEndpointId("desktop", Schema.decodeUnknownSync(ProviderConnectionId)("test")), connectionId: "test", providerId: "test", modelId: "model", mode: "ask", reasoning: null, enabled: true, approved: true, schedule: { kind: "once", at: 1000 }, maxDurationMs: 1000 })
const catalog = Schema.decodeUnknownSync(ProviderCatalog)({ connections: [{ connection: { id: "test", providerId: "test", authKind: "api-key", account: null, targetId: "desktop", status: "authenticated", subscription: { entitlement: "active", planLabel: null, expiresAt: null, quotaLabel: null, rateLimitLabel: null, confirmedBillingRoute: "api" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" }, models: [{ providerId: "test", id: "model", label: "Model", capabilities: { contextWindow: 10000, reasoning: ["medium"], reasoningCanDisable: false, vision: false }, verification: "certified", selectable: true, certificationKey: null }], error: null }], refreshedAt: "2026-01-01", stale: false })
describe("routine prerequisite validation without fallback", () => {
  it("accepts exact saved supported local settings and provider-default reasoning", () => {
    expect(validateRoutineProject(input, project, null, "darwin")).toBeNull()
    expect(validateRoutineModel(input, catalog).id).toBe(input.modelId)
    expect(input.mode).toBe("ask"); expect(input.reasoning).toBeNull()
  })
  it("rejects remote projects, native runtimes, Windows and arbitrary setup", () => {
    expect(() => validateRoutineProject(input, { ...project, environmentId: "remote" }, null, "darwin")).toThrow("local project")
    expect(() => validateRoutineProject({ ...input, runtimeId: "codex" }, project, null, "darwin")).toThrow("managed Pi")
    expect(() => validateRoutineProject(input, project, null, "win32")).toThrow("managed Pi")
    const workflow = normalizeWorkflow({ setup: "echo unsafe", runs: [], copyFiles: [] }, true)
    expect(() => validateRoutineProject(input, { ...project, workflow }, undefined, "darwin")).toThrow("setup")
  })
  it("binds approval to current workflow content", () => {
    const workflow = normalizeWorkflow({ runs: [], copyFiles: [] }, true)
    const digest = validateRoutineProject(input, { ...project, workflow }, undefined, "darwin")
    const changed = normalizeWorkflow({ runs: [], copyFiles: ["local-file"] }, true)
    expect(() => validateRoutineProject(input, { ...project, workflow: changed }, digest, "darwin")).toThrow("changed")
    expect(() => validateRoutineProject(input, { ...project, workflow: { ...changed, approvedDigest: "stale" } }, undefined, "darwin")).toThrow("Approve")
  })
  it("rejects unsupported reasoning, unavailable models and credentials", () => {
    expect(() => validateRoutineModel({ ...input, reasoning: { enabled: true, effort: "max" } }, catalog)).toThrow("unsupported")
    expect(() => validateRoutineModel({ ...input, reasoning: { enabled: false } }, catalog)).toThrow("cannot disable")
    expect(() => validateRoutineModel(input, { ...catalog, connections: [] })).toThrow("no fallback")
    const entry = catalog.connections[0]!
    expect(() => validateRoutineModel(input, { ...catalog, connections: [{ ...entry, connection: { ...entry.connection, status: "disconnected" } }] })).toThrow("no fallback")
  })
})
