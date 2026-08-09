import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Attachment,
  CliKind,
  Environment,
  HarnessCapability,
  PermissionMode,
  ProviderModels,
  ReasoningEffort,
  ReasoningSetting,
  Skill,
} from "@jingler/core";
import {
  ArrowUp,
  FolderGit2,
  GitBranch,
  ImagePlus,
  Monitor,
  MousePointer2,
  Plus,
  Server,
  Sparkles,
  Square,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { downscaleImage } from "../lib/image-downscale.js";
import { atLeast, useWidthTier } from "../hooks/width-tier.js";
import { AttachmentThumb } from "../components/attachment-thumb.js";
import { Button } from "../components/button.js";
import { ChipMenu, type ChipOption } from "../components/chip-menu.js";
import { CodeChip } from "../components/code-chip.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.js";
import { Pill } from "../components/pill.js";
import { PROVIDER_LABEL } from "../components/provider-icon.js";
import { SignalBars } from "../components/signal-bars.js";
import { StatusDot } from "../components/status-dot.js";
import { CommandMenu } from "./command-menu.js";
import { MentionMenu } from "./mention-menu.js";
import { ModelBrowser } from "./model-browser.js";

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

const MODE_OPTIONS: ReadonlyArray<ChipOption<PermissionMode>> = [
  { value: "ask", label: "Ask Before Actions" },
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Full Access" },
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
const skillInsertion = (cli: CliKind | undefined, skill: Skill): string =>
  cli === "codex" && skill.source === "skill"
    ? `$${skill.name.slice(1)}`
    : skill.name;

/**
 * The prompt composer — a real controlled textarea with Enter-to-send /
 * Shift+Enter newline, plus two typeahead palettes: `/` surfaces the harness's
 * skills (harness-agnostic) and `@` references worktree files as code chips.
 */
export function Composer({
  skills = [],
  files = [],
  onSend,
  onStop,
  branch,
  repo,
  environments = [],
  environmentId,
  environmentPending = false,
  onSetEnvironment,
  cli,
  model,
  catalog = [],
  capabilities,
  onSetHarness,
  mode = "accept-edits",
  onSetMode,
  useJinglerTools = true,
  followAgent = false,
  onToggleFollowAgent,
  reasoningEffort,
  thinkingEnabled,
  onSetReasoning,
  allowPlan = false,
  paused = false,
  disabledReason,
  busy = false,
  placeholder,
  autoFocus = false,
  focusKey,
  initialValue,
  value: controlledValue,
  onValueChange,
  attachments: controlledAttachments,
  onAttachmentsChange,
  codeReferences = [],
  onCodeReferenceRemove,
  onCodeReferencesClear,
  className,
}: {
  skills?: ReadonlyArray<Skill>;
  files?: ReadonlyArray<string>;
  onSend?: (text: string, images?: ReadonlyArray<Attachment>) => void;
  /** Halt the running agent. Given one, the button becomes Stop while `busy`. */
  onStop?: () => void;
  /** Git branch backing this session's worktree. */
  branch?: string;
  /** Repository name backing this session — shown at the composer's bottom-left. */
  repo?: string;
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
  /** The session's current harness (which section of the menu is checked). */
  cli?: CliKind;
  /** Current harness model id (shown in the model chip). */
  model?: string;
  /** Installed harnesses and their models — the model chip's sectioned menu. */
  catalog?: ReadonlyArray<ProviderModels>;
  /** Authoritative provider/model/mode/reasoning snapshot. */
  capabilities?: ReadonlyArray<HarnessCapability>;
  /** Picking a model implies its harness, so both travel together. */
  onSetHarness?: (cli: CliKind, model: string) => void;
  /** Current HITL mode (shown in the mode chip; Shift+Tab cycles it). */
  mode?: PermissionMode;
  onSetMode?: (mode: PermissionMode) => void;
  /** Enhanced Plan replaces provider-native Plan while Jingler tools are enabled. */
  useJinglerTools?: boolean;
  /** Whether Files is following mutations from this chat's active agent. */
  followAgent?: boolean;
  /** Toggle the session file browser's shared agent-follow mode. */
  onToggleFollowAgent?: (enabled: boolean) => void;
  /** Per-session thinking strength; absent preserves the harness default. */
  reasoningEffort?: ReasoningEffort;
  thinkingEnabled?: boolean;
  onSetReasoning?: (reasoning?: ReasoningSetting) => void;
  /** Offer the Plan mode option (harnesses that pass `supportsPlanMode`). */
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
}) {
  const resolvedCapabilities = useMemo<ReadonlyArray<HarnessCapability>>(
    () =>
      capabilities ??
      catalog.map((provider) => ({
        ...provider,
        modes: [
          ...MODE_OPTIONS.map((option) => ({
            id: option.value,
            label: String(option.label),
            kind: "execute" as const,
          })),
          ...(allowPlan
            ? [{ id: "plan" as const, label: "Plan", kind: "plan" as const }]
            : []),
        ],
      })),
    [allowPlan, capabilities, catalog],
  );
  const selectedCapability = resolvedCapabilities.find(
    (candidate) => candidate.cli === cli,
  );
  const selectedModel = selectedCapability?.models.find(
    (candidate) => candidate.id === model,
  );
  const modeOptions: ReadonlyArray<ChipOption<PermissionMode>> = (
    selectedCapability?.modes ?? []
  )
    .filter((option) => allowPlan || option.kind !== "plan")
    .map((option) => ({
      value: option.id,
      label:
        useJinglerTools && option.kind === "plan"
          ? "Enhanced Plan"
          : option.label,
      description: option.description,
    }));
  const reasoningEfforts = (selectedModel?.reasoning ?? []).map(
    (option) => option.id,
  );
  const reasoningOptions: ReadonlyArray<ChipOption<ReasoningChoice | "off">> = [
    { value: "default", label: "Default" },
    { value: "off", label: "Off" },
    ...(selectedModel?.reasoning ?? []).map((option) => ({
      value: option.id,
      label: option.label,
    })),
  ];
  // The chip's value and its bar count are the same fact; deriving it once keeps
  // the glyph from drifting out of step with the label beside it.
  const reasoningChoice: ReasoningChoice | "off" =
    thinkingEnabled === false ? "off" : (reasoningEffort ?? "default");

  // The pane's tier (see `session-pane.tsx`). The composer sits in a 760px
  // reading column, so above `wide` it always has its full width; below it, the
  // column is the pane and every pixel is contested.
  const tier = useWidthTier();
  const roomy = atLeast(tier, "wide");

  // Follows the harness — the prompt used to be hardwired to "Message Claude…",
  // which now visibly lies the moment the operator switches provider.
  const prompt = placeholder ?? `Message ${PROVIDER_LABEL[cli ?? "claude"]}…`;

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
    const id = requestAnimationFrame(() => ref.current?.focus());
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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % count);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + count) % count);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (menu.kind === "slash") {
          replaceToken(skillInsertion(cli, skillMatches[activeIndex]!));
        } else replaceToken(`@${fileMatches[activeIndex]!}`);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
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
      {menu && count > 0 && (
        <div className="absolute inset-x-0 bottom-full z-10 mb-2">
          {menu.kind === "slash" ? (
            <CommandMenu
              skills={skillMatches}
              activeIndex={activeIndex}
              onSelect={(skill) => replaceToken(skillInsertion(cli, skill))}
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
      )}

      <div
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
          "flex flex-col gap-3 rounded-2xl border border-line bg-sunken px-4 py-3.5 transition-colors",
          (paused || disabledReason !== undefined) && "opacity-70",
          // A drag-over is the only temporary coloured border.
          dragging && "border-cyan/60 bg-cyan/5 shadow-none",
        )}
      >
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
        <textarea
          ref={ref}
          value={value}
          disabled={paused || disabledReason !== undefined}
          placeholder={
            disabledReason ??
            (paused
              ? "Reply, or answer the prompt above…"
              : busy
                ? "Queue a message while the agent works…"
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
        />
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5 [&>button]:min-h-8">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Composer menu"
                title="Add context"
                disabled={paused || disabledReason !== undefined}
                className="flex size-8 flex-none items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-surface hover:text-text-bright disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus size={17} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-[220px]">
                <DropdownMenuItem
                  onSelect={() => fileInputRef.current?.click()}
                >
                  <ImagePlus
                    size={15}
                    className="flex-none text-muted-foreground"
                  />
                  <span className="flex-1">Add image</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={skills.length === 0}
                  onSelect={openSkills}
                >
                  <Sparkles
                    size={15}
                    className="flex-none text-muted-foreground"
                  />
                  <span className="flex-1">Skills</span>
                  {skills.length > 0 && (
                    <span className="font-mono text-[10.5px] text-dim">
                      {skills.length}
                    </span>
                  )}
                </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
          {onSetEnvironment && (
            <ChipMenu
              value={environmentId ?? "__local__"}
              options={[
                {
                  value: "__local__",
                  searchText: "Local",
                  label: (
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Monitor
                        size={13}
                        className="flex-none"
                        aria-hidden
                        data-environment-icon="local"
                      />
                      <span className="truncate">Local</span>
                    </span>
                  ),
                },
                ...environments.map((environment) => ({
                  value: environment.id,
                  searchText: `${environment.name} ${environment.state}`,
                  label: (
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Server
                        size={13}
                        className="flex-none"
                        aria-hidden
                        data-environment-icon="remote"
                      />
                      <span className="truncate">
                        {environment.name}
                        {environment.state === "online"
                          ? ""
                          : ` · ${environment.state}`}
                      </span>
                    </span>
                  ),
                })),
              ]}
              onSelect={(value) =>
                onSetEnvironment(value === "__local__" ? undefined : value)
              }
              disabled={busy || environmentPending}
              appearance="quiet"
              ariaLabel="Execution environment"
              className="max-w-[150px]"
            />
          )}
          <ModelBrowser
            cli={cli}
            model={model}
            capabilities={resolvedCapabilities}
            onSelect={onSetHarness}
            className={roomy ? "max-w-[190px]" : "max-w-[112px]"}
          />
          <ChipMenu
            value={mode}
            options={modeOptions}
            onSelect={onSetMode}
            appearance="quiet"
            // Quiet chrome sizes to its current label instead of reserving
            // permanent toolbar space; cap long modes inside narrow panes.
            className="max-w-[104px]"
          />
          <ChipMenu
            value={reasoningChoice}
            options={reasoningOptions}
            onSelect={(value) =>
              onSetReasoning?.(
                value === "default"
                  ? undefined
                  : value === "off"
                    ? { enabled: false }
                    : { enabled: true, effort: value },
              )
            }
            appearance="quiet"
            ariaLabel="Thinking strength"
            icon={
              <SignalBars
                level={reasoningLevel(reasoningEfforts, reasoningChoice)}
                total={reasoningEfforts.length}
                slashed={thinkingEnabled === false}
              />
            }
            className="max-w-[112px]"
          />
          {/* `min-w-[8px]` so the spacer still exists after a wrap — a bare
              `flex-1` on a wrapped line collapses to nothing and the send button
              ends up butted against the last chip. */}
          <div className="min-w-[8px] flex-1" />
          {/* The send/stop control is `flex-none` and LAST in DOM order, which
              together decide what a squeeze does: the row wraps the chips above
              it and the primary action keeps its full size on the trailing line,
              rather than being the thing pushed past the border. */}
          <span className="flex-none">
            {disabledReason !== undefined ? (
              <Pill tone="yellow" dot>
                {roomy ? "harness unavailable" : "unavailable"}
              </Pill>
            ) : paused ? (
            <Pill tone="yellow" dot>
              {roomy ? "paused for approval" : "paused"}
            </Pill>
          ) : busy && onStop ? (
            /* While the agent works, the button halts it. Queueing doesn't go
               away — it moves to the keyboard: ↵ still queues a follow-up, which
               is what the placeholder advertises. No "⎋" hint here: Escape only
               fires while the composer is UNfocused, so it wouldn't work from
               where the cursor is when you're reading this button.

               Icon-only, so `aria-label` IS the accessible name — the label the
               tests and screen readers both read. `title` carries the longer
               form the visible text used to. */
            <Button
              variant="danger"
              size="icon"
              className="size-8"
              aria-label="Stop"
              title="Stop the agent"
              onClick={onStop}
            >
              <Square size={12} fill="currentColor" />
            </Button>
          ) : (
              <Button
                variant="primary"
                size="icon"
                className="size-7 rounded-full"
              aria-label={busy ? "Queue ↵" : "Send ↵"}
              title={busy ? "Queue this message (↵)" : "Send (↵)"}
              onClick={send}
            >
              <ArrowUp size={14} />
            </Button>
          )}
          </span>
        </div>
        {/* Lower row: repository sits bottom-left as quiet metadata, the working
            branch bottom-right on the same line — `justify-between` splits them.
            An empty span holds the left slot when there is no repo, so a lone
            branch still lands on the right. */}
        {(repo || branch) && (
          <div className="flex items-center justify-between gap-2 px-1.5 pt-1 font-mono text-[10.5px] text-dim">
            {repo ? (
              <span
                title={`Repository: ${repo}`}
                className="flex min-w-0 items-center gap-1"
              >
                <FolderGit2 size={12} className="flex-none" />
                <span className="truncate">{repo}</span>
              </span>
            ) : (
              <span />
            )}
            {branch && (
              <span
                title={`Working branch: ${branch}`}
                className="flex min-w-0 max-w-[180px] items-center gap-1"
              >
                <GitBranch size={12} className="flex-none" />
                <span className="truncate">{branch}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
