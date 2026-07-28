import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties } from "react"
import type { CliInfo, Repo, Session, SessionActivity, ThemeTokens } from "@jingler/core"
import { CSS_VAR_BY_TOKEN } from "@jingler/core"
import { jinglerDark, jinglerLight, toTokens } from "@jingler/themes"
import { ThemeProvider } from "../theme-provider.js"
import { JinglerApp } from "./jingler-app.js"

/**
 * The whole app, on both Jingler grounds.
 *
 * `Screens/App` already renders `JinglerApp` once, on whatever the toolbar theme
 * happens to be. These stories PIN a ground each, which is the thing worth
 * having: a light theme regression is almost never visible while you are looking
 * at the dark one, and the failure mode of the whole `--sb-*` indirection is a
 * component that hardcoded a hex and therefore looks fine in exactly one theme.
 *
 * `SideBySide` is the one to review before shipping a colour change. Two grounds
 * at once is how you notice that a surface which reads as "recessed" on dark
 * reads as "dirty" on light — the two are the same token doing opposite work.
 *
 * The toolbar theme switcher still applies to every OTHER story; these three
 * deliberately ignore it by mounting their own provider.
 */
const meta: Meta = { title: "App", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const noop = () => {}

/**
 * The same `--sb-*` declarations `toCssText` writes, as an inline style object.
 *
 * Derived from `CSS_VAR_BY_TOKEN` rather than hand-listed, so a token added to
 * `ThemeTokens` appears here automatically. Hand-listing them was the first
 * version and would have gone stale on the next token — silently, because a
 * missing var falls back to `:root` and merely looks like the wrong grey.
 *
 * `kind` and `terminal` are absent from that table on purpose: neither is a CSS
 * colour. `colorScheme` is added by hand for the same reason `toCssText` emits
 * it — without it a light half still gets a dark caret in every input.
 */
const inlineVars = (tokens: ThemeTokens): CSSProperties =>
  ({
    ...Object.fromEntries(
      Object.entries(CSS_VAR_BY_TOKEN).map(([token, cssVar]) => [
        cssVar,
        String(tokens[token as keyof typeof CSS_VAR_BY_TOKEN])
      ])
    ),
    colorScheme: tokens.kind === "light" ? "light" : "dark"
  }) as CSSProperties

const DARK = toTokens(jinglerDark)
const LIGHT = toTokens(jinglerLight)

const clis: ReadonlyArray<CliInfo> = [
  { kind: "claude", label: "Claude Code", binPath: "/usr/local/bin/claude", version: "2.1.0", available: true },
  { kind: "codex", label: "Codex CLI", binPath: "/usr/local/bin/codex", version: "0.13.0", available: true },
  { kind: "cursor", label: "Cursor Agent", binPath: null, version: null, available: false }
]

const repos: ReadonlyArray<Repo> = [
  { name: "trigify-app", path: "/Users/m/repos/trigify-app", defaultBranch: "main", currentBranch: "main", remoteUrl: "git@github.com:trigify/trigify-app.git", githubSlug: "trigify/trigify-app" },
  { name: "gtm-grid", path: "/Users/m/repos/gtm-grid", defaultBranch: "main", currentBranch: "feat/scoring", remoteUrl: "git@github.com:trigify/gtm-grid.git", githubSlug: "trigify/gtm-grid" }
]

const session = (value: Omit<Session, "chats" | "activeChatId">): Session => ({
  ...value,
  chats: [
    { id: `c_${value.id}_1`, title: null, createdAt: value.updatedAt, updatedAt: value.updatedAt }
  ],
  activeChatId: `c_${value.id}_1`
})

/**
 * Deliberately spread across every status the sidebar draws. A story seeded
 * with three idle sessions exercises one row style and hides the other four.
 */
const sessions: ReadonlyArray<Session> = [
  session({ id: "s1", repo: "trigify-app", branch: "feat/oauth", title: "Refactor auth flow", status: "thinking", cli: "claude", diff: { added: 313, removed: 23 }, prNumber: 482, costUsd: 1.24, tokens: 218_000, updatedAt: "2026-07-11T09:41:00Z" }),
  session({ id: "s2", repo: "trigify-app", branch: "chore/deps", title: "Bump dependencies", status: "idle", cli: "claude", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0.12, tokens: 14_200, updatedAt: "2026-07-11T08:12:00Z" }),
  session({ id: "s3", repo: "gtm-grid", branch: "fix/flaky", title: "Fix flaky tests", status: "needs-input", cli: "codex", diff: { added: 47, removed: 9 }, prNumber: null, costUsd: 0.44, tokens: 61_800, updatedAt: "2026-07-11T09:05:00Z" }),
  session({ id: "s4", repo: "gtm-grid", branch: "feat/scoring", title: "Score model v2", status: "running", cli: "claude", diff: { added: 128, removed: 64 }, prNumber: 204, costUsd: 0.88, tokens: 96_400, updatedAt: "2026-07-11T09:52:00Z" })
]

const liveActivity: Record<string, SessionActivity> = {
  s1: { kind: "thinking", verb: "Thinking", target: null },
  s4: { kind: "running", verb: "Running", target: "pnpm test -- scoring" }
}

const App = () => (
  <JinglerApp
    clis={clis}
    sessions={sessions}
    repos={repos}
    liveActivity={liveActivity}
    user={{ id: "u1", name: "Morgan Parry", email: "morgan@trigify.io", image: null }}
    onSignOut={noop}
  />
)

/*
 * Both grounds are pinned with `globals.theme`, NOT with a `ThemeProvider`
 * inside the story.
 *
 * A provider here does not work, and fails in a way that looks like the light
 * theme is broken rather than like the story is. The preview decorator already
 * mounts one, and both write the same `<style id="jingler-theme">` element —
 * React runs a child's layout effect BEFORE its parent's, so the story's sheet
 * is written first and the decorator's overwrites it. The story renders the
 * toolbar's theme no matter what it asked for.
 *
 * Setting the global instead makes the decorator itself resolve the right
 * theme, which is also what an operator actually does.
 */
export const Dark: Story = {
  globals: { theme: "jingler-dark" },
  render: () => (
    <div className="h-screen w-full">
      <App />
    </div>
  )
}

export const Light: Story = {
  globals: { theme: "jingler-light" },
  render: () => (
    <div className="h-screen w-full">
      <App />
    </div>
  )
}

/**
 * Both grounds at once.
 *
 * Each half needs its own `ThemeProvider`, and each provider writes the SAME
 * `<style id="jingler-theme">` to the document head — so the second to mount
 * wins and both halves would render identically. `applyToDocument={false}` stops
 * them fighting: the tokens still flow through React context (which is what the
 * terminal palette and shiki read), and the CSS vars are scoped to each half's
 * own wrapper instead of the document root.
 */
const Half = ({
  tokens,
  activeId,
  label
}: {
  tokens: ThemeTokens
  activeId: string
  label: string
}) => (
  <div className="flex min-w-0 flex-1 flex-col">
    <ThemeProvider tokens={tokens} activeId={activeId} applyToDocument={false}>
      {/*
        The vars land here rather than on `:root`, so the two halves can hold
        different palettes on one page. `data-theme-kind` is mirrored too — a few
        rules branch on it rather than reading a value.
      */}
      <div
        data-theme-kind={tokens.kind}
        className="flex min-h-0 flex-1 flex-col"
        style={inlineVars(tokens)}
      >
        <div className="flex-1 overflow-hidden">
          <App />
        </div>
        <span className="flex-none bg-canvas px-3 py-1.5 font-mono text-[10.5px] text-muted-foreground">
          {label}
        </span>
      </div>
    </ThemeProvider>
  </div>
)

export const SideBySide: Story = {
  render: () => (
    <div className="flex h-screen w-full">
      <Half tokens={DARK} activeId="jingler-dark" label="jingler-dark" />
      <div className="w-px flex-none bg-line" />
      <Half tokens={LIGHT} activeId="jingler-light" label="jingler-light" />
    </div>
  )
}
