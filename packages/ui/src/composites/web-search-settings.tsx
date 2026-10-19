import type {
  WebSearchProvider,
  WebSearchSettingsStatus
} from "@jingler/core"
import { useEffect, useState } from "react"
import exaLogo from "../brand/assets/exa-logo.png"
import firecrawlLogo from "../brand/assets/firecrawl-logo.png"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Input } from "../components/input.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"

export interface WebSearchSettingsProps {
  readonly status: WebSearchSettingsStatus | null
  readonly loading?: boolean
  readonly busy?: boolean
  readonly error?: string | null
  readonly onSave: (provider: WebSearchProvider, apiKey: string) => void | Promise<void>
  readonly onClear: (provider: WebSearchProvider) => void | Promise<void>
  readonly onSkip: () => void | Promise<void>
}

const label = (provider: WebSearchProvider): string =>
  provider === "exa" ? "EXA" : "Firecrawl"

export function WebSearchSettings({
  status,
  loading = false,
  busy = false,
  error,
  onSave,
  onClear,
  onSkip
}: WebSearchSettingsProps) {
  const [provider, setProvider] = useState<WebSearchProvider>(
    status?.config.provider ?? "exa"
  )
  const [apiKey, setApiKey] = useState("")

  useEffect(() => {
    if (status?.config.provider) {
      setProvider(status.config.provider)
      setApiKey("")
    }
  }, [status?.config.provider])

  const credential = status?.credentials.find(
    (candidate) => candidate.provider === provider
  )
  const configured = credential?.configured === true
  const skipped = status?.config.setup === "skipped"

  return (
    <SettingsCard title="Web search" className="mt-6">
      {error ? <Callout tone="red">{error}</Callout> : null}

      <SettingsRow
        label="Provider"
        help="Research uses your provider first, then verified model-native search. Browser fallback is desktop-only and appears only while a client is attached."
        control={
          <SegmentedControl
            value={provider}
            items={[
              {
                value: "exa",
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <img
                      src={exaLogo}
                      alt=""
                      width={16}
                      height={16}
                      data-provider-logo="exa"
                      className="size-4 rounded-[3px] object-contain"
                    />
                    EXA
                  </span>
                )
              },
              {
                value: "firecrawl",
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <img
                      src={firecrawlLogo}
                      alt=""
                      width={16}
                      height={16}
                      data-provider-logo="firecrawl"
                      className="size-4 rounded-[3px] object-contain"
                    />
                    Firecrawl
                  </span>
                )
              }
            ]}
            onChange={(value) => {
              setProvider(value as WebSearchProvider)
              setApiKey("")
            }}
          />
        }
      />

      <SettingsRow
        label={`${label(provider)} API key`}
        help={
          configured
            ? credential.cloudSynced
              ? "Encrypted locally · synced for Cloud"
              : "Encrypted locally · Cloud sync unavailable"
            : "No saved key"
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={apiKey}
              disabled={loading || busy}
              aria-label={`${label(provider)} API key`}
              placeholder={configured ? `${label(provider)} key configured — enter a replacement` : `${label(provider)} API key`}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button
              disabled={busy || apiKey.trim().length < 8}
              onClick={async () => {
                await onSave(provider, apiKey.trim())
                setApiKey("")
              }}
            >
              {busy ? "Saving…" : configured ? "Replace" : "Save"}
            </Button>
            {configured ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onClear(provider)}>
                Clear
              </Button>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        label="Skip setup"
        help={skipped ? "Web search is skipped; the model's native search is used instead." : "Use web search without configuring a provider."}
        control={
          <Button variant="ghost" size="sm" disabled={busy} onClick={onSkip}>
            {skipped ? "Skipped" : "Skip setup"}
          </Button>
        }
      />
    </SettingsCard>
  )
}
