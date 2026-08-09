import type { Skill } from "@jingler/core"
import { Command, CommandItem, CommandList } from "../components/command.js"
import { cn } from "../lib/cn.js"
import { SlashCommandRow } from "./slash-command-row.js"

/**
 * The `/` command palette that surfaces the harness's skills + built-in commands.
 * Presentational + controlled: the composer owns the query/active index and
 * filters, this renders the floating list. `skills` come from the harness (so the
 * menu is model-agnostic).
 */
export function CommandMenu({
  skills,
  activeIndex,
  onSelect,
  onHover,
  className
}: {
  skills: ReadonlyArray<Skill>
  activeIndex: number
  onSelect: (skill: Skill) => void
  onHover?: (index: number) => void
  className?: string
}) {
  if (skills.length === 0) return null
  return (
    <Command
      shouldFilter={false}
      className={cn(
        "rounded-xl border border-line shadow-2xl",
        className
      )}
    >
      <CommandList className="max-h-[260px]">
        {skills.map((skill, i) => (
          <CommandItem
            key={skill.name}
            value={skill.name}
            aria-selected={i === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onSelect={() => onSelect(skill)}
            onMouseEnter={() => onHover?.(i)}
            className={cn("p-0", i === activeIndex && "bg-surface")}
          >
            <SlashCommandRow
              name={skill.name}
              description={skill.description}
              glyphTone={skill.source === "skill" ? "purple" : "blue"}
              badge={skill.source === "skill" ? "skill" : undefined}
              badgeTone="purple"
              active={i === activeIndex}
            />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
