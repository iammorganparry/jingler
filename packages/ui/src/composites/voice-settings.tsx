import type { VoiceModel } from "@jingler/contracts"
import type { VoiceConfig } from "@jingler/core"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"

export interface VoiceSettingsProps {
  models: ReadonlyArray<VoiceModel>
  config: VoiceConfig
  /** Last download failure, e.g. a SHA-256 mismatch. */
  error?: string | null
  onSaveConfig: (config: VoiceConfig) => void
  onDownload: (id: string) => void
  onRemove: (id: string) => void
}

export const VOICE_LANGUAGES = [
  ["auto", "Auto-detect"], ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["ja", "Japanese"], ["zh", "Chinese"]
] as const

export const VOICE_HOLD_KEYS = [["F9", "F9"], ["F8", "F8"], ["F7", "F7"], ["none", "Off"]] as const

const megabytes = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`

function ModelRow({ model, onDownload, onRemove }: { model: VoiceModel } & Pick<VoiceSettingsProps, "onDownload" | "onRemove">) {
  const percent = Math.min(100, Math.floor((model.receivedBytes / model.sizeBytes) * 100))
  return (
    <SettingsRow
      label={`ggml-${model.id}`}
      help={model.downloading ? `Downloading… ${percent}% of ${megabytes(model.sizeBytes)}` : megabytes(model.sizeBytes)}
      control={
        <div className="flex items-center gap-2">
          {model.installed && <Badge>Installed</Badge>}
          {model.installed
            ? <Button size="sm" variant="ghost" aria-label={`Remove ${model.id}`} onClick={() => onRemove(model.id)}>Remove</Button>
            : <Button size="sm" variant="secondary" aria-label={`Download ${model.id}`} disabled={model.downloading} onClick={() => onDownload(model.id)}>Download</Button>}
        </div>
      }
    />
  )
}

function ChoiceRow({ label, help, value, options, onChange }: {
  label: string
  help: string
  value: string
  options: ReadonlyArray<readonly [string, string]>
  onChange: (value: string) => void
}) {
  return (
    <SettingsRow
      label={label}
      help={help}
      control={
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger ariaLabel={label} className="h-8 w-[180px] bg-sunken px-2 py-1.5 text-[12px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map(([id, text]) => <SelectItem key={id} value={id}>{text}</SelectItem>)}
          </SelectContent>
        </Select>
      }
    />
  )
}

/** Settings › Voice: local whisper.cpp models, language and the hold-to-talk key. */
export function VoiceSettings({ models, config, error, onSaveConfig, onDownload, onRemove }: VoiceSettingsProps) {
  const installed = models.filter((model) => model.installed)
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        {error && <Callout tone="red">{error}</Callout>}
        <SettingsCard title="Speech models">
          {models.map((model) => <ModelRow key={model.id} model={model} onDownload={onDownload} onRemove={onRemove} />)}
        </SettingsCard>
        <SettingsCard title="Dictation">
          <ChoiceRow
            label="Model" help="Installed model used to transcribe."
            value={config.modelId ?? "any"}
            options={[["any", "Any installed"], ...installed.map((model) => [model.id, `ggml-${model.id}`] as const)]}
            onChange={(modelId) => onSaveConfig({ ...config, modelId: modelId === "any" ? undefined : modelId })}
          />
          <ChoiceRow
            label="Language" help="Spoken language passed to whisper.cpp."
            value={config.language ?? "auto"} options={VOICE_LANGUAGES}
            onChange={(language) => onSaveConfig({ ...config, language })}
          />
          <ChoiceRow
            label="Hold-to-talk key" help="Hold to record, release to transcribe."
            value={config.holdKey ?? "F9"} options={VOICE_HOLD_KEYS}
            onChange={(holdKey) => onSaveConfig({ ...config, holdKey })}
          />
        </SettingsCard>
      </div>
    </div>
  )
}
