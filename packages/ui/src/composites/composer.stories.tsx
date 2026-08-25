import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useRef, useState } from "react"
import type { PermissionMode, ReasoningSetting } from "@jingler/core"
import { Check, ImagePlus, Search, Sparkles } from "lucide-react"
import { testProviderCatalog } from "../test-support.js"
import { Composer } from "./composer.js"

const catalog = testProviderCatalog(["low", "medium", "high"])
const initial = catalog.connections[0]!
const skills = [
  {
    name: "/plan",
    description: "Draft a plan before editing",
    source: "command" as const
  },
  {
    name: "/review",
    description: "Review the current changes",
    source: "skill" as const
  }
]

const meta: Meta = {
  title: "Review/Composer",
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj

function ComposerFixture() {
  const [mode, setMode] = useState<PermissionMode>("accept-edits")
  const [reasoning, setReasoning] = useState<ReasoningSetting>()
  const [environment, setEnvironment] = useState<string>()
  const [connectionId, setConnectionId] = useState(initial.connection.id)
  const [modelId, setModelId] = useState(initial.models[0]!.id)
  return (
    <Composer
      mode={mode}
      onSetMode={setMode}
      reasoningEffort={reasoning?.enabled === false ? undefined : reasoning?.effort}
      thinkingEnabled={reasoning?.enabled}
      onSetReasoning={setReasoning}
      providerCatalog={catalog}
      connectionId={connectionId}
      modelId={modelId}
      onSetModel={(selection) => {
        setConnectionId(selection.connectionId)
        setModelId(selection.modelId)
      }}
      environments={[
        {
          kind: "owned",
          id: "mac-mini",
          name: "Mac Mini",
          platform: { os: "darwin", arch: "arm64" },
          capabilities: {
            version: 1,
            capabilities: ["session.start"],
            maxConcurrentSessions: 4
          },
          state: "online",
          agentVersion: "2.0.3",
          lastSeenAt: Date.now()
        }
      ]}
      environmentId={environment}
      onSetEnvironment={setEnvironment}
      skills={skills}
      files={[
        "packages/ui/src/composites/composer.tsx",
        "packages/ui/src/components/chip-menu.tsx",
        "apps/desktop/src/renderer.tsx"
      ]}
      repo="jingler"
      branch="feat/adopt-beui-component-system"
      diff={{ files: 3, added: 118, removed: 42 }}
      allowPlan
      onSend={() => {}}
    />
  )
}

function ProposedFixture() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLButtonElement>('button[aria-label="Composer menu"]')?.click()
    )
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div ref={ref}>
      <ComposerFixture />
    </div>
  )
}

function ProposedModelFixture() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timeout = window.setTimeout(
      () =>
        [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
          .find((button) => button.getAttribute("aria-label")?.startsWith("Model:"))
          ?.click(),
      50
    )
    return () => window.clearTimeout(timeout)
  }, [])
  return (
    <div ref={ref}>
      <ComposerFixture />
    </div>
  )
}

function ProposedModeFixture() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((button) => button.textContent?.includes("Accept Edits"))
        ?.click()
    )
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div ref={ref}>
      <ComposerFixture />
    </div>
  )
}

function LegacyAddMenu() {
  return (
    <div
      aria-label="Current menu treatment"
      className="absolute bottom-[138px] left-4 z-20 min-w-[220px] overflow-hidden rounded-lg border border-line bg-panel p-1.5 text-text shadow-[0_8px_24px_-12px_var(--sb-shadow-strong)]"
    >
      <div className="flex items-center gap-2 rounded-md px-2 py-2 text-[13px] text-text-body">
        <ImagePlus size={15} className="text-muted-foreground" />
        <span>Add image</span>
      </div>
      <div className="flex items-center gap-2 rounded-md px-2 py-2 text-[13px] text-text-body">
        <Sparkles size={15} className="text-muted-foreground" />
        <span className="flex-1">Skills</span>
        <span className="font-mono text-[10.5px] text-dim">2</span>
      </div>
    </div>
  )
}

function LegacyModelMenu() {
  return (
    <div
      aria-label="Current model menu treatment"
      className="absolute bottom-[138px] left-4 z-20 w-[280px] overflow-hidden rounded-lg border border-line bg-panel text-text shadow-[0_8px_24px_-12px_var(--sb-shadow-strong)]"
    >
      <div className="mx-2 mt-2 flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-2">
        <Search size={15} className="text-muted-foreground" />
        <span className="text-[13px] text-dim">Search models…</span>
      </div>
      <div className="p-2">
        <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">OpenAI</div>
        <div className="flex items-center rounded-md bg-surface px-2 py-2 text-[13px] text-text-bright">
          <span className="flex-1">GPT Test</span>
          <Check size={13} className="text-blue" />
        </div>
        <div className="rounded-md px-2 py-2 text-[13px] text-text-body">GPT Fast</div>
      </div>
    </div>
  )
}

function LegacySelectMenu() {
  return (
    <div
      aria-label="Current select menu treatment"
      className="absolute bottom-[138px] left-4 z-20 w-[210px] overflow-hidden rounded-lg border border-line bg-panel p-2 text-text shadow-[0_8px_24px_-12px_var(--sb-shadow-strong)]"
    >
      <div className="rounded-md px-2 py-2 text-[13px] text-text-body">Ask Before Actions</div>
      <div className="flex items-center rounded-md bg-surface px-2 py-2 text-[13px] text-text-bright">
        <span className="flex-1">Accept Edits</span>
        <Check size={13} className="text-blue" />
      </div>
      <div className="rounded-md px-2 py-2 text-[13px] text-text-body">Auto</div>
      <div className="rounded-md px-2 py-2 text-[13px] text-text-body">Enhanced Plan</div>
    </div>
  )
}

function ReviewPanel({
  title,
  note,
  overlay,
  children
}: {
  title: string
  note: string
  overlay?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-editor shadow-xl">
      <header className="flex-none border-b border-line bg-panel px-4 py-3">
        <h2 className="text-[13px] font-semibold text-text-bright">{title}</h2>
        <p className="mt-0.5 text-[10.5px] text-dim">{note}</p>
      </header>
      <div className="relative flex min-h-0 flex-1 items-end p-4">
        {overlay}
        <div className="w-full">{children}</div>
      </div>
    </section>
  )
}

function Comparison({ kind }: { kind: "model" | "select" | "action" }) {
  const overlay = kind === "model" ? <LegacyModelMenu /> : kind === "select" ? <LegacySelectMenu /> : <LegacyAddMenu />
  const proposed =
    kind === "model" ? <ProposedModelFixture /> : kind === "select" ? <ProposedModeFixture /> : <ProposedFixture />
  const label =
    kind === "model"
      ? "Model · BeUI Select + search"
      : kind === "select"
        ? "Mode · BeUI Select"
        : "Actions · Prompt Input Popover"
  return (
    <main className="flex h-screen min-h-[680px] flex-col gap-4 overflow-hidden bg-canvas p-5 text-text">
      <header className="mx-auto w-full max-w-[1180px]">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">Single-component review</div>
        <h1 className="mt-1 text-[18px] font-semibold text-text-bright">Composer menus</h1>
        <p className="mt-1 text-[12px] text-muted-foreground">{label}. The Composer shell is unchanged.</p>
      </header>
      <div className="mx-auto grid min-h-0 w-full max-w-[1180px] flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <ReviewPanel title="Current Jingler" note="Frozen production menu treatment." overlay={overlay}>
          <ComposerFixture />
        </ReviewPanel>
        <ReviewPanel title="Proposed BeUI" note="Exact BeUI component with Jingler color tokens only.">
          {proposed}
        </ReviewPanel>
      </div>
    </main>
  )
}

export const CurrentVsProposed: Story = {
  render: () => <Comparison kind="model" />
}
export const SelectCurrentVsProposed: Story = {
  render: () => <Comparison kind="select" />
}
export const ActionCurrentVsProposed: Story = {
  render: () => <Comparison kind="action" />
}

export const ProductionLayout: Story = {
  render: () => (
    <main className="flex h-screen min-h-[620px] items-end justify-center bg-editor p-[30px] text-text">
      <div className="w-full max-w-[760px]">
        <ComposerFixture />
      </div>
    </main>
  )
}
