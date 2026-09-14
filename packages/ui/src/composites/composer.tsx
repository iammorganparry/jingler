import { defaultProps } from "../lib/default-props.js"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Attachment,
  Environment,
  McpConfigEntry,
  McpRemoteAuth,
  McpServer,
  PermissionMode,
  PlanDocument,
  ProviderCatalog,
  ProviderConnectionId,
  ProviderModelId,
  ReasoningEffort,
  ReasoningSetting,
  Skill,
} from "@jingler/core";
import {
  ArrowUp,
  ChevronDown,
  Cloud,
  FileDiff,
  FolderGit2,
  GitBranch,
  ImagePlus,
  ListChecks,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointer2,
  Plus,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Square,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { downscaleImage } from "../lib/image-downscale.js";
import { atLeast, useWidthTier } from "../hooks/width-tier.js";
import { AttachmentThumb } from "../components/attachment-thumb.js";
import { Button } from "../components/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../components/beui/select.js";
import { CodeChip } from "../components/code-chip.js";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "../components/beui/popover-morph.js";
import { Pill } from "../components/pill.js";
import { SignalBars } from "../components/signal-bars.js";
import { CommandMenu } from "./command-menu.js";
import { MentionMenu } from "./mention-menu.js";
import { McpApiKeyDialog, McpAuthSetupDialog, McpBrand, McpServerDialog } from "./mcp-settings.js";
import { planTaskCounts, PlanTaskList } from "./plan-progress-dock.js";
import { PromptInputSurface } from "./beui/work.js";
import {
  ProviderModelBrowser,
  type ProviderModelSelection,
} from "./provider-model-browser.js";

/** Cap the number of attached images so the prompt payload stays sane. */
const MAX_ATTACHMENTS = 8;

/** Read a `File` as raw base64 — the original bytes, no resizing. */
const readOriginal = (file: File): Promise<string> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });

/**
 * Read an image `File` into a base64 `Attachment` (null if it isn't an image).
 *
 * Downscaled on the way in — a pasted Retina screenshot is several megabytes of
 * base64 that gets persisted into the transcript forever and decoded to a ~23MB
 * bitmap to paint a 58px tile, and the harness does not use the extra pixels
 * either. See `image-downscale.ts`. Anything the resize declines (a GIF, an image
 * already within the cap, a re-encode that came out larger) falls through to the
 * original bytes, so an attachment is never lost to the optimisation.
 */
const readAttachment = async (
  file: File,
  id: string,
): Promise<Attachment | null> => {
  if (!file.type.startsWith("image/")) return null;
  const name = file.name || "pasted-image.png";
  const shrunk = await downscaleImage(file, file.type);
  if (shrunk !== null)
    return { id, name, mediaType: shrunk.mediaType, data: shrunk.data };
  const data = await readOriginal(file);
  return data === "" ? null : { id, name, mediaType: file.type, data };
};

interface ComposerOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: string;
}

const MODE_OPTIONS: ReadonlyArray<ComposerOption<PermissionMode>> = [
  { value: "ask", label: "Ask Before Actions" },
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Auto" },
];
type ReasoningChoice = "default" | ReasoningEffort;
/**
 * Filled bars for a reasoning choice — its rung on the PROVIDER'S ladder, not a
 * fixed scale. Claude's runs low…max and Codex's minimal…xhigh, so the same word
 * ("low") is the first rung on one and the second on the other; the bars follow
 * the list the operator is actually choosing from.
 *
 * Both `default` and `off` fill nothing: neither is a strength. `off` is told
 * apart by the slash (see `SignalBars`), and the chip's label carries the rest.
 */
const reasoningLevel = (
  options: ReadonlyArray<ReasoningEffort>,
  choice: ReasoningChoice | "off",
): number =>
  choice === "default" || choice === "off" ? 0 : options.indexOf(choice) + 1;

type MenuState = { kind: "slash" | "mention"; query: string; start: number };
const TRAILING_SPACE = /\s$/;

/** Display-only projection of the renderer-owned captured code reference. */
export interface ComposerCodeReference {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Canonical range label produced by the code-reference boundary. */
  readonly label: string;
}

/** The trigger token (`/…` or `@…`) immediately before the caret, if any. */
const activeToken = (value: string, caret: number): MenuState | null => {
  const match = value.slice(0, caret).match(/(?:^|\s)([/@])(\S*)$/);
  if (!match) return null;
  const query = match[2] ?? "";
  return {
    kind: match[1] === "/" ? "slash" : "mention",
    query,
    start: caret - query.length - 1,
  };
};

/** Codex invokes skills with `$name`; the palette keeps `/` as its common discovery trigger. */
const skillInsertion = (skill: Skill): string => skill.name;

/** The Plan drawer tab. */
function DrawerTab({
  active,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  badge?: string;
  onClick: () => void;
}) {
  const accentText = "text-purple";
  const accentBar = "bg-purple";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-1.5 rounded-t-md px-3 pb-2.5 pt-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active
          ? "text-text-bright"
          : "text-muted-foreground hover:bg-hover hover:text-text",
      )}
    >
      <span className={cn("flex size-3.5 items-center justify-center", active && accentText)}>
        {icon}
      </span>
      {label}
      {badge && (
        <span className="rounded-full bg-panel px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums text-dim">
          {badge}
        </span>
      )}
      {active && <span className={cn("absolute inset-x-2.5 -bottom-px h-0.5 rounded-t", accentBar)} />}
    </button>
  );
}

function ComposerSelect<T extends string>({
  value,
  options,
  onSelect,
  icon,
  ariaLabel,
  disabled = false,
  className,
  inlineContent = false,
}: {
  value: T;
  options: ReadonlyArray<ComposerOption<T>>;
  onSelect?: (value: T) => void;
  icon?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  inlineContent?: boolean;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Select value={value} onValueChange={(next) => onSelect?.(next as T)} disabled={disabled} placement={inlineContent ? undefined : "top"} className="min-w-0">
      <SelectTrigger ariaLabel={ariaLabel} className={cn("h-8 w-auto max-w-52 rounded-xl border-0 bg-transparent px-2 py-0 text-xs hover:bg-surface focus-visible:ring-2", className)}>
        <span className="flex min-w-0 items-center gap-1.5">
          {icon && <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
          <span className="truncate text-muted-foreground">{current?.label ?? value}</span>
        </span>
      </SelectTrigger>
      <SelectContent inline={inlineContent} className={cn("right-auto w-52 shadow-none", inlineContent && "mt-1 w-full")}>
        {options.map((option) => <SelectItem key={option.value} value={option.value} className="py-2"><span className="flex min-w-0 flex-col"><span className="truncate text-sm text-text-bright">{option.label}</span>{option.description && <span className="truncate text-xs leading-4 text-muted-foreground">{option.description}</span>}</span></SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/**
 * The prompt composer — a real controlled textarea with Enter-to-send /
 * Shift+Enter newline, plus two typeahead palettes: `/` surfaces the harness's
 * skills (harness-agnostic) and `@` references worktree files as code chips.
 */
type ComposerProps =  {
  skills?: ReadonlyArray<Skill>;
  files?: ReadonlyArray<string>;
  onAddMcp?: (name: string, entry: McpConfigEntry) => Promise<void>;
  mcpServers?: ReadonlyArray<McpServer>;
  onSetMcpApiKey?: (name: string, apiKey: string) => Promise<void>;
  onSetMcpAuth?: (name: string, auth: McpRemoteAuth) => Promise<void>;
  onAuthorizeMcp?: (name: string) => Promise<void>;
  onSend?: (text: string, images?: ReadonlyArray<Attachment>) => void;
  /** Halt the running agent. Given one, the button becomes Stop while `busy`. */
  onStop?: () => void;
  /** Git branch backing this session's worktree. */
  branch?: string;
  /** The detached task worktree is waiting for its semantic branch name. */
  branchPending?: boolean;
  /** Repository name backing this session — shown at the composer's bottom-left. */
  repo?: string;
  /**
   * Live uncommitted worktree state — changed files plus ±line totals vs HEAD.
   * Rendered as a quiet badge beside the repo name; null/absent or all-zero
   * hides it (a clean tree says nothing).
   */
  diff?: { files: number; added: number; removed: number } | null;
  environments?: ReadonlyArray<Environment>;
  environmentId?: string;
  environmentPending?: boolean;
  onSetEnvironment?: (environmentId?: string) => void;
  /** Seed the draft once on mount (e.g. a task prefilled from a linked issue). */
  initialValue?: string;
  /**
   * Lift the draft text out of this component. The app passes this so a draft
   * survives a session switch — which UNMOUNTS the composer (the pane is keyed by
   * session id), destroying any local state. Omit it and the composer stays
   * happily uncontrolled (stories, Storybook).
   */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Lift the attachments out too — same reasoning as `value`. */
  attachments?: ReadonlyArray<Attachment>;
  onAttachmentsChange?: (attachments: ReadonlyArray<Attachment>) => void;
  /** Captured repository ranges attached as structured draft context. */
  codeReferences?: ReadonlyArray<ComposerCodeReference>;
  /** Remove one captured range without disturbing text or image attachments. */
  onCodeReferenceRemove?: (index: number) => void;
  /** Clear every captured range after a composer send. */
  onCodeReferencesClear?: () => void;
  /** Live canonical plan projected as a task list inside the composer chrome. */
  planDocument?: PlanDocument;
  /** Open Plan Review at a selected canonical stage. */
  onOpenPlanStage?: (stageId: string) => void;
  /** New-session-only controls rendered instead of static repository metadata. */
  contextControls?: ReactNode;
  /** Canonical certified model surface. */
  providerCatalog?: ProviderCatalog | null;
  connectionId?: ProviderConnectionId | null;
  modelId?: ProviderModelId | null;
  onSetModel?: (selection: ProviderModelSelection) => void;
  /** Current HITL mode (shown in the mode chip; Shift+Tab cycles it). */
  mode?: PermissionMode;
  onSetMode?: (mode: PermissionMode) => void;
  /** Whether Files is following mutations from this chat's active agent. */
  followAgent?: boolean;
  /** Toggle the session file browser's shared agent-follow mode. */
  onToggleFollowAgent?: (enabled: boolean) => void;
  /** Per-session thinking strength; absent preserves the harness default. */
  reasoningEffort?: ReasoningEffort;
  thinkingEnabled?: boolean;
  onSetReasoning?: (reasoning?: ReasoningSetting) => void;
  /** Offer the Jingler-owned read-only planning mode. */
  allowPlan?: boolean;
  paused?: boolean;
  /** Disable composing without disabling the model picker used to recover. */
  disabledReason?: string;
  /**
   * The agent is producing a turn — sends are queued (processed once it's free)
   * rather than blocked, so the composer stays live and the button reads "Queue".
   */
  busy?: boolean;
  /** Overrides the default "Message <harness>…" prompt. */
  placeholder?: string;
  /**
   * Take the caret when this composer becomes the one on screen. The host passes
   * the focused pane's flag, so a split never has two composers fighting for it.
   */
  autoFocus?: boolean;
  /**
   * What "became the one on screen" means — the session id. Refocusing is keyed
   * on this, so replacing a pane's session re-focuses even though the component
   * never unmounted.
   */
  focusKey?: string;
  className?: string;
}

function composerReasoningOptions(
  selectedModel: NonNullable<ComposerProps["providerCatalog"]>["connections"][number]["models"][number] | undefined
) {
  const reasoningEfforts = selectedModel?.capabilities.reasoning ?? [];
  const reasoningDefault = selectedModel?.capabilities.reasoningDefault;
  const reasoningDefaultLabel = reasoningDefault
    ? `${reasoningDefault[0]!.toUpperCase()}${reasoningDefault.slice(1)} (default)`
    : "Default";
  const reasoningOptions: ReadonlyArray<ComposerOption<ReasoningChoice | "off">> = [
    { value: "default", label: reasoningDefaultLabel },
    ...(reasoningEfforts.length > 0 &&
    selectedModel?.capabilities.reasoningCanDisable !== false
      ? [{ value: "off" as const, label: "Off" }]
      : []),
    ...reasoningEfforts.filter((effort) => effort !== reasoningDefault).map((effort) => ({
      value: effort,
      label: effort[0]!.toUpperCase() + effort.slice(1),
    })),
  ];
  return { reasoningEfforts, reasoningOptions }
}

function ComposerMcpMenu({
  servers,
  setActionsOpen,
  setApiKeyServer,
  setAuthSetupServer,
  onSetApiKey,
  onSetAuth,
  onAuthorize,
  onError,
  onConnect
}: {
  readonly servers: ReadonlyArray<McpServer>
  readonly setActionsOpen: (open: boolean) => void
  readonly setApiKeyServer: (server: McpServer) => void
  readonly setAuthSetupServer: (server: McpServer) => void
  readonly onSetApiKey?: (name: string, apiKey: string) => Promise<void>
  readonly onSetAuth?: (name: string, auth: McpRemoteAuth) => Promise<void>
  readonly onAuthorize?: (name: string) => Promise<void>
  readonly onError: (message: string | null) => void
  readonly onConnect: () => void
}) {
  const [query, setQuery] = useState("")
  const manageable = servers.filter((server) => server.transport === "http")
  const matches = manageable.filter((server) =>
    `${server.displayName} ${server.name} ${server.target}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  return (
    <div className="border-t border-line pt-1">
      {manageable.length > 4 && (
        <label className="mx-1.5 my-1 flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-muted-foreground focus-within:border-text-bright/30">
          <Search size={13} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search MCP servers" placeholder="Search servers" className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-dim" />
        </label>
      )}
      <div className="max-h-64 overflow-y-auto">
      {matches.map((server) => (
        <button
          key={server.name}
          type="button"
          disabled={(server.authKind === "none" && (onSetAuth === undefined || onSetApiKey === undefined || onAuthorize === undefined)) || (server.authKind === "api-key" && onSetApiKey === undefined) || (server.authKind === "oauth" && onAuthorize === undefined)}
          onClick={() => {
            setActionsOpen(false)
            if (server.authKind === "none") setAuthSetupServer(server)
            else if (server.authKind === "api-key") setApiKeyServer(server)
            else if (server.authKind === "oauth") {
              onError(null)
              void onAuthorize?.(server.name).catch((cause) =>
                onError(cause instanceof Error ? cause.message : "MCP authorization failed")
              )
            }
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface focus-visible:bg-surface disabled:opacity-60"
        >
          <McpBrand server={server} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-text-bright">{server.displayName}</span>
            <span className="block text-xs text-muted-foreground">
              {server.authKind === "none" ? "Set up auth" : server.authState === "ready" ? "Reauthenticate" : "Authentication required"}
            </span>
          </span>
        </button>
      ))}
      {matches.length === 0 && <p className="px-2.5 py-3 text-xs text-dim">No matching servers.</p>}
      </div>
      <button type="button" onClick={onConnect} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface focus-visible:bg-surface">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4"><Server size={15} /></span>
        <span className="min-w-0 flex-1"><span className="block text-sm text-text-bright">Connect MCP server</span><span className="mt-0.5 block text-xs leading-4 text-muted-foreground">Add tools for local sessions</span></span>
      </button>
    </div>
  )
}

function ComposerMcpDialogs({
  error,
  add,
  addOpen,
  onAddOpenChange,
  apiKeyServer,
  onApiKeyServerChange,
  authSetupServer,
  onAuthSetupServerChange,
  setApiKey,
  setAuth,
  authorize
}: {
  readonly error: string | null
  readonly add?: (name: string, entry: McpConfigEntry) => Promise<void>
  readonly addOpen: boolean
  readonly onAddOpenChange: (open: boolean) => void
  readonly apiKeyServer: McpServer | null
  readonly onApiKeyServerChange: (server: McpServer | null) => void
  readonly authSetupServer: McpServer | null
  readonly onAuthSetupServerChange: (server: McpServer | null) => void
  readonly setApiKey?: (name: string, apiKey: string) => Promise<void>
  readonly setAuth?: (name: string, auth: McpRemoteAuth) => Promise<void>
  readonly authorize?: (name: string) => Promise<void>
}) {
  return (
    <>
      {error !== null && <div role="alert" className="px-2 pt-1 text-[11px] text-red">{error}</div>}
      {add !== undefined && (
        <McpServerDialog open={addOpen} onOpenChange={onAddOpenChange} add={add} setApiKey={setApiKey} />
      )}
      {setApiKey !== undefined && setAuth !== undefined && authorize !== undefined && (
        <McpAuthSetupDialog
          server={authSetupServer}
          open={authSetupServer !== null}
          onOpenChange={(open) => { if (!open) onAuthSetupServerChange(null) }}
          setAuth={setAuth}
          setApiKey={setApiKey}
          startAuthorization={authorize}
        />
      )}
      {setApiKey !== undefined && (
        <McpApiKeyDialog
          server={apiKeyServer}
          open={apiKeyServer !== null}
          onOpenChange={(open) => { if (!open) onApiKeyServerChange(null) }}
          setApiKey={setApiKey}
        />
      )}
    </>
  )
}

export function Composer(props: ComposerProps) {
         function renderAutocomplete() {
           return (menu && count > 0 && (
        <div className="absolute inset-x-0 bottom-full z-10 mb-2">
          {menu.kind === "slash" ? (
            <CommandMenu
              skills={skillMatches}
              activeIndex={activeIndex}
              onSelect={(skill) => replaceToken(skillInsertion(skill))}
              onHover={setActiveIndex}
            />
          ) : (
            <MentionMenu
              files={fileMatches}
              activeIndex={activeIndex}
              onSelect={(p) => replaceToken(`@${p}`)}
              onHover={setActiveIndex}
            />
          )}
        </div>
      ))
         }

  function renderContextControls() {
    return (contextControls ? (
          <div className="flex min-w-0 items-center gap-1 px-1 pt-1">
            {contextControls}
          </div>
        ) : (repo || branch || branchPending) && (
          <div className="flex items-center justify-between gap-2 px-1.5 pt-1 font-mono text-[10.5px] text-dim">
            {repo ? (
              renderRepositoryMetadata()
            ) : (
              <span />
            )}
            {(branch || branchPending) && (
              renderBranchMetadata()
            )}
          </div>
        ))
  }

  function renderComposerToolbar() {
    return (<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5 [&>button]:min-h-8">
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <button
                type="button"
                aria-label="Composer menu"
                title="Add context"
                disabled={paused || disabledReason !== undefined}
                className="flex size-8 flex-none items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-surface hover:text-text-bright disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  aria-hidden
                  style={{ transform: `rotate(${actionsOpen ? 45 : 0}deg)` }}
                  className="inline-flex transition-transform duration-300 ease-out motion-reduce:duration-0"
                >
                  <Plus size={16} />
                </span>
              </button>
            </MorphPopoverTrigger>
            <MorphPopoverContent side="top" sideOffset={8} align="start" radius={12} className="w-56 p-1.5">
              <div>
                <button type="button" onClick={() => { fileInputRef.current?.click(); setActionsOpen(false); }} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface focus-visible:bg-surface">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4"><ImagePlus size={15} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm text-text-bright">Add image</span><span className="mt-0.5 block text-xs leading-4 text-muted-foreground">Attach visual context</span></span>
                </button>
                <button type="button" disabled={skills.length === 0} onClick={() => { openSkills(); setActionsOpen(false); }} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-surface focus-visible:bg-surface disabled:pointer-events-none disabled:opacity-50">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4"><Sparkles size={15} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm text-text-bright">Skills</span><span className="mt-0.5 block text-xs leading-4 text-muted-foreground">Insert a harness command</span></span>
                  {skills.length > 0 && <span className="font-mono text-[10.5px] text-dim">{skills.length}</span>}
                </button>
                {onAddMcp !== undefined && (
                  <ComposerMcpMenu
                    servers={mcpServers}
                    setActionsOpen={setActionsOpen}
                    setApiKeyServer={setMcpApiKeyServer}
                    setAuthSetupServer={setMcpAuthSetupServer}
                    onSetApiKey={onSetMcpApiKey}
                    onSetAuth={onSetMcpAuth}
                    onAuthorize={onAuthorizeMcp}
                    onError={setMcpActionError}
                    onConnect={() => { setActionsOpen(false); setMcpDialogOpen(true) }}
                  />
                )}
              </div>
            </MorphPopoverContent>
          </MorphPopover>
          {onToggleFollowAgent !== undefined && (
            <button
              type="button"
              className={cn(
                "jingler-mode-toggle inline-flex size-8 flex-none items-center justify-center rounded-md outline-none transition-colors active:scale-[0.96]",
                followAgent
                  ? "is-active"
                  : "text-muted-foreground hover:text-text",
              )}
              aria-label="Follow agent"
              aria-pressed={followAgent}
              title={
                followAgent
                  ? "Stop following files edited by this chat's agent"
                  : "Follow files edited by this chat's agent"
              }
              onClick={() => onToggleFollowAgent(!followAgent)}
            >
              <MousePointer2
                size={15}
                aria-hidden
                className="jingler-mode-toggle__mark"
              />
            </button>
          )}
          {compactSettings ? (
            renderCompactSettings()
          ) : (
            renderInlineSettings()
          )}
          {/* `min-w-[8px]` so the spacer still exists after a wrap — a bare
              `flex-1` on a wrapped line collapses to nothing and the send button
              ends up butted against the last chip. */}
          <div className="min-w-[8px] flex-1" />
          {/* The send/stop control is `flex-none` and LAST in DOM order, which
              together decide what a squeeze does: the row wraps the chips above
              it and the primary action keeps its full size on the trailing line,
              rather than being the thing pushed past the border. */}
          <span className="flex-none">
            {getDisabledReason()}
          </span>
        </div>)
  }

  function renderBranchMetadata() {
    return (<span
                title={branchPending ? "Task branch will be named after task understanding" : `Working branch: ${branch}`}
                className="flex min-w-0 max-w-[180px] items-center gap-1"
                data-testid="composer-branch"
                aria-live="polite"
                aria-atomic="true"
              >
                <GitBranch size={12} className="flex-none" />
                <span className="truncate">{branchPending ? "Naming branch…" : branch}</span>
              </span>)
  }

  function renderRepositoryMetadata() {
    return (<span className="flex min-w-0 items-center gap-2">
                <span
                  title={`Repository: ${repo}`}
                  className="flex min-w-0 items-center gap-1"
                >
                  <FolderGit2 size={12} className="flex-none" />
                  <span className="truncate">{repo}</span>
                </span>
                {/* Dirty-tree badge: a clean tree says nothing. */}
                {diff !== null && (diff.files > 0 || diff.added > 0 || diff.removed > 0) && (
                  <span
                    title={`Uncommitted changes: ${diff.files} file${diff.files === 1 ? "" : "s"}, +${diff.added} −${diff.removed}`}
                    className="flex flex-none items-center gap-1"
                    data-testid="composer-dirty"
                  >
                    <FileDiff size={12} className="flex-none" />
                    <span>{diff.files}</span>
                    <span className="text-green">+{diff.added}</span>
                    <span className="text-red">−{diff.removed}</span>
                  </span>
                )}
              </span>)
  }

  function renderInlineSettings() {
    return (<>
              {onSetEnvironment && <ComposerSelect<string> value={environmentId ?? "__local__"} options={environmentOptions} onSelect={(next) => onSetEnvironment(next === "__local__" ? undefined : next)} disabled={environmentPending} ariaLabel="Execution environment" className="max-w-[150px]" />}
              {providerCatalog && <ProviderModelBrowser catalog={providerCatalog} connectionId={connectionId} modelId={modelId} onSelect={onSetModel} placement="top" className={roomy ? "max-w-[190px]" : "max-w-[112px]"} />}
              <ComposerSelect value={mode} options={modeOptions} onSelect={onSetMode} className="max-w-[104px]" />
              {(!selectedModel || reasoningEfforts.length > 0) && <ComposerSelect value={reasoningChoice} options={reasoningOptions} onSelect={setReasoningChoice} ariaLabel="Thinking strength" icon={<SignalBars level={reasoningLevel(reasoningEfforts, reasoningChoice)} total={reasoningEfforts.length} slashed={thinkingEnabled === false} />} className="max-w-[132px]" />}
            </>)
  }

  function renderCompactSettings() {
    return (<MorphPopover open={settingsOpen} onOpenChange={setSettingsOpen}>
              <MorphPopoverTrigger>
                <button type="button" aria-label="Composer options" className="flex h-8 items-center gap-1.5 rounded-xl px-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-surface hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring">
                  <SlidersHorizontal size={14} aria-hidden />
                  <span>Options</span>
                </button>
              </MorphPopoverTrigger>
              <MorphPopoverContent side="top" align="start" sideOffset={8} radius={12} className="w-72 max-w-[calc(100vw-24px)] p-2">
                <div className="space-y-1.5">
                  {providerCatalog && <div><div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">Model</div><ProviderModelBrowser catalog={providerCatalog} connectionId={connectionId} modelId={modelId} onSelect={onSetModel} inlineContent className="w-full" /></div>}
                  {onSetEnvironment && <div><div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">Environment</div><ComposerSelect<string> value={environmentId ?? "__local__"} options={environmentOptions} onSelect={(next) => onSetEnvironment(next === "__local__" ? undefined : next)} disabled={environmentPending} ariaLabel="Execution environment" inlineContent className="w-full max-w-none" /></div>}
                  <div><div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">Permission</div><ComposerSelect value={mode} options={modeOptions} onSelect={onSetMode} inlineContent className="w-full max-w-none" /></div>
                  {(!selectedModel || reasoningEfforts.length > 0) && <div><div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">Reasoning</div><ComposerSelect value={reasoningChoice} options={reasoningOptions} onSelect={setReasoningChoice} ariaLabel="Thinking strength" inlineContent className="w-full max-w-none" /></div>}
                </div>
              </MorphPopoverContent>
            </MorphPopover>)
  }

  const { skills, files, onAddMcp, mcpServers, onSetMcpApiKey, onSetMcpAuth, onAuthorizeMcp, onSend, onStop, branch, branchPending, repo, diff, environments, environmentId, environmentPending, onSetEnvironment, providerCatalog, connectionId, modelId, onSetModel, mode, onSetMode, followAgent, onToggleFollowAgent, reasoningEffort, thinkingEnabled, onSetReasoning, allowPlan, paused, disabledReason, busy, placeholder, autoFocus, focusKey, initialValue, value: controlledValue, onValueChange, attachments: controlledAttachments, onAttachmentsChange, codeReferences, onCodeReferenceRemove, onCodeReferencesClear, planDocument, onOpenPlanStage, contextControls, className } = defaultProps(props, {
    skills: [],
    files: [],
    mcpServers: [],
    branchPending: false,
    diff: null,
    environments: [],
    environmentPending: false,
    connectionId: null,
    modelId: null,
    mode: "auto",
    followAgent: false,
    allowPlan: false,
    paused: false,
    busy: false,
    autoFocus: false,
    codeReferences: []
  })

         function renderDraftInput() {
           return (<textarea
          ref={ref}
          value={value}
          disabled={paused || disabledReason !== undefined}
          placeholder={
            disabledReason ??
            (paused
              ? "Reply, or answer the prompt above…"
              : busy
                // An explicit placeholder wins even while busy: a composer
                // aimed at a subagent steers live ("Steer worker…"), and
                // the queue default would promise semantics it doesn't have.
                ? placeholder ?? "Queue a message while the agent works…"
                : prompt)
          }
          onChange={(e) =>
            sync(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            )
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          /*
           * `field-sizing-content` — the height is a LAYOUT property, resolved
           * by the browser from the content at whatever width the composer
           * currently has, on every frame it changes.
           *
           * It replaces a `useLayoutEffect` that set `height: auto`, read
           * `scrollHeight` and wrote it back, keyed on `[value]`. That ran
           * exactly once per value change — and a pane MOUNTS about a pixel
           * wide, because `paneVariants.hidden` enters from `flexGrow: 0.001`.
           * At zero content width Chromium wraps the placeholder one glyph per
           * line, so "Message Claude…" measured ~315px, was written to
           * `style.height`, and stuck there (nothing re-measures — there is no
           * ResizeObserver) until the first keystroke re-ran the effect at the
           * real width. The composer opened at its `max-h` and snapped back as
           * you typed. The same staleness sat under every divider drag and
           * window resize; a measurement that has to be re-taken by hand is a
           * measurement that will be missed.
           *
           * `min-h` still guarantees one line, `max-h` still caps the growth,
           * and past the cap `overflow-y-auto` scrolls. Chromium 123+; this app
           * ships its own (Electron 43 → Chromium 140).
           */
          className="field-sizing-content max-h-64 min-h-[22px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-text-body outline-none placeholder:text-dim"
        />)
         }

         function renderPlanDrawer() {
           return (planDocument && (
          <div className="-mx-4 -mt-3.5">
            <div role="tablist" aria-label="Plan" className="flex items-stretch gap-0.5 border-b border-line px-2.5 pt-1.5">
              <DrawerTab
                active
                icon={<ListChecks className="size-3.5" />}
                label="Plan"
                badge={planDrawerCounts ? `${planDrawerCounts.completed}/${planDrawerCounts.total}` : undefined}
                onClick={() => setDrawerOpen(true)}
              />
              <span className="flex-1" />
              {drawerOpen && (
                <button
                  type="button"
                  aria-label={planExtended ? "Collapse plan overview" : "Extend to plan overview"}
                  aria-pressed={planExtended}
                  onClick={() => setPlanExtended((value) => !value)}
                  className="my-auto rounded p-1 text-dim outline-none transition-colors hover:bg-hover hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {planExtended ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                </button>
              )}
              <button
                type="button"
                aria-label={drawerOpen ? "Collapse drawer" : "Expand drawer"}
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen((open) => !open)}
                className="my-auto rounded p-1 text-dim outline-none transition-colors hover:bg-hover hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", !drawerOpen && "-rotate-90")} />
              </button>
            </div>
            {drawerOpen && (
              <div className="max-h-[280px] overflow-y-auto">
                <PlanTaskList bare overview={planExtended} document={planDocument} onOpenStage={onOpenPlanStage} />
              </div>
            )}
          </div>
        ))
         }

         function renderSendButton() {
           return (<Button
                variant="primary"
                size="icon"
                className="size-7 rounded-full"
              aria-label={busy ? "Queue ↵" : "Send ↵"}
              title={busy ? "Queue this message (↵)" : "Send (↵)"}
              onClick={send}
            >
              <ArrowUp size={14} />
            </Button>)
  }

  function getDisabledReason() {
           if (disabledReason !== undefined) return (<Pill tone="yellow" dot>
                {roomy ? disabledReason : "unavailable"}
              </Pill>)
           if (paused) return (<Pill tone="yellow" dot>
              {roomy ? "paused for approval" : "paused"}
            </Pill>)
           if (busy && onStop) return (<Button
              variant="primary"
              size="icon"
              className="size-7 rounded-full"
              aria-label="Stop"
              title="Stop the agent"
              onClick={onStop}
            >
              <Square size={12} fill="currentColor" />
            </Button>)
           return renderSendButton()
         }

  const selectedModel = providerCatalog?.connections
    .flatMap(({ models }) => models)
    .find((candidate) => candidate.id === modelId);
  const canonicalModes: ReadonlyArray<{
    readonly id: PermissionMode;
    readonly label: string;
    readonly kind: "execute" | "plan";
    readonly description?: string;
  }> = [
    ...MODE_OPTIONS.map((option) => ({
      id: option.value,
      label: String(option.label),
      kind: "execute" as const,
    })),
    { id: "plan" as const, label: "Plan", kind: "plan" as const },
  ];
  const modeOptions: ReadonlyArray<ComposerOption<PermissionMode>> = canonicalModes
    .filter((option) => allowPlan || option.kind !== "plan")
    .map((option) => ({
      value: option.id,
      label:
        option.label,
      description: option.description,
    }));
  const { reasoningEfforts, reasoningOptions } = composerReasoningOptions(selectedModel)
  // The chip's value and its bar count are the same fact; deriving it once keeps
  // the glyph from drifting out of step with the label beside it.
  const reasoningChoice: ReasoningChoice | "off" =
    thinkingEnabled === false ? "off" : (reasoningEffort ?? "default");
  const environmentOptions: ReadonlyArray<ComposerOption<string>> = [
    { value: "__local__", label: <span className="inline-flex min-w-0 items-center gap-1.5"><Monitor size={13} className="flex-none" aria-hidden data-environment-icon="local" /><span className="truncate">Local</span></span> },
    ...environments.map((environment) => ({ value: environment.id, label: <span className="inline-flex min-w-0 items-center gap-1.5">{environment.kind === "managed" ? <Cloud size={13} className="flex-none" aria-hidden data-environment-icon="cloud" /> : <Server size={13} className="flex-none" aria-hidden data-environment-icon="remote" />}<span className="truncate">{environment.name}{environment.state === "online" ? "" : ` · ${environment.state}`}</span></span> }))
  ];
  const setReasoningChoice = (value: ReasoningChoice | "off") =>
    onSetReasoning?.(
      value === "default"
        ? undefined
        : value === "off"
          ? { enabled: false }
          : { enabled: true, effort: value },
    );

  // The pane's tier (see `session-pane.tsx`). The composer sits in a 760px
  // reading column, so above `wide` it always has its full width; below it, the
  // column is the pane and every pixel is contested.
  const tier = useWidthTier();
  const roomy = atLeast(tier, "wide");
  const compactSettings = !atLeast(tier, "mid");

  const prompt = placeholder ?? "Message the agent…";

  // Controlled when the host passes `value`/`attachments` (the app, so drafts
  // outlive the pane's unmount); otherwise these locals own the draft. Seeded once
  // from `initialValue` — note that only ever applies in the UNCONTROLLED case, so
  // the lazy initializer can't go stale under a controlled host.
  const [internalValue, setInternalValue] = useState(() => initialValue ?? "");
  const [internalAttachments, setInternalAttachments] = useState<
    ReadonlyArray<Attachment>
  >([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [mcpApiKeyServer, setMcpApiKeyServer] = useState<McpServer | null>(null);
  const [mcpAuthSetupServer, setMcpAuthSetupServer] = useState<McpServer | null>(null);
  const [mcpActionError, setMcpActionError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Shims, so every call site below reads/writes exactly as it did when this was
  // plain local state — including the `setAttachments(prev => …)` updater form.
  const value = controlledValue ?? internalValue;
  const attachments = controlledAttachments ?? internalAttachments;

  // An updater must see the LATEST draft, not the one captured when this render
  // ran — two `addFiles` in flight at once (paste, paste again before the first
  // FileReader resolves) would otherwise both merge into the same stale array and
  // the first batch would vanish. These refs are written through on every set, so
  // calls that land in the same tick chain instead of racing.
  const valueRef = useRef(value);
  const attachmentsRef = useRef(attachments);
  valueRef.current = value;
  attachmentsRef.current = attachments;

  const setValue = (next: string | ((prev: string) => string)) => {
    const resolved = typeof next === "function" ? next(valueRef.current) : next;
    valueRef.current = resolved;
    if (controlledValue === undefined) setInternalValue(resolved);
    onValueChange?.(resolved);
  };
  const setAttachments = (
    next:
      | ReadonlyArray<Attachment>
      | ((prev: ReadonlyArray<Attachment>) => ReadonlyArray<Attachment>),
  ) => {
    const resolved =
      typeof next === "function" ? next(attachmentsRef.current) : next;
    attachmentsRef.current = resolved;
    if (controlledAttachments === undefined) setInternalAttachments(resolved);
    onAttachmentsChange?.(resolved);
  };
  const [dragging, setDragging] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  // Extend the Plan tab from the flat task list to the full plan overview
  // (stages with their nested subtasks) inside the drawer.
  const [planExtended, setPlanExtended] = useState(false);
  const planDrawerCounts = planDocument ? planTaskCounts(planDocument) : null;
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachIdRef = useRef(0);

  // Read dropped/pasted/picked image files into base64 attachments (capped).
  const addFiles = async (files: ReadonlyArray<File>) => {
    // The single choke point for every route in — button, paste and drop.
    const read = await Promise.all(
      files.map((f) => {
        // The counter is bumped as its own statement rather than inside the
        // template literal: an assignment in an expression position reads as a
        // comparison, and this one has a side effect per attachment.
        attachIdRef.current += 1;
        return readAttachment(f, `att_${attachIdRef.current}`);
      }),
    );
    const next = read.filter((a): a is Attachment => a !== null);
    if (next.length > 0)
      setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  // Opening a conversation puts the caret in its composer — the point of the app
  // is to type at an agent, so arriving anywhere else is a wasted keystroke.
  //
  // Deferred a frame because the pane mounts alongside the virtualized transcript,
  // which scrolls to the bottom on its first layout pass; focusing in the same
  // pass loses the caret to that scroll. Keyed on the session so replacing a
  // pane's session refocuses without an unmount, and gated on `autoFocus` so in a
  // split only the pane the operator is looking at takes it.
  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => {
      if (document.hasFocus()) ref.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [autoFocus, focusKey]);

  // The textarea auto-grows in LAYOUT (`field-sizing: content`), not from a
  // measurement taken here — see the note on the element itself.
  const skillMatches = useMemo(
    () =>
      menu?.kind === "slash"
        ? skills.filter((s) =>
            s.name.toLowerCase().includes(menu.query.toLowerCase()),
  )
        : [],
    [menu, skills],
  );
  const fileMatches = useMemo(
    () =>
      menu?.kind === "mention"
        ? files
            .filter((f) => f.toLowerCase().includes(menu.query.toLowerCase()))
            .slice(0, 50)
        : [],
    [menu, files],
  );
  const count =
    menu?.kind === "slash" ? skillMatches.length : fileMatches.length;

  const mentions = useMemo(
    () => [...value.matchAll(/@(\S+)/g)].map((m) => m[1]!),
    [value],
  );

  const sync = (next: string, caret: number) => {
    setValue(next);
    setMenu(activeToken(next, caret));
    setActiveIndex(0);
  };

  const replaceToken = (insert: string) => {
    if (!menu) return;
    const before = value.slice(0, menu.start);
    const after = value.slice(menu.start + 1 + menu.query.length);
    const next = `${before}${insert} ${after}`;
    setValue(next);
    setMenu(null);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const send = () => {
    const text = value.trim();
    if (
      (text.length === 0 &&
        attachments.length === 0 &&
        codeReferences.length === 0) ||
      paused ||
      disabledReason !== undefined
    )
      return;
    onSend?.(text, attachments);
    setValue("");
    setAttachments([]);
    onCodeReferencesClear?.();
    setMenu(null);
  };

  const openSkills = () => {
    const separator =
      value.length > 0 && !TRAILING_SPACE.test(value) ? " " : "";
    const next = `${value}${separator}/`;
    setValue(next);
    setMenu({ kind: "slash", query: "", start: next.length - 1 });
    setActiveIndex(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  // Pasting an image (e.g. a screenshot) attaches it instead of dropping a blob.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && count > 0) {
      switch (e.key) {
case "ArrowDown": {

        e.preventDefault();
        setActiveIndex((i) => (i + 1) % count);
        return;

}
case "ArrowUp": {

        e.preventDefault();
        setActiveIndex((i) => (i - 1 + count) % count);
        return;

}
case "Enter":
case "Tab": {

        e.preventDefault();
        if (menu.kind === "slash") {
          replaceToken(skillInsertion(skillMatches[activeIndex]!));
        } else replaceToken(`@${fileMatches[activeIndex]!}`);
        return;

}
case "Escape": {

        e.preventDefault();
        setMenu(null);
        return;

}
}
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
  }
  };

  return (
    // `data-testid` anchors the e2e geometry assertions: they measure where the
    // composer's OUTER box sits in its pane, which the textarea alone cannot
    // stand in for (the model / mode / Send row hangs ~80px below it).
    <div
      data-testid="composer"
      className={cn("relative flex flex-col gap-2", className)}
    >
      {renderAutocomplete()}

      <PromptInputSurface
        // Keep the mode available to tests and integrations without tinting the
        // composer chrome. The selected menu item carries the state.
        data-mode={mode}
        onDragOver={(e) => {
          if (paused || disabledReason !== undefined) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (paused || disabledReason !== undefined) return;
          const files = Array.from(e.dataTransfer.files).filter((f) =>
            f.type.startsWith("image/"),
          );
          if (files.length === 0) return;
          e.preventDefault();
          void addFiles(files);
        }}
        className={cn(
          "relative w-full flex flex-col gap-3 rounded-2xl border-line/80 bg-panel px-4 py-3.5 shadow-none transition-colors focus-within:border-text-bright/25 focus-within:shadow-none",
          (paused || disabledReason !== undefined) && "opacity-60",
          // A drag-over is the only temporary coloured border.
          dragging && "border-cyan/60 bg-cyan/5 shadow-none",
        )}
      >
        {renderPlanDrawer()}
        {(codeReferences.length > 0 || mentions.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {codeReferences.map((reference, index) => (
              <CodeChip
                key={`${reference.path}:${reference.startLine}:${reference.endLine}`}
                path={reference.path}
                line={reference.startLine}
                label={reference.label}
                onRemove={() => onCodeReferenceRemove?.(index)}
              />
            ))}
            {mentions.map((path, i) => (
              <CodeChip
                key={`${path}-${i}`}
                path={path}
                onRemove={() =>
                  setValue((v) =>
                    v
                      .replace(`@${path}`, "")
                      .replace(/\s{2,}/g, " ")
                      .trimStart(),
                  )
                }
              />
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentThumb
                key={a.id}
                attachment={a}
                onRemove={() => removeAttachment(a.id)}
                className="size-[58px]"
              />
            ))}
            {attachments.length < MAX_ATTACHMENTS && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                className="flex size-[58px] flex-none flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-line text-dim outline-none transition-colors hover:border-line-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus size={15} />
                <span className="text-[8.5px]">Add</span>
              </button>
            )}
          </div>
        )}
        {renderDraftInput()}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {/*
          `flex-wrap` + `min-w-0`, and both are load-bearing.

          This row held eight controls with no wrap and no `min-w-0` anywhere in
          the file. The model chip carries variable-length text, and `Button` is
          `whitespace-nowrap`, so the row's
          min-content floor sat well past the composer's own border — the
          controls didn't degrade, they overflowed the rounded box and got
          clipped. Wrapping is the right failure mode here rather than scrolling:
          a composer toolbar is a set of unrelated controls, not a sequence, so a
          second line costs nothing but 26px of height.
        */}
        {renderComposerToolbar()}
        {renderContextControls()}
      </PromptInputSurface>
      <ComposerMcpDialogs
        error={mcpActionError}
        add={onAddMcp}
        addOpen={mcpDialogOpen}
        onAddOpenChange={setMcpDialogOpen}
        apiKeyServer={mcpApiKeyServer}
        onApiKeyServerChange={setMcpApiKeyServer}
        authSetupServer={mcpAuthSetupServer}
        onAuthSetupServerChange={setMcpAuthSetupServer}
        setApiKey={onSetMcpApiKey}
        setAuth={onSetMcpAuth}
        authorize={onAuthorizeMcp}
      />
    </div>
  );
}
