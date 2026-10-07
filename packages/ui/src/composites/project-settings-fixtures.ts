import {
  ProviderCatalog,
  RoutineInput,
  piEndpointId,
  type Project,
  type Routine,
  type RoutineDocument,
} from "@jingler/core"
import { Schema } from "effect"
import type { RoutineModel } from "./routine-form-machine.js"
export const settingsProjects: Project[] = [
  {
    id: "widget",
    name: "Widget",
    path: "/repos/widget",
    imported: true,
    availability: "available",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    workflow: {
      setup: "pnpm install",
      runs: [
        { id: "dev-id", label: "Dev", command: "pnpm dev" },
        { id: "test-id", label: "Test", command: "pnpm test" },
      ],
      copyFiles: [".env.local"],
      approvedDigest: "approved",
    },
  },
  {
    id: "api",
    name: "API",
    path: "/repos/api",
    imported: true,
    availability: "available",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
]
const catalog = Schema.decodeUnknownSync(ProviderCatalog)({
  refreshedAt: "2026-10-01T00:00:00.000Z",
  stale: false,
  connections: [
    {
      connection: {
        id: "managed-local",
        providerId: "openai",
        authKind: "api-key",
        account: null,
        targetId: "desktop",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: null,
          expiresAt: null,
          quotaLabel: null,
          rateLimitLabel: null,
          confirmedBillingRoute: "api",
        },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      models: [
        {
          providerId: "openai",
          id: "model-one",
          label: "Model one",
          capabilities: { contextWindow: 128000, reasoning: ["low", "medium", "high"], vision: false },
          verification: "certified",
          selectable: true,
          certificationKey: "story",
        },
        {
          providerId: "openai",
          id: "model-two",
          label: "Model two",
          capabilities: { contextWindow: 128000, reasoning: ["low", "medium", "high"], vision: false },
          verification: "certified",
          selectable: true,
          certificationKey: "story",
        },
      ],
    },
  ],
})
export const settingsModels: RoutineModel[] = catalog.connections.flatMap((entry) =>
  entry.models.map((model) => ({ ...model, connection: entry.connection })),
)
const input = Schema.decodeUnknownSync(RoutineInput)({
  name: "Inspect Widget",
  projectId: "widget",
  prompt: "Inspect README.md and summarize changes.",
  baseBranch: "main",
  runtimeId: "pi",
  endpointId: piEndpointId("desktop", catalog.connections[0]!.connection.id),
  connectionId: "managed-local",
  providerId: "openai",
  modelId: "model-one",
  mode: "ask",
  reasoning: null,
  schedule: { kind: "once", at: 1791378000123 },
  enabled: false,
  approved: true,
  maxDurationMs: 600000,
})
export const settingsRoutine: Routine = {
  ...input,
  id: "routine-widget",
  revision: "revision-1",
  createdAt: 1791378000123,
  updatedAt: 1791378000123,
  nextAt: null,
  workflowDigest: null,
}
export const settingsDocument: RoutineDocument = {
  version: 1,
  routines: [
    settingsRoutine,
    { ...settingsRoutine, id: "routine-api", projectId: "api", name: "Inspect API" },
  ],
  runs: [
    {
      id: "run-live",
      routineId: "routine-widget",
      routineName: "Inspect Widget",
      revision: "revision-1",
      trigger: "manual",
      occurrenceAt: 1791378000123,
      requestedSessionId: "s_storywidget",
      sessionId: "s_storywidget",
      status: "succeeded",
      message: "Inspection complete.",
      createdAt: 1791378000123,
      finishedAt: 1791378001123,
      skippedCount: 0,
    },
    {
      id: "run-orphan",
      routineId: "deleted",
      routineName: "Old inspection",
      revision: "revision-old",
      trigger: "manual",
      occurrenceAt: 1791377000123,
      requestedSessionId: "s_storyorphan",
      sessionId: "s_storyorphan",
      status: "running",
      message: "Inspecting files.",
      createdAt: 1791377000123,
      finishedAt: null,
      skippedCount: 0,
    },
  ],
}
