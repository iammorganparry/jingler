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

  return (
    <section aria-label="Web search" className="mt-6">
      <div className="mb-3 flex items-start justify-between gap-4 border-b border-hairline pb-2.5">
        <div>
          <h3 className="text-[13px] font-semibold text-text-bright">Web search</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Research uses your provider first, then verified model-native search.
            Browser fallback is desktop-only and appears only while a client is attached.
          </p>
        </div>
        {status?.config.setup === "skipped" ? (
          <span className="rounded bg-hover px-2 py-1 text-[10px] text-muted-foreground">Skipped</span>
        ) : null}
      </div>

      {error ? <Callout tone="red">{error}</Callout> : null}

      <div className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
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

        <div className="flex gap-2">
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
        </div>

        <div className="flex items-center justify-between gap-3 text-[10.5px] text-muted-foreground">
          <span>
            {configured
              ? credential.cloudSynced
                ? "Encrypted locally · synced for Cloud"
                : "Encrypted locally · Cloud sync unavailable"
              : "No saved key"}
          </span>
          <div className="flex gap-2">
            {configured ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onClear(provider)}>
                Clear
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onSkip}>
              Skip setup
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
