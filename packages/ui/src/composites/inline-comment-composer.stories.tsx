import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { InlineCommentComposer } from "./inline-comment-composer.js"

/**
 * The composer as it actually appears in Code Review: anchored directly
 * under the selected line range, not floating or offset.
 */
const meta: Meta = {
  title: "Changes review/InlineCommentComposer",
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj

const code = [
  "export async function refresh(session: Session) {",
  "  for (let attempt = 0; ; attempt += 1) {",
  "    const token = await fetchToken(session.refreshToken)",
  "    if (token.ok) return (session.token = token.value)",
  "  }",
  "}"
]

function AnchoredUnderSelection() {
  const [body, setBody] = useState("")
  return (
    <div className="flex h-screen flex-col bg-canvas p-6">
      <div className="mx-auto w-full max-w-[640px] overflow-hidden rounded-lg border border-line bg-editor font-mono text-[12.5px]">
        {code.map((line, index) => (
          <div
            key={line}
            className={index === 2 || index === 3 ? "bg-blue/10 px-3 py-1 text-text-body" : "px-3 py-1 text-text-body"}
          >
            {line}
          </div>
        ))}
        <div className="px-3 py-3">
          <InlineCommentComposer
            path="src/auth/refresh.ts"
            startLine={3}
            endLine={4}
            routeTargetSession="Session 1"
            initialBody={body}
            onCancel={() => setBody("")}
            onAddToReview={() => {}}
            onCommentAndSend={() => {}}
          />
        </div>
      </div>
    </div>
  )
}

/** Selecting lines 3–4 opens the composer immediately under them, not floating elsewhere. */
export const AnchoredUnderSelectedRange: Story = { render: () => <AnchoredUnderSelection /> }
