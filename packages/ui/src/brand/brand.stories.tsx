import type { Meta, StoryObj } from "@storybook/react-vite"
import { BrandShader } from "./brand-shader.js"
import { JinglerMark, JinglerWordmark } from "./jingler-mark.js"

/**
 * The brand, rendered live rather than described.
 *
 * A swatch table written as literal hexes goes stale the moment a token moves,
 * and does so silently — which is the exact failure mode the whole `--sb-*`
 * indirection exists to prevent. Everything here reads the CSS custom
 * properties at render time, so it documents whatever theme is actually
 * applied. Switch themes in Storybook and this page follows.
 *
 * The written rules live in `docs/brand.md`.
 */
const meta: Meta = { title: "Brand", parameters: { layout: "fullscreen" } }
export default meta

const SURFACES = ["canvas", "sunken", "panel", "editor", "surface"] as const
const LINES = ["border", "line", "line-strong"] as const
const TEXT = ["text-bright", "text-body", "text", "muted", "dim"] as const
const ACCENTS = ["blue", "green", "yellow", "red", "purple", "cyan", "orange"] as const
const BRAND = ["brand", "brand-hover"] as const

function Swatch({ token }: { token: string }) {
  return (
    <div className="flex w-[104px] flex-col gap-1.5">
      <div
        className="h-12 w-full rounded-md border border-line"
        style={{ background: `var(--sb-${token})` }}
      />
      <span className="font-mono text-[10px] leading-tight text-muted-foreground">--sb-{token}</span>
    </div>
  )
}

function Row({ title, tokens, note }: { title: string; tokens: readonly string[]; note?: string }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] font-semibold text-text-bright">{title}</h2>
        {note ? <p className="max-w-[560px] text-[11.5px] leading-snug text-muted-foreground">{note}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2.5">
        {tokens.map((t) => (
          <Swatch key={t} token={t} />
        ))}
      </div>
    </section>
  )
}

export const Palette: StoryObj = {
  render: () => (
    <div className="flex min-h-screen flex-col gap-9 bg-canvas px-10 py-9 font-sans">
      <JinglerWordmark className="text-[19px]" />
      <Row
        title="Surfaces"
        tokens={SURFACES}
        note="Warm-neutral greys stepping off #212121, the wordmark's own colour. Never hue-shifted toward the brand — a red-washed editor is unreadable over a long session."
      />
      <Row title="Lines" tokens={LINES} />
      <Row title="Text ramp" tokens={TEXT} note="Loudest to quietest. muted and dim are exempt from the 4.5:1 bar on purpose: they exist to recede." />
      <Row
        title="Accents"
        tokens={ACCENTS}
        note="Seven hues, deliberately. The brand is one colour; syntax highlighting needs a spectrum."
      />
      <Row
        title="Brand"
        tokens={BRAND}
        note="Primary buttons, focus rings, links, active tabs. NOT the same token as --sb-red, which is destructive — collapsing them would make 'Delete session' and 'New session' the same swatch."
      />
    </div>
  )
}

export const Mark: StoryObj = {
  render: () => (
    <div className="flex min-h-screen flex-col gap-10 bg-canvas px-10 py-9 font-sans">
      <section className="flex flex-col gap-4">
        <h2 className="text-[13px] font-semibold text-text-bright">The mark inherits</h2>
        <p className="max-w-[560px] text-[11.5px] leading-snug text-muted-foreground">
          One path, painted with <code className="font-mono">currentColor</code>. There is no
          second asset for light grounds and no white variant to keep in sync.
        </p>
        <div className="flex items-end gap-8">
          {["text-brand", "text-text-bright", "text-blue", "text-dim"].map((tone) => (
            <div key={tone} className="flex flex-col items-center gap-2">
              <JinglerMark className={`h-12 w-auto ${tone}`} />
              <span className="font-mono text-[10px] text-muted-foreground">{tone}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[13px] font-semibold text-text-bright">Lockup, at three sizes</h2>
        <div className="flex flex-col items-start gap-4">
          <JinglerWordmark className="text-[13px]" />
          <JinglerWordmark className="text-[19px]" />
          <JinglerWordmark className="text-[30px]" />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[13px] font-semibold text-text-bright">Animated, both grounds</h2>
        <p className="max-w-[560px] text-[11.5px] leading-snug text-muted-foreground">
          The light set is much fainter by design. Raising <code className="font-mono">contour</code>{" "}
          to compensate makes it render blank — the mark folds into the near-white ground. Raise{" "}
          <code className="font-mono">innerGlow</code> instead.
        </p>
        <div className="flex gap-5">
          <BrandShader ground="dark" size={220} />
          <BrandShader ground="light" size={220} />
        </div>
      </section>
    </div>
  )
}
