import type { Meta, StoryObj } from "@storybook/react-vite"
import * as React from "react"
import { Button } from "../components/button.js"
import { ChatDrawer } from "./chat-drawer.js"

const meta: Meta = { title: "App/ChatDrawer", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

/** 1024px window: sidebar stays docked, the chat lane is a 400px overlay on the content area (board 04e). */
export const OverContent: Story = {
  render: () => {
    const Demo = () => {
      const [open, setOpen] = React.useState(true)
      const [host, setHost] = React.useState<HTMLDivElement | null>(null)
      return (
        <div className="flex h-[600px] w-[1024px] bg-editor">
          <div className="w-[266px] flex-none border-r border-hairline p-3 text-[12px] text-muted-foreground">Sidebar</div>
          <div ref={setHost} className="relative flex flex-1 p-4 text-[12px] text-muted-foreground">
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Ask</Button>
            {host && (
              <ChatDrawer open={open} onOpenChange={setOpen} container={host}>
                <div className="p-4 text-[13px] text-text-bright">Chat lane</div>
              </ChatDrawer>
            )}
          </div>
        </div>
      )
    }
    return <Demo />
  }
}
