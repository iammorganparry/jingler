import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Button } from "../components/button.js"
import { PairingSheet, type PairingSheetProps } from "./pairing-sheet.js"

const meta: Meta<typeof PairingSheet> = { title: "Composites/PairingSheet" }
export default meta
type Story = StoryObj<typeof PairingSheet>

const hosts: PairingSheetProps["hosts"] = [
  { alias: "buildbox", hostname: "buildbox", username: null, port: 22, source: "config" }
]

const base: PairingSheetProps = {
  open: true,
  state: "configuring",
  values: { host: "" },
  hosts,
  onClose: () => undefined,
  onEdit: () => undefined,
  onSelectHost: () => undefined,
  onSubmit: () => undefined,
  onRetry: () => undefined
}

export const HostEntry: Story = { render: () => <PairingSheet {...base} values={{ host: "buildbox" }} /> }

export const Installing: Story = {
  render: () => <PairingSheet {...base} state="enrolling" values={{ host: "buildbox" }} />
}

export const Paired: Story = {
  render: () => (
    <PairingSheet
      {...base}
      state="connected"
      values={{ host: "buildbox" }}
      environment={{
        kind: "owned",
        id: "device_buildbox",
        name: "buildbox",
        platform: { os: "darwin", arch: "arm64" },
        capabilities: { version: 1, capabilities: ["session.start"], maxConcurrentSessions: 2 },
        state: "online",
        agentVersion: "1.0.0",
        lastSeenAt: Date.now()
      }}
    />
  )
}

export const Failed: Story = {
  render: () => (
    <PairingSheet
      {...base}
      state="failed"
      values={{ host: "buildbox" }}
      error={"SSH authentication failed\nPermission denied (publickey).\nConnection closed by remote host."}
    />
  )
}

export const Toggle: Story = {
  render: () => {
    const [open, setOpen] = useState(false)
    return (
      <>
        <Button size="sm" onClick={() => setOpen(true)}>Pair a machine</Button>
        <PairingSheet {...base} open={open} onClose={() => setOpen(false)} />
      </>
    )
  }
}
