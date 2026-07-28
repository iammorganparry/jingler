import type { Meta, StoryObj } from "@storybook/react-vite"
import { jinglerDark, jinglerLight, toTokens } from "@jingler/themes"
import { ThemeProvider } from "../theme-provider.js"
import { BrandShader } from "../brand/brand-shader.js"
import { LoadingScreen } from "./loading-screen.js"

const meta: Meta<typeof LoadingScreen> = {
  title: "Loading",
  component: LoadingScreen,
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj<typeof LoadingScreen>

const DARK = toTokens(jinglerDark)
const LIGHT = toTokens(jinglerLight)

/**
 * The boot splash on the default ground.
 *
 * The page is painted the shader's own `colorBack` rather than `--sb-canvas`,
 * so the 360px tile has no visible edge. What you should see is ONE field of
 * colour with the mark burning in the middle of it — not a square sitting on a
 * backdrop.
 */
export const Boot: Story = {
  render: () => (
    <ThemeProvider tokens={DARK} activeId="jingler-dark">
      <div className="h-screen w-full">
        <LoadingScreen />
      </div>
    </ThemeProvider>
  )
}

/** The same splash on Jingler Light — near-white page, near-white tile. */
export const BootLight: Story = {
  render: () => (
    <ThemeProvider tokens={LIGHT} activeId="jingler-light">
      <div className="h-screen w-full">
        <LoadingScreen />
      </div>
    </ThemeProvider>
  )
}

/**
 * Both shader variants side by side, each on its own ground.
 *
 * Worth having as its own story because the light set is NOT the dark set on a
 * pale backdrop — `colorBack` is one end of the ramp the shader interpolates
 * through, so its noise, glow and contour all differ. Reviewing them apart is
 * how a change to one silently ships a regression in the other.
 *
 * The framed plates here are the one place a visible edge is useful: in the app
 * these two never appear together.
 */
export const Grounds: Story = {
  render: () => (
    <div className="flex h-screen w-full items-center justify-center gap-10 bg-canvas">
      <div className="flex flex-col items-center gap-3">
        <div className="p-6" style={{ background: "#000000" }}>
          <BrandShader ground="dark" size={260} />
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">dark · #000000</span>
      </div>
      <div className="flex flex-col items-center gap-3">
        <div className="p-6" style={{ background: "#f9f6f6" }}>
          <BrandShader ground="light" size={260} />
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">light · #f9f6f6</span>
      </div>
    </div>
  )
}
