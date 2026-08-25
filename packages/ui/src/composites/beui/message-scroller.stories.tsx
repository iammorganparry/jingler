import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Bot, Check, FileSearch, Wrench } from "lucide-react"
import { Eyebrow } from "../../components/eyebrow.js"
import { MessageScroller } from "./messages.js"
import { StreamingText } from "../streaming-text.js"
import { ThoughtBlock } from "../thought-block.js"
import { ToolCall } from "../tool-call.js"

const meta: Meta = {
  title: "Review/Message Scroller",
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj

function Transcript() {
  return (
    <div className="flex flex-col gap-5 px-[30px] py-[26px]">
      <Turn label="You">
        Keep the transcript readable while the agent streams. Don&apos;t pull me back down when I scroll up.
      </Turn>
      <Turn label="Claude" assistant>
        <ThoughtBlock seconds={4}>I need to preserve the current reading position and only follow while the reader stays at the live edge.</ThoughtBlock>
        <ToolCall status="success" name="Read" target="conversation-view.tsx" meta="742 lines" icon={<FileSearch className="size-3 text-dim" />} />
        <StreamingText text="The current transcript follows output while you remain at the bottom. Scrolling upward releases it, so incoming tokens don’t steal your place." streaming={false} />
      </Turn>
      <Turn label="You">What happens when I want to catch up?</Turn>
      <Turn label="Claude" assistant>
        <ToolCall status="success" name="Test" target="message-scroller" meta="3 passed" icon={<Check className="size-3 text-green" />} />
        <StreamingText text="Hover the right-edge ticks to preview a destination. Select one to center that message; the last point returns to the live edge." streaming={false} />
      </Turn>
      <Turn label="You">Keep the affordance quiet. This is a coding tool, not a chat toy.</Turn>
      <Turn label="Claude" assistant>
        <ToolCall status="running" name="Storybook" target="Message Scroller comparison" icon={<Wrench className="size-3 text-yellow" />} />
        <StreamingText text="Agreed. The compact ticks expand into the same hover pyramid as BeUI and reveal the destination preview without changing the transcript." streaming />
      </Turn>
    </div>
  )
}

function Turn({ label, assistant = false, children }: { label: string; assistant?: boolean; children: React.ReactNode }) {
  return (
    <section data-slot="message" data-from={assistant ? "assistant" : "user"} className="flex flex-col gap-3">
      <Eyebrow icon={assistant ? <Bot className="size-3" /> : undefined}>{label}</Eyebrow>
      {typeof children === "string" ? <p className="m-0 whitespace-pre-wrap text-[14.5px] leading-[1.65] text-text-body">{children}</p> : children}
    </section>
  )
}

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-editor shadow-xl">
      <header className="flex-none border-b border-line bg-panel px-4 py-3">
        <h2 className="text-[13px] font-semibold text-text-bright">{title}</h2>
        <p className="mt-0.5 text-[10.5px] text-dim">{note}</p>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}

function Comparison() {
  const [proposedKey, setProposedKey] = useState(0)
  return (
    <main className="flex h-screen min-h-[640px] flex-col gap-4 overflow-hidden bg-canvas p-5 text-text">
      <header className="mx-auto flex w-full max-w-[1120px] items-end gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">Single-component review</div>
          <h1 className="mt-1 text-[18px] font-semibold text-text-bright">Message Scroller</h1>
          <p className="mt-1 max-w-2xl text-[12px] text-muted-foreground">Same transcript. The proposal changes only what happens when the reader leaves the live edge.</p>
        </div>
        <button type="button" onClick={() => setProposedKey(value => value + 1)} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[11px] text-text hover:bg-surface">Reset proposed view</button>
      </header>
      <div className="mx-auto grid h-[680px] min-h-0 w-full max-w-[1120px] flex-none grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Current Jingler" note="Native transcript scroll; no extra chrome.">
          <div aria-label="Current conversation" className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
            <Transcript />
          </div>
        </Panel>
        <Panel title="Proposed" note="Reader state + one recovery action. Messages are unchanged.">
          <MessageScroller key={proposedKey} followOutput={false} smooth={false} navigation="rail" className="h-full" viewportClassName="h-full [scrollbar-gutter:stable_both-edges]">
            <Transcript />
          </MessageScroller>
        </Panel>
      </div>
    </main>
  )
}

export const CurrentVsProposed: Story = { render: () => <Comparison /> }
