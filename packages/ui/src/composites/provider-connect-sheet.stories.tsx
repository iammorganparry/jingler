import { ProviderConnectionId, ProviderId } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { providerConnectSnapshot } from "./provider-connect-machine.js"
import { type ProviderConnectRequest, ProviderConnectSheet } from "./provider-connect-sheet.js"

const meta: Meta = { title: "Composites/ProviderConnectSheet" }
export default meta
type Story = StoryObj

const connectionId = ProviderConnectionId.make("story-connection")
const claude: ProviderConnectRequest = { connectionId, providerId: ProviderId.make("anthropic"), mode: "subscription" }
const codex: ProviderConnectRequest = { connectionId, providerId: ProviderId.make("openai-codex"), mode: "subscription" }
const deviceCode = { userCode: "WDJB-MJHT", verificationUri: "https://auth.openai.com/codex/device", expiresInSeconds: 872 }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function Shell(props: Partial<ComponentProps<typeof ProviderConnectSheet>>) {
  const [open, setOpen] = useState(true)
  return (
    <ProviderConnectSheet
      open={open}
      onOpenChange={setOpen}
      request={codex}
      onStartLogin={() => new Promise(() => {})}
      onCancelLogin={async () => {}}
      onReopenBrowser={() => {}}
      onSaveApiKey={async () => ({ ok: true })}
      {...props}
    />
  )
}

export const Idle: Story = { render: () => <Shell /> }

/** Board 15a · Connect · OAuth waiting (browser login in flight). */
export const OauthWaiting: Story = {
  render: () => <Shell snapshot={providerConnectSnapshot({ subscription: "connecting" }, { method: "browser" })} />
}

/** Board 15b · Connect · Device code. */
export const DeviceCode: Story = {
  render: () => (
    <Shell deviceCode={deviceCode} snapshot={providerConnectSnapshot({ subscription: "connecting" }, { method: "device-code" })} />
  )
}

/** Claude subscription: runs the local `claude auth login` check (no credential collected). */
export const ClaudeCli: Story = { render: () => <Shell request={claude} /> }

export const ClaudeCliChecking: Story = {
  render: () => <Shell request={claude} snapshot={providerConnectSnapshot({ subscription: "connecting" }, { method: "claude-cli" })} />
}

export const ClaudeCliSignedOut: Story = {
  render: () => (
    <Shell
      request={claude}
      snapshot={providerConnectSnapshot({ subscription: "idle" }, { method: "claude-cli", error: "Claude Code is not signed in on this device." })}
    />
  )
}

/** Board 15c, left card · Invalid key (keeps the typed key). */
export const ApiKeyInvalid: Story = {
  render: () => (
    <Shell
      request={claude}
      snapshot={providerConnectSnapshot(
        { apiKey: "invalid" },
        { apiProvider: "anthropic", apiKey: "sk-ant-api03-wrong-key", error: "Key rejected by provider · check and retry" }
      )}
    />
  )
}

/** Board 15c, right card · Verified, closes on Done. */
export const ApiKeyVerified: Story = {
  render: () => (
    <Shell request={claude} snapshot={providerConnectSnapshot({ apiKey: "verified" }, { apiProvider: "anthropic", apiKey: "sk-ant-api03-good" })} />
  )
}

/**
 * Click through the whole flow. Browser login connects after 2s; device code shows the 15b block then
 * connects after 4s; an API key containing "bad" is rejected, any other key verifies.
 */
export const FullFlow: Story = {
  render: () => {
    const [code, setCode] = useState<typeof deviceCode | null>(null)
    return (
      <Shell
        deviceCode={code}
        onStartLogin={async (method) => {
          if (method === "device-code") {
            await wait(600)
            setCode(deviceCode)
            await wait(4000)
          } else await wait(2000)
        }}
        onCancelLogin={async () => {
          await wait(300)
          setCode(null)
        }}
        onSaveApiKey={async (_provider, apiKey) => {
          await wait(900)
          return apiKey.includes("bad") ? { ok: false, error: "Key rejected by provider · check and retry" } : { ok: true }
        }}
      />
    )
  }
}
