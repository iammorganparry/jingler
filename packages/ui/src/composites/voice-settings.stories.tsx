import type { Meta, StoryObj } from "@storybook/react-vite"
import { VoiceLevelMeter } from "./composer.js"
import { VoiceSettings } from "./voice-settings.js"

const models = [
  { id: "tiny.en", sizeBytes: 77_704_715, installed: true, downloading: false, receivedBytes: 0 },
  { id: "base.en", sizeBytes: 147_964_211, installed: false, downloading: true, receivedBytes: 70_000_000 },
  { id: "small", sizeBytes: 487_601_967, installed: false, downloading: false, receivedBytes: 0 }
]

const meta: Meta<typeof VoiceSettings> = {
  title: "Settings/Voice",
  component: VoiceSettings,
  parameters: { layout: "fullscreen" },
  args: { models, config: {}, onSaveConfig: () => {}, onDownload: () => {}, onRemove: () => {} }
}
export default meta
type Story = StoryObj<typeof VoiceSettings>

export const Default: Story = {}
export const ChecksumMismatch: Story = {
  args: { error: "Downloaded model failed its SHA-256 check and was deleted" }
}
export const Configured: Story = { args: { config: { language: "de", modelId: "tiny.en", holdKey: "F8" } } }

export const LevelMeter: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-3 bg-editor p-6">
      <VoiceLevelMeter level={0.1} elapsedMs={3_000} />
      <VoiceLevelMeter level={0.8} elapsedMs={75_000} />
    </div>
  )
}
