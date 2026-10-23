import type { Meta, StoryObj } from "@storybook/react-vite"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js"

const meta: Meta = { title: "Atoms/Select" }
export default meta
type Story = StoryObj

const frame = "w-64 bg-panel p-4"

export const Default: Story = {
  render: () => (
    <div className={frame}>
      <Select defaultValue="b">
        <SelectTrigger aria-label="Model"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="b">Beta</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export const WithPlaceholder: Story = {
  render: () => (
    <div className={frame}>
      <Select>
        <SelectTrigger aria-label="Model"><SelectValue placeholder="Pick a model" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="b">Beta</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export const Disabled: Story = {
  render: () => (
    <div className={frame}>
      <Select disabled defaultValue="a">
        <SelectTrigger aria-label="Model"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export const LongList: Story = {
  render: () => (
    <div className={`${frame} h-80`}>
      <Select>
        <SelectTrigger aria-label="Model"><SelectValue placeholder="Pick a model" /></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 30 }, (_, i) => (
            <SelectItem key={i} value={`m${i}`}>{`Model ${i + 1}`}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
