# @jingler/plannotator-ext

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

### Minor Changes

- eb82608: Fork Plannotator into `packages/plannotator-ext` and make the plan a first-class, always-available scratchpad. The plan tools now ride in every permission mode: `plannotator_update_plan` adopts or refreshes the Markdown plan silently, and `plannotator_submit_plan` opens operator review when the agent judges a change needs sign-off. Reviews are decided natively — the Plan tab mounts Jingler's own PlanReview document editor and sends the verdict over a `Plan.decide` RPC onto the session's event bus; the embedded review webview, its loopback HTTP server, and the 21MB SPA bundle are gone. Plans are structured Markdown (stages, nested tasks with in-progress/blocked marks, acceptance criteria with test references, file plans, complexity/dependency metadata, mermaid diagrams) parsed into a rich native document, the Plan tab persists for as long as a plan exists, and checklist progress ticks live during execution in any mode.
- 2d669cd: Add explicit Settled sessions, compact final reconciliation file lists, deterministic structured plan stages, and plan-mode submit tool visibility.
