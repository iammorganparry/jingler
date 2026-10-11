import type { Meta, StoryObj } from "@storybook/react-vite"
import { BrandShader } from "../brand/brand-shader.js"
import { LoadingScreen } from "./loading-screen.js"

const meta: Meta<typeof LoadingScreen> = {
  title: "Loading",
  component: LoadingScreen,
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj<typeof LoadingScreen>

/**
 * The boot splash on the default ground.
 *
 * The page is painted the shader's own `colorBack` rather than `--sb-canvas`,
 * so the 360px tile has no visible edge. What you should see is ONE field of
 * colour with the mark burning in the middle of it — not a square sitting on a
 * backdrop.
 *
 * Pinned with `globals.theme`, NOT a `ThemeProvider` inside the story: the
 * preview decorator already mounts one, both write the same `<style
 * id="jingler-theme">`, and React runs the child's layout effect first — so a
 * nested provider's sheet is written then overwritten by the toolbar theme, and
 * `LoadingScreen`'s status text and bar (which read `--sb-*`) would render in
 * the wrong ground. `app.stories.tsx` documents the same trap at length.
 */
export const Boot: Story = {
  globals: { theme: "jingler-dark" },
  render: () => (
    <div className="h-screen w-full">
      <LoadingScreen />
    </div>
  )
}

/** The same splash on Jingler Light — near-white page, near-white tile. */
export const BootLight: Story = {
  globals: { theme: "jingler-light" },
  render: () => (
    <div className="h-screen w-full">
      <LoadingScreen />
    </div>
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
