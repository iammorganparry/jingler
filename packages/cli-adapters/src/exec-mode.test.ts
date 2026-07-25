import { describe, expect, it } from "vitest"
import { FALLBACK_EXEC_MODE, modeOnApproval, modeToRestore } from "./exec-mode.js"

/**
 * The plan-mode detour, both ends of it.
 *
 * Each of these rules is here because it was once wrong in a way that was
 * invisible until an operator approved a plan and found every command asking for
 * permission again. Reaching them through `AgentRunner` needs a scripted plan
 * proposal and an approval; as a table they are six lines.
 */

describe("modeToRestore", () => {
  it("remembers what the chat was actually running in", () => {
    expect(modeToRestore("auto", "accept-edits")).toBe("auto")
    expect(modeToRestore("ask", "accept-edits")).toBe("ask")
  })

  it("never remembers plan mode itself", () => {
    // Re-entering plan mode from plan mode would otherwise record "plan" as the
    // thing to restore, and approval would leave the chat unable to execute what
    // it had just approved.
    expect(modeToRestore("plan", "auto")).toBe("auto")
  })

  it("falls back to the harness config default, then to a safe floor", () => {
    // A session started directly in plan mode has no current mode to remember.
    expect(modeToRestore(undefined, "auto")).toBe("auto")
    expect(modeToRestore(undefined, undefined)).toBe(FALLBACK_EXEC_MODE)
    expect(modeToRestore("plan", undefined)).toBe(FALLBACK_EXEC_MODE)
  })
})

describe("modeOnApproval", () => {
  it("honours an explicit choice above everything", () => {
    expect(
      modeOnApproval({ explicit: "ask", prior: "auto", configDefault: "accept-edits" })
    ).toBe("ask")
  })

  it("puts the operator's session intent ABOVE the config default", () => {
    // The precedence that was once inverted. `configDefault` is "accept-edits" for
    // anyone who never set one, so letting it win silently overrides the "auto" the
    // operator picked in the composer — re-gating every command of the execution
    // they just approved.
    expect(modeOnApproval({ prior: "auto", configDefault: "accept-edits" })).toBe("auto")
  })

  it("uses the config default when there is no prior", () => {
    expect(modeOnApproval({ configDefault: "ask" })).toBe("ask")
  })

  it("falls back to a safe floor when nothing is known", () => {
    expect(modeOnApproval({})).toBe(FALLBACK_EXEC_MODE)
  })
})
