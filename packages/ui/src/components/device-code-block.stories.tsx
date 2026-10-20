import type { Meta, StoryObj } from "@storybook/react"
import { DeviceCodeBlock } from "./device-code-block.js"

const meta: Meta<typeof DeviceCodeBlock> = {
  title: "Components/DeviceCodeBlock",
  component: DeviceCodeBlock
}
export default meta

type Story = StoryObj<typeof DeviceCodeBlock>

export const Default: Story = {
  args: {
    code: "JING-LER1",
    verificationUri: "https://login.example.test/device",
    expiresInSeconds: 600,
    onReopenBrowser: () => {}
  }
}

export const Expiring: Story = {
  args: {
    code: "WXYZ-1234",
    verificationUri: "https://login.example.test/device",
    expiresInSeconds: 45,
    onReopenBrowser: () => {}
  }
}

export const NoExpiry: Story = {
  args: {
    code: "NOEX-PIRY",
    verificationUri: "https://login.example.test/device",
    expiresInSeconds: null,
    onReopenBrowser: () => {}
  }
}
