import {
  DEFAULT_PLAN_TEMPLATE_HTML,
  type CliInfo,
  type CliKind,
  type ModelOption
} from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanSettings } from "./plan-settings.js"

const CLIS: ReadonlyArray<CliInfo> = [
  {
    kind: "claude",
    label: "Claude Code",
    binPath: "/usr/local/bin/claude",
    version: "1.0.0",
    available: true
  },
  {
    kind: "codex",
    label: "Codex",
    binPath: "/usr/local/bin/codex",
    version: "1.0.0",
    available: true
  },
  {
    kind: "opencode",
    label: "OpenCode",
    binPath: "/usr/local/bin/opencode",
    version: "1.0.0",
    available: true
  }
]

const MODELS: Readonly<Record<CliKind, ReadonlyArray<ModelOption>>> = {
  claude: [
    { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }
  ],
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.5-codex", label: "GPT-5.5 Codex" }
  ],
  cursor: [],
  opencode: [
    { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
    { id: "openai/gpt-5.5", label: "GPT-5.5" }
  ]
}

const meta = {
  title: "Plan/Orchestration Settings",
  component: PlanSettings,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-editor p-6">
        <Story />
      </div>
    )
  ],
  args: {
    source: DEFAULT_PLAN_TEMPLATE_HTML,
    clis: CLIS,
    loadModels: async (cli) => MODELS[cli],
    onSave: () => undefined,
    onSaveOrchestrator: () => undefined,
    onSaveWorkerRouting: () => undefined
  }
} satisfies Meta<typeof PlanSettings>

export default meta
type Story = StoryObj<typeof meta>

/** Preferred planner and complexity-aware worker routing use the live catalogue. */
export const ConfiguredRoutes: Story = {
  args: {
    orchestrator: { cli: "codex", model: "gpt-5.6-sol" },
    workerRouting: {
      default: { cli: "codex", model: "gpt-5.5-codex" },
      low: { cli: "claude", model: "claude-haiku-4-5" },
      medium: { cli: "opencode", model: "anthropic/claude-sonnet-4" },
      high: { cli: "claude", model: "claude-opus-4-1" }
    }
  }
}

export const SensibleDefaults: Story = {
  args: {
    orchestrator: null,
    workerRouting: null
  }
}

export const UnavailablePreference: Story = {
  args: {
    clis: CLIS.map((cli) =>
      cli.kind === "codex"
        ? { ...cli, binPath: null, version: null, available: false }
        : cli
    ),
    orchestrator: { cli: "codex", model: "retired-model" },
    workerRouting: {
      default: { cli: "claude", model: "claude-opus-4-1" },
      low: { cli: "codex", model: "retired-model" },
      medium: { cli: "opencode", model: "anthropic/claude-sonnet-4" },
      high: { cli: "claude", model: "claude-opus-4-1" }
    }
  }
}

export const NoPlanningProvider: Story = {
  args: {
    clis: [],
    orchestrator: null,
    workerRouting: null
  }
}
