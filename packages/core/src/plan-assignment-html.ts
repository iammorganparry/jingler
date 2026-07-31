import type { HTMLElement } from "node-html-parser"
import type { ReasoningSetting } from "./domain.js"

/** Write the canonical reasoning attributes for a plan worker assignment. */
export const writePlanAssignmentReasoningAttributes = (
  element: HTMLElement,
  reasoning: ReasoningSetting | undefined
): void => {
  if (reasoning === undefined) {
    element.removeAttribute("data-thinking-enabled")
    element.removeAttribute("data-reasoning-effort")
    return
  }
  element.setAttribute("data-thinking-enabled", String(reasoning.enabled))
  if (reasoning.effort === undefined) {
    element.removeAttribute("data-reasoning-effort")
  } else {
    element.setAttribute("data-reasoning-effort", reasoning.effort)
  }
}
