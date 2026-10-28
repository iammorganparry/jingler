import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react"
import type { ThemeSummary } from "@jingler/core"
import { BUILTIN_THEMES, toTokens } from "@jingler/themes"
import { ThemesSettings } from "./themes-settings.js"

const summaryOf = (id: string): ThemeSummary => {
  const builtin = BUILTIN_THEMES.find((b) => b.id === id)!
  const tokens = toTokens(builtin.theme)
  return { id, name: builtin.theme.name, kind: tokens.kind, source: "builtin", tokens }
}

const themes = ["jingler-dark", "one-dark-pro", "monokai", "solarized-dark"].map(summaryOf)

const meta = {
  title: "Settings/Theme",
  parameters: { layout: "fullscreen" }
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

/** Board 09e: 720px column, title + description, 4-up tiles, Import VS Code theme… */
export const Themes: Story = {
  render: function Render() {
    const [activeId, setActiveId] = useState("jingler-dark")
    return (
      <div className="flex min-h-[600px] bg-editor">
        <ThemesSettings
          themes={themes}
          activeId={activeId}
          onSelect={setActiveId}
          onDuplicate={async () => themes[0]!}
          onDelete={async () => {}}
          onImport={async () => themes[0]!}
          loadTheme={async () => null}
          onSave={async () => undefined}
        />
      </div>
    )
  }
}
