---
"@jingler/cli-adapters": minor
"@jingler/contracts": minor
"@jingler/core": minor
"@jingler/desktop": minor
"@jingler/ui": minor
---

Notion-like plan workspace — the plan PRD becomes an editable, live document.

- **Flow diagrams render.** A fenced ` ```mermaid ` block in a plan (or any agent
  markdown) now renders as a themed, sandboxed SVG diagram instead of a grey code
  block — lazy-loaded, `securityLevel: strict`, with an inline error card for a
  broken diagram so one bad fence never blanks the doc.
- **Inline (WYSIWYG) editing.** A new **Edit** mode renders section bodies as
  in-place rich-text editors (Tiptap) that read from and serialize back to
  markdown; edits splice into the authoritative MDX via a surgical section
  rewriter and save through the existing conflict-safe machinery. The
  Source/Rendered/Split modes are unchanged.
- **Comment on a highlighted span.** Plan annotations can now carry a W3C-style
  TextQuote anchor (quote + context), threaded end-to-end (parse, serialize,
  persist, RPC) with a resolver that re-anchors robustly and flags orphaned
  comments. Open comments are still batched to the agent in one revision by
  `Agent.revisePlan`.
- **Live document.** The renderer subscribes to a streaming `Plan.watch` RPC
  instead of polling — the agent's writes and external edits to
  `current-plan.mdx` reach an open editor in about a second.
