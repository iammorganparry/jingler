import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { Textarea } from "./textarea.js"

const meta: Meta = { title: "Atoms/Textarea" }
export default meta
type Story = StoryObj

function Field({ initial = "", disabled = false }: { initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <div className="w-[480px]">
      <Textarea aria-label="Comment" placeholder="Leave a comment…" value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)} />
    </div>
  )
}

export const Empty: Story = { render: () => <Field /> }
export const Filled: Story = { render: () => <Field initial={"Looking into it.\nWill follow up."} /> }
export const Disabled: Story = { render: () => <Field initial="Posting…" disabled /> }
