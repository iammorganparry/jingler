import { selectEdgeValues, selectOptionIndex } from "./select-layout.js"
"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import {
  motion,
  type Transition,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EASE_OUT } from "./ease.js";
import { cn } from "../../lib/cn.js";

const INSTANT_TRANSITION: Transition = { duration: 0 };

// Spring with bounce powers the unfold/separation; per-property timings in the
// content choreograph it (see SelectContent). Mirrors bouncy-accordion's feel.
const CHEVRON_TRANSITION: Transition = {
  type: "spring",
  duration: 0.4,
  bounce: 0.3,
};

const LIST_VARIANTS: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.05 } },
};
const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -6, filter: "blur(3px)" },
  // `transitionEnd` takes the landed blur off the item — see action-swap.tsx.
  show: { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } },
};

export type SelectPlacement = "bottom" | "top";

interface SelectContextValue {
  value: string | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
  select: (value: string) => void;
  register: (value: string, label: string) => void;
  unregister: (value: string) => void;
  labelFor: (value: string | undefined) => string | undefined;
  reduce: boolean;
  triggerId: string;
  listId: string;
  disabled: boolean;
  placement: SelectPlacement;
  fixedPlacement?: SelectPlacement;
  setPlacement: (p: SelectPlacement) => void;
}

const SelectContext = createContext<SelectContextValue | null>(null);

function useSelectContext(component: string) {
  const ctx = useContext(SelectContext);
  if (!ctx) throw new Error(`${component} must be used within <Select>`);
  return ctx;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /**
   * Controlled open state of the panel. A layout that stacks selects can hold
   * this to keep exactly one panel open — the panel is absolutely positioned
   * inside its field, so two open at once paint over each other's options.
   */
  open?: boolean;
  /** Uncontrolled initial open state. Default false. */
  defaultOpen?: boolean;
  /**
   * Fires whenever the panel opens or closes. The panel is absolutely
   * positioned inside the field, so a layout that stacks selects has to know
   * which one is open to paint it above its neighbours.
   */
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  placement?: SelectPlacement;
  className?: string;
  children: ReactNode;
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  placement: fixedPlacement,
  className,
  children,
}: SelectProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [internal, setInternal] = useState(defaultValue);
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [placement, setPlacement] = useState<SelectPlacement>(fixedPlacement ?? "bottom");

  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const openControlled = openProp !== undefined;
  const open = openControlled ? openProp : internalOpen;

  useLayoutEffect(() => {
    if (fixedPlacement) setPlacement(fixedPlacement);
  }, [fixedPlacement]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!openControlled) setInternalOpen(next);
      if (!next) setQuery("");
      onOpenChange?.(next);
    },
    [onOpenChange, openControlled],
  );

  const select = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      onValueChange?.(next);
      setOpen(false);
      requestAnimationFrame(() => document.getElementById(`${baseId}-trigger`)?.focus());
    },
    [baseId, controlled, onValueChange, setOpen],
  );

  const register = useCallback((v: string, label: string) => {
    setLabels((m) => (m.get(v) === label ? m : new Map(m).set(v, label)));
  }, []);
  const unregister = useCallback((v: string) => {
    setLabels((m) => {
      if (!m.has(v)) return m;
      const next = new Map(m);
      next.delete(v);
      return next;
    });
  }, []);

  // close on outside pointer / escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, setOpen]);

  const ctx = useMemo<SelectContextValue>(
    () => ({
      value: current,
      open,
      setOpen,
      query,
      setQuery,
      select,
      register,
      unregister,
      labelFor: (v) => (v === undefined ? undefined : labels.get(v)),
      reduce,
      triggerId: `${baseId}-trigger`,
      listId: `${baseId}-list`,
      disabled,
      placement,
      fixedPlacement,
      setPlacement,
    }),
    [
      current,
      open,
      query,
      setOpen,
      select,
      register,
      unregister,
      labels,
      reduce,
      baseId,
      disabled,
      placement,
      fixedPlacement,
    ],
  );

  return (
    <SelectContext.Provider value={ctx}>
      <div ref={rootRef} className={cn("relative", className)}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

export interface SelectTriggerProps {
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
  "aria-label"?: string;
}

export function SelectTrigger({
  className,
  children,
  ariaLabel,
  "aria-label": ariaLabelAttribute,
}: SelectTriggerProps) {
  const ctx = useSelectContext("SelectTrigger");
  const isTop = ctx.placement === "top";
  const focusChoice = (edge: "first" | "last" = "first") => requestAnimationFrame(() => {
    const list = document.getElementById(ctx.listId);
    const search = list?.parentElement?.querySelector<HTMLInputElement>("input");
    if (search) return search.focus();
    const options = [...(list?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
    const selected = options.find((option) => option.getAttribute("aria-selected") === "true");
    (selected ?? options[edge === "first" ? 0 : options.length - 1])?.focus();
  });
  // edge facing the panel flattens then rounds; the far edge stays rounded.
  // All four corners are specified so none gets stranded when placement flips.
  const kf = ctx.open ? [0, 0, 12] : [12, 0, 12];
  const kfT: Transition = ctx.reduce
    ? { duration: 0 }
    : ctx.open
      ? { duration: 0.6, times: [0, 0.4, 1], ease: EASE_OUT }
      : { duration: 0.42, times: [0, 0.5, 1], ease: EASE_OUT };
  return (
    <motion.button
      type="button"
      id={ctx.triggerId}
      disabled={ctx.disabled}
      aria-haspopup="listbox"
      aria-label={ariaLabel ?? ariaLabelAttribute}
      aria-expanded={ctx.open}
      aria-controls={ctx.listId}
      onClick={() => {
        const next = !ctx.open;
        ctx.setOpen(next);
        if (next) focusChoice();
      }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
        event.preventDefault();
        if (!ctx.open) ctx.setOpen(true);
        focusChoice(event.key === "ArrowUp" ? "last" : "first");
      }}
      // Gooey: the edge facing the panel snaps flat (panel attached) then rounds
      // back once the panel pulls away — the two pinch apart.
      initial={false}
      animate={{
        borderTopLeftRadius: isTop ? kf : 12,
        borderTopRightRadius: isTop ? kf : 12,
        borderBottomLeftRadius: isTop ? 12 : kf,
        borderBottomRightRadius: isTop ? 12 : kf,
      }}
      transition={{
        borderTopLeftRadius: isTop ? kfT : INSTANT_TRANSITION,
        borderTopRightRadius: isTop ? kfT : INSTANT_TRANSITION,
        borderBottomLeftRadius: isTop ? INSTANT_TRANSITION : kfT,
        borderBottomRightRadius: isTop ? INSTANT_TRANSITION : kfT,
      }}
      className={cn(
        "relative z-10 flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-text-bright outline-none transition-colors",
        "hover:border-line-strong focus-visible:ring-2 focus-visible:ring-ring/20",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {children}
      <motion.span
        aria-hidden
        animate={{ rotate: ctx.open ? 180 : 0 }}
        transition={ctx.reduce ? { duration: 0 } : CHEVRON_TRANSITION}
        className="text-muted-foreground"
      >
        <ChevronDown className="h-4 w-4" />
      </motion.span>
    </motion.button>
  );
}

export interface SelectValueProps {
  placeholder?: string;
  className?: string;
}

export function SelectValue({ placeholder, className }: SelectValueProps) {
  const ctx = useSelectContext("SelectValue");
  const label = ctx.labelFor(ctx.value);
  return (
    <span
      className={cn(
        label ? "text-text-bright" : "text-muted-foreground",
        className,
      )}
    >
      {label ?? placeholder ?? "Select"}
    </span>
  );
}

export interface SelectSearchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue" | "value"
> {
  wrapperClassName?: string;
}

export function SelectSearch({
  className,
  wrapperClassName,
  autoFocus = false,
  onChange,
  onKeyDown,
  ...props
}: SelectSearchProps) {
  const ctx = useSelectContext("SelectSearch");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!ctx.open || !autoFocus) return;
    const frame = requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, ctx.open]);
  return (
    <div
      className={cn(
        "mx-1 mt-1 flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2",
        wrapperClassName,
      )}
    >
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        {...props}
        ref={inputRef}
        value={ctx.query}
        onChange={(event) => {
          ctx.setQuery(event.target.value);
          onChange?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") ctx.setOpen(false);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const options = [...(document.getElementById(ctx.listId)?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
            options[event.key === "ArrowDown" ? 0 : options.length - 1]?.focus();
          }
          event.stopPropagation();
          onKeyDown?.(event);
        }}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-xs text-text-bright outline-none placeholder:text-muted-foreground",
          className,
        )}
      />
    </div>
  );
}

const boundedSelectListHeight = ({
  inline,
  placement,
  maximum,
  trigger,
  inner,
  list
}: {
  inline: boolean
  placement: SelectPlacement
  maximum: number
  trigger: HTMLElement
  inner: HTMLElement
  list: HTMLElement
}): number => {
  const triggerRect = trigger.getBoundingClientRect()
  let available = window.innerHeight - triggerRect.bottom - 16
  if (inline) available = window.innerHeight - inner.getBoundingClientRect().top - 16
  else if (placement === "top") available = triggerRect.top - 16
  return Math.max(0, Math.min(maximum, available - (inner.offsetHeight - list.offsetHeight)))
}

const useBoundedSelectListHeight = ({
  open,
  inline,
  placement,
  maximum,
  triggerId,
  listId,
  innerRef
}: {
  open: boolean
  inline: boolean
  placement: SelectPlacement
  maximum?: number
  triggerId: string
  listId: string
  innerRef: { readonly current: HTMLDivElement | null }
}): number | undefined => {
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    if (!open || maximum === undefined) return
    const measure = () => {
      const trigger = document.getElementById(triggerId)
      const list = document.getElementById(listId)
      const inner = innerRef.current
      if (!trigger || !list || !inner) return
      setHeight(boundedSelectListHeight({ inline, placement, maximum, trigger, inner, list }))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [inline, innerRef, listId, maximum, open, placement, triggerId])
  return height
}

export interface SelectContentProps {
  className?: string;
  listClassName?: string;
  listMaxHeight?: number;
  children: ReactNode;
  search?: ReactNode;
  inline?: boolean;
}

export function SelectContent({
  className,
  listClassName,
  listMaxHeight,
  children,
  search,
  inline = false,
}: SelectContentProps) {
         function getMotionState() {
           return (ctx.reduce
          ? { opacity: open ? 1 : 0, height: open ? height : 0 }
          : getContentAnimation())
         }

         function getContentTransition() {
           if (ctx.reduce) return ({ duration: 0.12 })
return ({
              opacity: open
                ? { duration: 0.18 }
                : { duration: 0.16, delay: 0.12 },
              height: open
                ? { type: "spring", duration: 0.42, bounce: 0.14 }
                : { duration: 0.26, ease: EASE_OUT, delay: 0.14 },
              ...selectEdgeValues(isTop, gapT, INSTANT_TRANSITION, radiusT, INSTANT_TRANSITION),
            })
         }

         function getContentAnimation() {
           return ({
              opacity: open ? 1 : 0,
              height: open ? height : 0,
              ...selectEdgeValues(isTop, nearGap, 0, nearRadius, 12),
            })
         }

  const ctx = useSelectContext("SelectContent");
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const open = ctx.open;
  const boundedListHeight = useBoundedSelectListHeight({
    open,
    inline,
    placement: ctx.placement,
    maximum: listMaxHeight,
    triggerId: ctx.triggerId,
    listId: ctx.listId,
    innerRef
  });
  const [present, setPresent] = useState(open);
  const { setPlacement } = ctx;

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timeout = window.setTimeout(
      () => setPresent(false),
      ctx.reduce ? 120 : 450,
    );
    return () => window.clearTimeout(timeout);
  }, [ctx.reduce, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = innerRef.current;
    if (!node) return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open]);

  // On open, flip upward when there isn't room below and there's more above.
  useLayoutEffect(() => {
    if (!open || inline) return;
    if (ctx.fixedPlacement) {
      setPlacement(ctx.fixedPlacement);
      return;
    }
    const trigger = document.getElementById(ctx.triggerId);
    const node = innerRef.current;
    if (!trigger || !node) return;
    const rect = trigger.getBoundingClientRect();
    const h = node.offsetHeight;
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    setPlacement(below < h + 16 && above > below ? "top" : "bottom");
  }, [open, inline, ctx.fixedPlacement, ctx.triggerId, setPlacement]);

  // Specify EVERY corner + both margins each render. The near edge (facing the
  // trigger) animates flat->round and the gap opens on that side; the far edge
  // stays rounded and its margin pinned to 0. Setting all of them avoids a
  // stranded square corner when the placement flips between opens.
  const isTop = !inline && ctx.placement === "top";
  const nearGap = open ? 8 : 0;
  const nearRadius = open ? 12 : 0;

  const gapT: Transition = open
    ? { type: "spring", duration: 0.6, bounce: 0.5, delay: 0.12 }
    : { type: "spring", duration: 0.3, bounce: 0.1 };
  const radiusT: Transition = open
    ? { duration: 0.3, ease: EASE_OUT, delay: 0.14 }
    : { duration: 0.16, ease: EASE_OUT };

  // Items stay mounted (open just animates the panel) so each item's label
  // registration persists — otherwise the trigger would fall back to the
  // placeholder the moment the panel closes.
  return (
    <motion.div
      data-side={isTop ? "top" : "bottom"}
      aria-hidden={!open}
      inert={!open}
      initial={false}
      animate={
        getMotionState()
      }
      transition={
        getContentTransition()
      }
      style={{
        display: open || present ? undefined : "none",
        transformOrigin: isTop ? "bottom" : "top",
        overflow: "hidden",
        pointerEvents: open ? "auto" : "none",
      }}
      // flush against the trigger, then separates into its own rounded pill;
      // sits above or below depending on available space
      className={cn(
        "z-20 rounded-xl border border-line bg-panel shadow-lg",
        inline ? "relative inset-auto" : "absolute left-0 right-0",
        !inline && (isTop ? "bottom-full" : "top-full"),
        className,
      )}
    >
      <div ref={innerRef} className="p-1">
        {search}
        <motion.ul
          id={ctx.listId}
          role="listbox"
          aria-labelledby={ctx.triggerId}
          className={listClassName}
          style={{ maxHeight: boundedListHeight }}
          variants={ctx.reduce ? undefined : LIST_VARIANTS}
          initial={false}
          animate={open ? "show" : "hidden"}
        >
          {children}
        </motion.ul>
      </div>
    </motion.div>
  );
}

export interface SelectItemProps {
  value: string;
  disabled?: boolean;
  className?: string;
  textValue?: string;
  children: ReactNode;
}

export function SelectItem({
  value,
  disabled = false,
  className,
  textValue,
  children,
}: SelectItemProps) {
  const ctx = useSelectContext("SelectItem");
  const selected = ctx.value === value;
  const label = textValue ?? (typeof children === "string" ? children : value);
  const visible =
    !ctx.query.trim() ||
    label.toLocaleLowerCase().includes(ctx.query.trim().toLocaleLowerCase());

  useLayoutEffect(() => {
    ctx.register(value, label);
    return () => ctx.unregister(value);
  }, [ctx.register, ctx.unregister, value, label]);

  if (!visible) return null;
  return (
    <motion.li variants={ctx.reduce ? undefined : ITEM_VARIANTS}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        data-value={value}
        disabled={disabled}
        onClick={() => ctx.select(value)}
        onKeyDown={(event) => {
          const options = [...(document.getElementById(ctx.listId)?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
          const current = options.indexOf(event.currentTarget);
          if (event.key === "Escape") {
            event.preventDefault();
            ctx.setOpen(false);
            document.getElementById(ctx.triggerId)?.focus();
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = selectOptionIndex(event.key, current, options.length);
            options[next]?.focus();
          }
        }}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors",
          selected
            ? "bg-surface text-text-bright"
            : "text-muted-foreground hover:bg-surface hover:text-text-bright focus-visible:bg-surface",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        {children}
        {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
      </button>
    </motion.li>
  );
}
