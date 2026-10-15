import type { Meta, StoryObj } from "@storybook/react-vite"
import { CommentComposer } from "./comment-composer.js"

/** Compare with Paper board 26d (issue view): composer under the thread. */
const meta: Meta = { title: "Molecules/CommentComposer" }
export default meta
type Story = StoryObj

const frame = (children: React.ReactNode) => <div className="w-[640px]">{children}</div>

export const Default: Story = { render: () => frame(<CommentComposer post={() => new Promise(() => {})} />) }
export const ClosedIssue: Story = { render: () => frame(<CommentComposer canClose={false} post={() => new Promise(() => {})} />) }
export const FailedPost: Story = {
  render: () => frame(<CommentComposer post={() => Promise.reject(new Error("GitHub could not post this comment."))} />),
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector("textarea")
    if (!box) return
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    set?.call(box, "Looking into it")
    box.dispatchEvent(new Event("input", { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    canvasElement.querySelector<HTMLButtonElement>("button:last-child")?.click()
  }
}
