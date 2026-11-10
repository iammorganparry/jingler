import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react"
import { useMachine } from "@xstate/react"
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search"
import type { Terminal } from "@xterm/xterm"
import type { TerminalPalette } from "@jingler/core"
import { mix, parseHex, toHex } from "@jingler/themes"
import { matchGlobalSearchChord } from "@jingler/ui"
import { terminalSearchMachine, terminalSearchCount, TERMINAL_SEARCH_HIGHLIGHT_LIMIT } from "./terminal-search-machine.js"

const MULTILINE = /[\r\n]/u
export type TerminalSearchHost = Pick<Terminal, "getSelection" | "focus" | "loadAddon">
const makeSearchAddon = () => new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT })

const keyIntent = (event: KeyboardEvent): "OPEN" | "CLOSE" | "NEXT" | "PREVIOUS" | null => {
  if (event.isComposing) return null
  if (matchGlobalSearchChord(event)) return "OPEN"
  if (!(event.target instanceof Element) || !event.target.closest("[data-terminal-find]")) return null
  if (event.key === "Escape") return "CLOSE"
  if (event.key === "Enter" && event.target instanceof HTMLInputElement) return event.shiftKey ? "PREVIOUS" : "NEXT"
  return null
}

const selectedQuery = (term: TerminalSearchHost, open: boolean): string | undefined => {
  if (open) return undefined
  const selection = term.getSelection()
  return selection && !MULTILINE.test(selection) ? selection : undefined
}

const searchOptions = (palette: TerminalPalette, incremental: boolean): ISearchOptions => ({
  regex: false,
  incremental,
  decorations: {
    matchBackground: toHex(mix(parseHex(palette.background)!, parseHex(palette.yellow)!, 0.2)),
    matchOverviewRuler: palette.yellow,
    activeMatchBackground: toHex(mix(parseHex(palette.background)!, parseHex(palette.yellow)!, 0.4)),
    activeMatchColorOverviewRuler: palette.yellow
  }
})

/** The addon shares its terminal's lifetime; closing Find only clears its decorations. */
export function useTerminalSearch(term: TerminalSearchHost | null, active: boolean, palette: TerminalPalette, root: RefObject<HTMLDivElement | null>, createSearch: () => SearchAddon = makeSearchAddon) {
  const inputRef = useRef<HTMLInputElement>(null)
  const addonRef = useRef<SearchAddon | null>(null)
  const terminalRef = useRef(term)
  const paletteRef = useRef(palette)
  terminalRef.current = term
  const machine = useMemo(() => {
    const find = (query: string, direction: "next" | "previous", incremental: boolean) => {
      const addon = addonRef.current
      if (!addon) return
      if (!query) { addon.clearDecorations(); return }
      const options = searchOptions(paletteRef.current, incremental)
      if (direction === "previous") addon.findPrevious(query, options)
      else addon.findNext(query, options)
    }
    return terminalSearchMachine.provide({ actions: {
      search: ({ context }) => find(context.query, "next", true),
      next: ({ context }) => find(context.query, "next", false),
      previous: ({ context }) => find(context.query, "previous", false),
      clear: () => addonRef.current?.clearDecorations(),
      focusTerminal: () => terminalRef.current?.focus()
    } })
  }, [])
  const [snapshot, send, actor] = useMachine(machine)

  useEffect(() => {
    if (!term) return
    const addon = createSearch()
    term.loadAddon(addon)
    addonRef.current = addon
    const subscription = addon.onDidChangeResults((results) => send({ type: "RESULTS", ...results }))
    send({ type: "RESET" })
    return () => {
      subscription.dispose()
      if (addonRef.current === addon) addonRef.current = null
      addon.dispose()
    }
  }, [term, createSearch, send])

  useEffect(() => { if (!active) send({ type: "HIDE" }) }, [active, send])
  useEffect(() => { paletteRef.current = palette; send({ type: "REFRESH" }) }, [palette, send])
  const focusRevision = snapshot.context.focusRevision
  useLayoutEffect(() => {
    if (focusRevision === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRevision])

  useEffect(() => {
    const element = root.current
    if (!element || !term || !active) return
    const onKey = (event: KeyboardEvent) => {
      const intent = keyIntent(event)
      if (!intent) return
      event.preventDefault()
      event.stopPropagation()
      if (intent === "OPEN") send({ type: "OPEN", query: selectedQuery(term, actor.getSnapshot().matches("open")) })
      else send({ type: intent })
    }
    // Capture precedes xterm's key processing and the app's global-search listener.
    element.addEventListener("keydown", onKey, true)
    return () => element.removeEventListener("keydown", onKey, true)
  }, [term, active, root, actor, send])

  return {
    open: active && snapshot.matches("open"),
    query: snapshot.context.query,
    count: terminalSearchCount(snapshot.context),
    inputRef,
    change: (query: string) => { send({ type: "CHANGE", query }); inputRef.current?.focus() }
  }
}
