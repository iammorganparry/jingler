import type { Meta, StoryObj } from "@storybook/react-vite"
import { ASSET_SIZE_CAP, type AssetPayload } from "@jingler/core"
import { jinglerDark, toTokens } from "@jingler/themes"
import { PierreProvider } from "../diff/pierre-provider.js"
import { AssetError, AssetLoading, AssetTooLarge, AssetUnsupported, AssetView } from "./asset-view.js"

const meta: Meta<typeof AssetView> = {
  title: "Asset/AssetView",
  component: AssetView,
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj<typeof AssetView>

/** Every story renders inside a fixed dock-sized frame. */
const Frame = ({ children }: { children: React.ReactNode }) => (
  <PierreProvider tokens={toTokens(jinglerDark)} workers={false}>
    <div className="h-[520px] w-[640px] overflow-hidden rounded-lg border border-line">{children}</div>
  </PierreProvider>
)

const base = { path: "report.md", absolutePath: "/tmp/report.md", size: 1024 }

export const MarkdownDoc: Story = {
  render: () => {
    const payload: AssetPayload = {
      ...base,
      kind: "markdown",
      language: null,
      text: "# Weekly report\n\nAll **green**. A table:\n\n| metric | value |\n| --- | --- |\n| uptime | 99.9% |\n\n```ts\nconst x: number = 1\n```\n"
    }
    return (
      <Frame>
        <AssetView payload={payload} />
      </Frame>
    )
  }
}

export const Code: Story = {
  render: () => {
    const text = Array.from({ length: 40 }, (_, i) => `export const value${i} = compute(${i}) // line ${i}`).join(
      "\n"
    )
    const payload: AssetPayload = {
      ...base,
      path: "src/values.ts",
      absolutePath: "/tmp/values.ts",
      kind: "code",
      language: "typescript",
      text
    }
    return (
      <Frame>
        <AssetView payload={payload} />
      </Frame>
    )
  }
}

export const PlainText: Story = {
  render: () => {
    const payload: AssetPayload = {
      ...base,
      path: "run.log",
      absolutePath: "/tmp/run.log",
      kind: "text",
      language: null,
      text: "boot ok\nconnecting…\nready\n"
    }
    return (
      <Frame>
        <AssetView payload={payload} />
      </Frame>
    )
  }
}

export const Csv: Story = {
  render: () => {
    // 5k rows proves virtualization: this mounts a handful of rows, not 5k.
    const header = "id,name,email,score"
    const body = Array.from(
      { length: 5000 },
      (_, i) => `${i},"Person, ${i}",person${i}@example.com,${(i % 100) + 1}`
    ).join("\n")
    const payload: AssetPayload = {
      ...base,
      path: "people.csv",
      absolutePath: "/tmp/people.csv",
      kind: "csv",
      language: null,
      text: `${header}\n${body}`
    }
    return (
      <Frame>
        <AssetView payload={payload} />
      </Frame>
    )
  }
}

/** A 1×1 transparent PNG — small enough to inline as a data URL. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

export const Image: Story = {
  render: () => {
    const payload: AssetPayload = {
      path: "pixel.png",
      absolutePath: "/tmp/pixel.png",
      size: 68,
      kind: "image",
      mediaType: "image/png",
      base64: PNG_1PX
    }
    return (
      <Frame>
        <AssetView payload={payload} />
      </Frame>
    )
  }
}

export const Pdf: Story = {
  render: () => {
    const payload: AssetPayload = {
      path: "invoice.pdf",
      absolutePath: "/tmp/invoice.pdf",
      size: 4096,
      kind: "pdf"
    }
    return (
      <Frame>
        <AssetView payload={payload} />
      </Frame>
    )
  }
}

export const Loading: Story = {
  render: () => (
    <Frame>
      <AssetLoading />
    </Frame>
  )
}

export const TooLarge: Story = {
  render: () => (
    <Frame>
      <AssetTooLarge
        path="huge.log"
        size={44_123_456}
        cap={ASSET_SIZE_CAP.text}
        onReveal={() => {}}
      />
    </Frame>
  )
}

export const Unsupported: Story = {
  render: () => (
    <Frame>
      <AssetUnsupported path="archive.zip" onReveal={() => {}} />
    </Frame>
  )
}

export const ReadError: Story = {
  render: () => (
    <Frame>
      <AssetError message="ENOENT: the file was moved or deleted." onReveal={() => {}} />
    </Frame>
  )
}
