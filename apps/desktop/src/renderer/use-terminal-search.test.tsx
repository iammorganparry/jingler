// @vitest-environment jsdom
import { useRef } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TerminalPalette } from "@jingler/core"
import { jinglerDark, jinglerLight, toTokens } from "@jingler/themes"
import { TerminalFind } from "@jingler/ui"
import type { SearchAddon, ISearchOptions, ISearchResultChangeEvent } from "@xterm/addon-search"
import type { ITerminalAddon } from "@xterm/xterm"
import { useTerminalSearch, type TerminalSearchHost } from "./use-terminal-search.js"

/** Exercise the hook through xterm's public contracts; real matching is covered by the PTY Electron specs. */
class TestSearchAddon implements SearchAddon {
  results: ISearchResultChangeEvent = { resultIndex: 0, resultCount: 3 }
  private listener: ((results: ISearchResultChangeEvent) => void) | undefined
  activate() {}
  clearActiveDecoration() {}
  clearDecorations = vi.fn()
  dispose = vi.fn(() => { this.listener = undefined })
  findNext = vi.fn((_query: string, _options?: ISearchOptions) => {
    this.listener?.(this.results)
    return this.results.resultCount > 0
  })
  findPrevious = vi.fn((_query: string, _options?: ISearchOptions) => true)
  onDidChangeResults: SearchAddon["onDidChangeResults"] = (listener) => {
    this.listener = listener
    return { dispose: () => { if (this.listener === listener) this.listener = undefined } }
  }
  get listening() { return this.listener !== undefined }
}

class TestTerminal implements TerminalSearchHost {
  selection = ""
  focus = vi.fn()
  loadAddon = vi.fn<(_addon: ITerminalAddon) => void>()
  getSelection() { return this.selection }
}

const dark = toTokens(jinglerDark).terminal
const light = toTokens(jinglerLight).terminal

interface PreviewProps {
  readonly term: TerminalSearchHost
  readonly createSearch: () => SearchAddon
  readonly active?: boolean
  readonly palette?: TerminalPalette
}

function Preview({ term, createSearch, active = true, palette = dark }: PreviewProps) {
  const root = useRef<HTMLDivElement>(null)
  const search = useTerminalSearch(term, active, palette, root, createSearch)
  return <div ref={root} data-testid="terminal-host">
    <textarea aria-label="Shell input" />
    {search.open && <TerminalFind ref={search.inputRef} query={search.query} count={search.count} onChange={search.change} />}
  </div>
}

const findInput = () => screen.getByPlaceholderText<HTMLInputElement>("Find in terminal…")
const openFind = () => fireEvent.keyDown(screen.getByTestId("terminal-host"), { key: "f", metaKey: true })
afterEach(cleanup)

describe("terminal Find integration", () => {
  it("captures Find, searches literally, navigates and returns focus on Escape", () => {
    const term = new TestTerminal()
    const addon = new TestSearchAddon()
    const createSearch = vi.fn(() => addon)
    const globalKey = vi.fn()
    window.addEventListener("keydown", globalKey)
    try {
      render(<Preview term={term} createSearch={createSearch} />)
      openFind()
      const input = findInput()
      expect(document.activeElement).toBe(input)
      expect(globalKey).not.toHaveBeenCalled()
      fireEvent.change(input, { target: { value: "error+[socket]" } })
      expect(addon.findNext).toHaveBeenLastCalledWith("error+[socket]", expect.objectContaining({ regex: false, incremental: true }))
      expect(screen.getByRole("status").textContent).toBe("1 of 3")
      expect(fireEvent.keyDown(screen.getByRole("button", { name: "Clear" }), { key: "Enter" })).toBe(true)
      fireEvent.keyDown(input, { key: "Enter" })
      expect(addon.findNext).toHaveBeenLastCalledWith("error+[socket]", expect.objectContaining({ incremental: false }))
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
      expect(addon.findPrevious).toHaveBeenCalledWith("error+[socket]", expect.anything())
      fireEvent.keyDown(input, { key: "Escape" })
      expect(screen.queryByPlaceholderText("Find in terminal…")).toBeNull()
      expect(term.focus).toHaveBeenCalledOnce()
      fireEvent.keyDown(screen.getByTestId("terminal-host"), { key: "f", ctrlKey: true })
      expect(findInput().value).toBe("error+[socket]")
      expect(findInput().selectionStart).toBe(0)
      expect(findInput().selectionEnd).toBe(findInput().value.length)
      expect(createSearch).toHaveBeenCalledOnce()
      expect(term.loadAddon).toHaveBeenCalledExactlyOnceWith(addon)
    } finally { window.removeEventListener("keydown", globalKey) }
  })

  it("leaves shell Enter and Escape alone while Find is open", () => {
    const globalKey = vi.fn()
    window.addEventListener("keydown", globalKey)
    try {
      render(<Preview term={new TestTerminal()} createSearch={() => new TestSearchAddon()} />)
      openFind()
      globalKey.mockClear()
      const shell = screen.getByLabelText("Shell input")
      fireEvent.keyDown(shell, { key: "Enter" })
      fireEvent.keyDown(shell, { key: "Escape" })
      expect(globalKey).toHaveBeenCalledTimes(2)
      expect(findInput()).toBeTruthy()
    } finally { window.removeEventListener("keydown", globalKey) }
  })

  it("seeds a single-line selection, reports empty results and hides without stealing focus", () => {
    const term = new TestTerminal()
    term.selection = "selected phrase"
    const addon = new TestSearchAddon()
    const createSearch = () => addon
    const view = render(<Preview term={term} createSearch={createSearch} />)
    openFind()
    expect(findInput().value).toBe(term.selection)
    addon.results = { resultIndex: -1, resultCount: 0 }
    fireEvent.change(findInput(), { target: { value: "missing" } })
    expect(screen.getByRole("status").textContent).toBe("No matches")
    view.rerender(<Preview term={term} createSearch={createSearch} active={false} />)
    expect(screen.queryByPlaceholderText("Find in terminal…")).toBeNull()
    expect(term.focus).not.toHaveBeenCalled()
    view.unmount()
    expect(addon.listening).toBe(false)
    expect(addon.dispose).toHaveBeenCalledOnce()
  })

  it("repaints after a theme change without replacing the addon or resetting the query", () => {
    const term = new TestTerminal()
    const addon = new TestSearchAddon()
    const createSearch = vi.fn(() => addon)
    const view = render(<Preview term={term} createSearch={createSearch} />)
    openFind()
    fireEvent.change(findInput(), { target: { value: "needle" } })
    const before = addon.findNext.mock.calls.at(-1)![1]
    view.rerender(<Preview term={term} createSearch={createSearch} palette={light} />)
    const after = addon.findNext.mock.calls.at(-1)![1]
    expect(after?.decorations?.matchBackground).not.toBe(before?.decorations?.matchBackground)
    expect(createSearch).toHaveBeenCalledOnce()
    expect(findInput().value).toBe("needle")
  })

  it("does not turn a multiline terminal selection into a Find query", () => {
    const term = new TestTerminal()
    term.selection = "first line\nsecond line"
    const addon = new TestSearchAddon()
    render(<Preview term={term} createSearch={() => addon} />)
    openFind()
    expect(findInput().value).toBe("")
    expect(addon.findNext).not.toHaveBeenCalled()
  })

  it("disposes the old subscription and clears its query when the terminal is replaced", () => {
    const first = new TestSearchAddon()
    const second = new TestSearchAddon()
    const createSearch = vi.fn(() => first).mockReturnValueOnce(first).mockReturnValueOnce(second)
    const view = render(<Preview term={new TestTerminal()} createSearch={createSearch} />)
    openFind()
    fireEvent.change(findInput(), { target: { value: "old query" } })
    const nextTerminal = new TestTerminal()
    view.rerender(<Preview term={nextTerminal} createSearch={createSearch} />)
    expect(first.listening).toBe(false)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(screen.queryByPlaceholderText("Find in terminal…")).toBeNull()
    openFind()
    expect(findInput().value).toBe("")
    expect(nextTerminal.loadAddon).toHaveBeenCalledExactlyOnceWith(second)
    view.unmount()
    expect(second.listening).toBe(false)
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it("preserves IME key handling and does not intercept Find in a hidden terminal", () => {
    const globalKey = vi.fn()
    window.addEventListener("keydown", globalKey)
    try {
      const term = new TestTerminal()
      const createSearch = () => new TestSearchAddon()
      const view = render(<Preview term={term} createSearch={createSearch} />)
      fireEvent.keyDown(screen.getByTestId("terminal-host"), { key: "f", metaKey: true, isComposing: true })
      expect(screen.queryByPlaceholderText("Find in terminal…")).toBeNull()
      view.rerender(<Preview term={term} createSearch={createSearch} active={false} />)
      openFind()
      expect(globalKey).toHaveBeenCalledTimes(2)
      expect(screen.queryByPlaceholderText("Find in terminal…")).toBeNull()
    } finally { window.removeEventListener("keydown", globalKey) }
  })
})
