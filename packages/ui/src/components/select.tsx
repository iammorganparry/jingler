import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

export {
  Select,
  SelectContent,
  SelectItem,
  SelectSearch,
  SelectTrigger,
  SelectValue
} from "./beui/select.js"

export function SelectGroup({ children }: { children: ReactNode }) {
  return children
}

export function SelectLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.4px] text-dim", className)}>{children}</div>
}
