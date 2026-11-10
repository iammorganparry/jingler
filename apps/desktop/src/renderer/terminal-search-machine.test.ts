import { createActor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { terminalSearchMachine, terminalSearchCount } from "./terminal-search-machine.js"

describe("terminal Find state", () => {
  it("searches the new literal query and refocuses an already open search", () => {
    const search = vi.fn()
    const next = vi.fn()
    const previous = vi.fn()
    const actor = createActor(terminalSearchMachine.provide({ actions: { search: ({ context }) => search(context.query), next, previous } })).start()
    actor.send({ type: "OPEN", query: "error+[socket]" })
    expect(search).toHaveBeenLastCalledWith("error+[socket]")
    actor.send({ type: "RESULTS", resultIndex: 1, resultCount: 3 })
    expect(terminalSearchCount(actor.getSnapshot().context)).toBe("2 of 3")
    actor.send({ type: "NEXT" })
    actor.send({ type: "PREVIOUS" })
    expect(next).toHaveBeenCalledOnce()
    expect(previous).toHaveBeenCalledOnce()
    actor.send({ type: "CHANGE", query: "replacement" })
    expect(search).toHaveBeenLastCalledWith("replacement")
    expect(actor.getSnapshot().context.resultCount).toBe(0)
    const revision = actor.getSnapshot().context.focusRevision
    actor.send({ type: "OPEN" })
    expect(actor.getSnapshot().context).toMatchObject({ query: "replacement", focusRevision: revision + 1 })
    actor.stop()
  })

  it("ignores late results and preserves the query when closed or hidden, without stealing focus on hide", () => {
    const focusTerminal = vi.fn()
    const clear = vi.fn()
    const actor = createActor(terminalSearchMachine.provide({ actions: { focusTerminal, clear } })).start()
    actor.send({ type: "OPEN", query: "needle" })
    actor.send({ type: "HIDE" })
    actor.send({ type: "RESULTS", resultIndex: 2, resultCount: 3 })
    expect(actor.getSnapshot().matches("closed")).toBe(true)
    expect(actor.getSnapshot().context).toMatchObject({ query: "needle", resultCount: 0 })
    expect(focusTerminal).not.toHaveBeenCalled()
    actor.send({ type: "OPEN" })
    actor.send({ type: "CLOSE" })
    expect(focusTerminal).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledTimes(2)
    actor.send({ type: "RESET" })
    expect(actor.getSnapshot().context.query).toBe("")
    actor.stop()
  })

  it("does not invent an active match number when the addon stops tracking individual matches", () => {
    expect(terminalSearchCount({ resultIndex: -1, resultCount: 0 })).toBe("No matches")
    expect(terminalSearchCount({ resultIndex: -1, resultCount: 1_000 })).toBe("1000+ matches")
  })
})
