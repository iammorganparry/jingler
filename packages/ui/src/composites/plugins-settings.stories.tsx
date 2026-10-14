import type { Meta, StoryObj } from "@storybook/react-vite"
import type { LoadedPlugin } from "@jingler/core"
import { PluginsSettings } from "./plugins-settings.js"

const plugin = (id: string, name: string, over: Partial<LoadedPlugin> = {}, settings: unknown[] = []): LoadedPlugin =>
  ({
    manifest: {
      id,
      name,
      version: "1.0.0",
      description: `${name} plugin.`,
      contributes: { tabs: [{ id: `${id}.main`, label: name }], settings }
    },
    dir: `/home/dev/jingler/plugins/${id}`,
    enabled: true,
    activated: false,
    builtin: false,
    ...over
  }) as LoadedPlugin

/** Plannotator is built in and declares no secret: it must never show a key field. */
const plannotator = plugin("plannotator", "Plannotator", { builtin: true })

const linear = plugin("linear", "Linear", {}, [
  { id: "linear.api-key", label: "Personal API key", type: "secret", placeholder: "lin_api_…", description: "Create a personal API key in Linear Security & access settings." }
])

const meta: Meta<typeof PluginsSettings> = {
  title: "Settings/Plugins",
  component: PluginsSettings,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-[720px] bg-editor p-6">
        <Story />
      </div>
    )
  ],
  args: {
    onSetEnabled: () => {},
    onUninstall: () => {},
    onReveal: () => {},
    onSetSetting: async () => {},
    onSetSecret: async () => {},
    onClearSecret: async () => {}
  }
}

export default meta
type Story = StoryObj<typeof PluginsSettings>

export const PlannotatorWithoutKey: Story = {
  args: { catalog: { plugins: [plannotator], failed: [] } }
}

export const PluginWithSecret: Story = {
  args: {
    catalog: { plugins: [plannotator, linear], failed: [] },
    settings: { linear: { values: {}, secrets: { "linear.api-key": false } } }
  }
}

export const PluginWithConfiguredSecret: Story = {
  args: {
    catalog: { plugins: [plannotator, linear], failed: [] },
    settings: { linear: { values: {}, secrets: { "linear.api-key": true } } }
  }
}

export const Empty: Story = { args: { catalog: { plugins: [], failed: [] } } }
