import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "./button.js"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "./drawer.js"

const meta: Meta = { title: "Molecules/Drawer" }
export default meta
type Story = StoryObj

/** Right sheet, 480px, full-window scrim (boards 18c, 15, 14). */
export const RightSheet: Story = {
  render: () => (
    <Drawer defaultOpen>
      <DrawerTrigger asChild><Button variant="secondary" size="sm">Open drawer</Button></DrawerTrigger>
      <DrawerContent>
        <div className="border-b border-hairline px-4 py-3">
          <DrawerTitle className="text-[13px] font-semibold text-text-bright">Connect Claude</DrawerTitle>
          <DrawerDescription className="text-[12px] text-muted-foreground">Subscription or API key.</DrawerDescription>
        </div>
        <div className="flex-1 overflow-auto p-4 text-[12px] text-muted-foreground">Sheet body</div>
      </DrawerContent>
    </Drawer>
  )
}
