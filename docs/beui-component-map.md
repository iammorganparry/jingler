# BeUI Motion and Agent component map

Snapshot: 2026-08-25 · Official registry: https://beui.dev/r · Agent guide: https://beui.dev/docs/ai-agents

Jingler carries the 15 Motion entries with production callers as reusable atoms/primitives and the 17 Agent entries as reusable molecules. Unused Motion atoms and the 22 BeUI Blocks are deliberately excluded. Imported ideas and adapted source remain MIT licensed; Jingler semantic tokens, existing renderers, and product behavior take precedence.

## Migration style rule

- Preserve each BeUI component's source structure, spacing, typography scale, motion, menu treatment, and interaction states.
- Preserve BeUI radii except for the product-wide Button rule: every Button size and variant uses Jingler's `rounded-lg` squircle instead of the registry's pill radius.
- Substitute only Jingler semantic color tokens and unavoidable local imports. Do not reskin BeUI to resemble the legacy Jingler component it replaces.
- Jingler keeps ownership of product layout, protocol behavior, provider identity, data flow, accessibility contracts, and reduced-motion support.
- When product behavior differs, compose around the BeUI component rather than copying the old component's visual treatment into it.
- Composer uses Prompt Input as its base and the same BeUI Select treatment for model, environment, permission, and reasoning; the model dropdown adds only a compact search field and Jingler model metadata.

## Production ownership

| Public compatibility path | BeUI owner |
|---|---|
| `components/button.tsx` | BeUI Button press, hover, ripple, sizes, and variants; Jingler squircle radius |
| `components/input.tsx` | BeUI Input field geometry and states |
| `components/checkbox.tsx` | BeUI Checkbox draw animation and press feedback |
| `components/toggle.tsx` | BeUI Switch heavy-thumb motion |
| `components/segmented-control.tsx` | BeUI Tabs `segment` variant |
| `components/loading.tsx` | BeUI Loader and BeUI loading shimmer |
| `components/badge.tsx` | BeUI Animated Badge |
| `components/tooltip.tsx` | BeUI Tooltip portal, gestures, and motion |
| `components/chip-menu.tsx` | BeUI Morph Popover plus product-owned Command filtering |
| `components/dialog.tsx` | BeUI center-unfold presentation plus Radix focus ownership |

Compatibility files remain only where callers rely on an established product API; their rendering is BeUI-owned. Provider marks, command filtering, renderer adapters, file/diff UI, and product status components remain Jingler-owned behavior.

## Dependency policy

- Already installed: Motion 12, React 19, Tailwind 4, Lucide, Shiki, TanStack Virtual, Paper shaders, clsx, and tailwind-merge.
- Replaced with native/existing Jingler behavior: `next-themes`, `lenis`, and `ai`; these are not added.
- Existing component collisions are merged or wrapped rather than duplicated.

## Motion atoms (15)

| Component | Slug/source | Registry dependencies | Jingler destination / decision |
|---|---|---|---|
| Button | [`button`](https://beui.dev/r/button) | lucide-react, motion | Merge with `components/button.tsx` |
| Tabs | [`tabs`](https://beui.dev/r/tabs) | motion | Export `Tabs` from `components/beui` |
| Switch | [`switch`](https://beui.dev/r/switch) | motion | Export `Switch` from `components/beui` |
| Input | [`input`](https://beui.dev/r/input) | lucide-react, motion | Merge with `components/input.tsx` |
| Select | [`select`](https://beui.dev/r/select) | lucide-react, motion | Merge with `components/select.tsx` |
| Checkbox | [`checkbox`](https://beui.dev/r/checkbox) | motion | Merge with `components/checkbox.tsx` |
| Shared Layout Background | [`shared-layout-bg`](https://beui.dev/r/shared-layout-bg) | lucide-react, motion | Export `SharedLayoutBg` from `components/beui` |
| Preview Rail | [`preview-rail`](https://beui.dev/r/preview-rail) | motion | Export `PreviewRail` from `components/beui` |
| Dock | [`dock`](https://beui.dev/r/dock) | lucide-react, motion | Export `Dock` from `components/beui` |
| Tooltip | [`tooltip`](https://beui.dev/r/tooltip) | lucide-react, motion | Merge with `components/tooltip.tsx` |
| Animated Context Menu | [`context-menu`](https://beui.dev/r/context-menu) | lucide-react, motion | Merge with `components/context-menu.tsx` |
| Popover | [`popover`](https://beui.dev/r/popover) | lucide-react, motion | Use `MorphPopover`; legacy Radix atom deleted |
| Animated Badge | [`animated-badge`](https://beui.dev/r/animated-badge) | lucide-react, motion | Export `AnimatedBadge` from `components/beui` |
| Action Swap | [`action-swap`](https://beui.dev/r/action-swap) | lucide-react, motion | Export `ActionSwap` from `components/beui` |
| Loader | [`loader`](https://beui.dev/r/loader) | motion | Export `Loader` from `components/beui` |


## Agent molecules (17)

| Component | Slug/source | Registry dependencies | Jingler destination / decision |
|---|---|---|---|
| Message Bubble | [`message-bubble`](https://beui.dev/r/message-bubble) | lucide-react, motion | Add generic molecule; compose into Message |
| Message | [`message`](https://beui.dev/r/message) | lucide-react, motion | Add generic row primitives; adapt MessageTurn presentation |
| Message Scroller | [`message-scroller`](https://beui.dev/r/message-scroller) | lucide-react, motion | Add generic reader-aware viewport; integrate into ConversationView |
| Prompt Input | [`prompt-input`](https://beui.dev/r/prompt-input) | lucide-react, motion | Add generic composer primitives; compose into Composer |
| Todo List | [`todo-list`](https://beui.dev/r/todo-list) | lucide-react, motion | Add generic task list; compose into plan progress |
| Code Block | [`code-block`](https://beui.dev/r/code-block) | ai, lucide-react, motion, shiki | Wrap existing Markdown/Shiki rendering |
| Approval Card | [`approval-card`](https://beui.dev/r/approval-card) | lucide-react, motion | Add generic question/review surface; compose existing plan/question cards |
| File Diff | [`file-diff`](https://beui.dev/r/file-diff) | lucide-react, motion, shiki | Wrap existing Pierre/diff presentation |
| Tool Result | [`tool-result`](https://beui.dev/r/tool-result) | lucide-react, motion, shiki | Add generic disclosure; compose ToolCall |
| Streaming Response | [`streaming-response`](https://beui.dev/r/streaming-response) | lucide-react, motion | Compose existing Markdown streaming renderer |
| Image Generation | [`image-generation`](https://beui.dev/r/image-generation) | lucide-react, motion | Add stable progressive image surface |
| Tool Approval | [`tool-approval`](https://beui.dev/r/tool-approval) | lucide-react, motion, shiki | Add generic permission surface; compose ApprovalGate |
| Citations | [`citations`](https://beui.dev/r/citations) | lucide-react, motion | Add structured citation primitives; protocol integration deferred until citation data exists |
| Agent Activity | [`agent-activity`](https://beui.dev/r/agent-activity) | lucide-react, motion | Add generic activity stream; compose tools/reasoning/loading |
| Agent Loading States | [`loading-states`](https://beui.dev/r/loading-states) | motion | Add generic shimmer/progress/reasoning states using Loader |
| AI Sidebar | [`ai-sidebar`](https://beui.dev/r/ai-sidebar) | lucide-react, motion | Add generic tree/rail primitives; reuse session sidebar semantics |
| Chat App | [`chat-app`](https://beui.dev/r/chat-app) | lucide-react, motion, shiki | Add catalog composition reference; do not replace JinglerApp |

## Product mapping

| Experience | New reusable molecule | Existing product owner |
|---|---|---|
| Transcript follow and reader release | `MessageScroller` | `app/conversation-view.tsx` |
| Prompt, model, action, send/stop | `PromptInput*` | `composites/composer.tsx` |
| Tasks and plans | `AgentTodoList` | plan progress and plan step components |
| Tool and reasoning timeline | `AgentActivity`, `ToolResult` | `message-turn.tsx`, `tool-call.tsx`, `thought-block.tsx` |
| Human decisions | `ApprovalCard`, `ToolApproval` | approval, question, and plan cards |
| Code and diffs | `AgentCodeBlock`, `AgentFileDiff` | Markdown/Shiki and Pierre diff renderers |

## Deliberate limits

- Blocks are outside the approved catalog scope.
- Chat App is a composition example, not a second application shell.
- Smooth-scroll providers are not installed because they conflict with transcript live-edge ownership.
- Structured citations remain reusable UI until the core protocol supplies citation metadata.
- Mobile gestures remain available in the catalog but are not forced into desktop product flows.
