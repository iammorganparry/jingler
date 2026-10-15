import type { Skill } from "@jingler/core"
import { Command, CommandGroup, CommandItem, CommandList } from "../components/command.js"
import { cn } from "../lib/cn.js"
import { AutocompleteMenu } from "./autocomplete-menu.js"
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
  query = "",
  onSelect,
  onHover,
  className
}: {
  skills: ReadonlyArray<Skill>
  activeIndex: number
  query?: string
  onSelect: (skill: Skill) => void
  onHover?: (index: number) => void
  className?: string
}) {
  // The composer owns the order (commands before skills); indices stay global.
  const indexed = skills.map((skill, index) => ({ skill, index }))
  const groups = [
    { heading: "Commands", rows: indexed.filter(({ skill }) => skill.source === "command") },
    { heading: "Skills", rows: indexed.filter(({ skill }) => skill.source === "skill") }
  ]
  return (
    <AutocompleteMenu trigger="/" query={query} empty={skills.length === 0} className={className}>
      <Command shouldFilter={false} className="rounded-none">
        <CommandList className="max-h-[260px]">
          {groups.map(({ heading, rows }) =>
            rows.length === 0 ? null : (
              <CommandGroup key={heading} heading={heading}>
                {rows.map(({ skill, index }) => (
                  <CommandItem
                    key={skill.name}
                    value={skill.name}
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onSelect={() => onSelect(skill)}
                    onMouseEnter={() => onHover?.(index)}
                    className={cn("p-0", index === activeIndex && "bg-surface")}
                  >
                    <SlashCommandRow
                      name={skill.name}
                      description={skill.description}
                      query={query}
                      glyphTone={skill.source === "skill" ? "purple" : "blue"}
                      badge={skill.source === "skill" ? "skill" : undefined}
                      badgeTone="purple"
                      active={index === activeIndex}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          )}
        </CommandList>
      </Command>
    </AutocompleteMenu>
  )
}
