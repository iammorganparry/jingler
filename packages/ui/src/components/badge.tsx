import type { ReactNode } from "react"
import { AnimatedBadge, type AnimatedBadgeStatus } from "./beui/animated-badge.js"
import { cn } from "../lib/cn.js"

export type BadgeTone = "count" | "neutral" | "blue" | "green" | "yellow" | "red" | "purple" | "cyan"

const statusFor: Record<BadgeTone, AnimatedBadgeStatus> = {
  count: "neutral",
  neutral: "neutral",
  blue: "info",
  green: "success",
  yellow: "warning",
  red: "danger",
  purple: "info",
  cyan: "info"
}

const toneClass: Partial<Record<BadgeTone, string>> = {
  count: "border-line bg-hover text-muted-foreground",
  neutral: "border-line bg-hover text-text",
  blue: "border-blue/30 bg-blue/10 text-blue",
  green: "border-green/30 bg-green/10 text-green",
  yellow: "border-yellow/30 bg-yellow/10 text-yellow",
  red: "border-red/30 bg-red/10 text-red",
  purple: "border-purple/30 bg-purple/10 text-purple",
  cyan: "border-cyan/30 bg-cyan/10 text-cyan"
}

export interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  size?: "xs" | "sm"
  className?: string
  title?: string
}

/** Compatibility API backed by the official BeUI AnimatedBadge. */
export function Badge({ children, tone = "neutral", className, title }: BadgeProps) {
  return (
    <AnimatedBadge
      title={title}
      status={statusFor[tone]}
      size="sm"
      showIcon={false}
      className={cn("font-mono", toneClass[tone], className)}
    >
      {children}
    </AnimatedBadge>
  )
}
