import { ProviderId } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { ProviderConnectSheet } from "./provider-connect-sheet.js"

const meta: Meta<typeof ProviderConnectSheet> = {
  title: "Composites/ProviderConnectSheet",
  component: ProviderConnectSheet
}
export default meta

type Story = StoryObj<typeof ProviderConnectSheet>

const providerId = ProviderId.make("openai-codex")

function Shell(props: Partial<React.ComponentProps<typeof ProviderConnectSheet>>) {
  const [open, setOpen] = useState(true)
  return (
    <ProviderConnectSheet
      open={open}
      onOpenChange={setOpen}
      providerId={providerId}
      providerLabel="Codex"
      onStartOauth={async () => "login-1"}
      onCancelLogin={async () => {}}
      onReopenBrowser={() => {}}
      onSaveApiKey={async () => ({ ok: true })}
      {...props}
    />
  )
}

export const Idle: Story = {
  render: () => <Shell />
}

export const OauthWaiting: Story = {
  render: () => <Shell onStartOauth={async () => "login-1"} />
}

export const DeviceCodeOffered: Story = {
  render: () => <Shell onStartDeviceCode={async () => "login-device-1"} />
}

export const DeviceCode: Story = {
  render: () => (
    <Shell
      deviceCode={{
        userCode: "JING-LER1",
        verificationUri: "https://login.example.test/device",
        expiresInSeconds: 600
      }}
    />
  )
}

export const ApiKeyVerified: Story = {
  render: () => <Shell onSaveApiKey={async () => ({ ok: true })} />
}

export const ApiKeyInvalid: Story = {
  render: () => <Shell onSaveApiKey={async () => ({ ok: false, error: "Invalid API key" })} />
}
