import type { Meta, StoryObj } from "@storybook/react-vite"
import { Avatar, AvatarStack } from "./avatar.js"

const meta: Meta = { title: "Atoms/Avatar" }
export default meta
type Story = StoryObj

const SIZES = [16, 20, 24, 32] as const

/** Compare with Paper board 17a (plan comment avatars): 20px, agent = mono Jingler mark, count badge on threads with replies. */
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4 p-6">
      {SIZES.map((size) => (
        <div key={size} className="flex items-center gap-4">
          <span className="w-8 font-mono text-[11px] text-dim">{size}</span>
          <Avatar initial="MP" label="Morgan Parry" size={size} />
          <Avatar initial="MP" label="Morgan Parry" size={size} src="/__broken.png" />
          <Avatar initial="J" agent label="Jingler" size={size} />
          <Avatar initial="MP" label="Morgan Parry" size={size} count={3} />
          <Avatar initial="J" agent label="Jingler" size={size} count={12} onClick={() => undefined} />
        </div>
      ))}
    </div>
  )
}

export const Stack: Story = {
  render: () => (
    <div className="flex flex-col gap-4 p-6">
      <AvatarStack>
        <Avatar initial="MP" label="Morgan Parry" />
        <Avatar initial="J" agent label="Jingler" />
        <Avatar initial="AB" tone="orange" label="Alex B" />
      </AvatarStack>
      <AvatarStack max={3}>
        {["MP", "AB", "CD", "EF", "GH"].map((i) => (
          <Avatar key={i} initial={i} label={i} />
        ))}
      </AvatarStack>
    </div>
  )
}
