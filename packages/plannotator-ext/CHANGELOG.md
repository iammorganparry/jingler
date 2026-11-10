# @jingler/plannotator-ext

## 0.26.1

## 0.26.0

## 0.25.0

## 0.24.1

## 0.24.0

## 0.23.1

## 0.23.0

## 0.22.5

## 0.22.4

## 0.22.3

## 0.22.2

## 0.22.1

## 0.22.0

## 0.21.2

## 0.21.1

## 0.21.0

## 0.20.3

## 0.20.2

## 0.20.1

## 0.20.0

## 0.19.0

## 0.18.1

## 0.18.0

## 0.17.3

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.0

## 0.15.1

## 0.15.0

## 0.14.1

## 0.14.0

## 0.13.1

## 0.13.0

## 0.12.4

## 0.12.3

## 0.12.2

## 0.12.1

## 0.12.0

## 0.11.3

## 0.11.2

## 0.11.1

## 0.11.0

## 0.10.1

## 0.10.0

## 0.9.3

## 0.9.2

## 0.9.1

## 0.9.0

## 0.8.0

## 0.7.3

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
