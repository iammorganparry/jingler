import type { Meta, StoryObj } from "@storybook/react-vite"
import { jinglerDark, toTokens } from "@jingler/themes"
import { PierreProvider } from "../diff/pierre-provider.js"
import { AssetFileTree } from "./asset-file-tree.js"

const meta: Meta<typeof AssetFileTree> = {
  title: "Asset/AssetFileTree",
  component: AssetFileTree,
  parameters: { layout: "centered" }
}
export default meta
type Story = StoryObj<typeof AssetFileTree>

const entries = [
  { path: "src/auth/login.ts", status: "modified" as const },
  { path: "src/auth/a-very-long-file-name-that-must-truncate-before-the-decoration.ts", status: "clean" as const },
  { path: "src/store/cache.ts", status: "clean" as const },
  { path: "docs/readme.md", status: "untracked" as const }
]

/** 248px sidebar width: names truncate, decorations never do. */
const Frame = (args: React.ComponentProps<typeof AssetFileTree>) => (
  <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
    <div className="h-[320px] w-[248px] overflow-hidden border border-line">
      <AssetFileTree {...args} className="h-full" />
    </div>
  </PierreProvider>
)

const base = { entries, selectedPath: null, onSelectPath: () => {} }

export const AgentEditingNow: Story = {
  render: () => (
    <Frame
      {...base}
      agentActivity={{
        editedPaths: ["src/auth/login.ts", "src/store/cache.ts"],
        editingPath: "src/store/cache.ts"
      }}
    />
  )
}

export const RunEnded: Story = {
  render: () => (
    <Frame
      {...base}
      agentActivity={{
        editedPaths: ["src/auth/login.ts", "src/store/cache.ts"],
        editingPath: null
      }}
    />
  )
}
