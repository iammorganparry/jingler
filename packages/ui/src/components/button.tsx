import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/cn.js"

/**
 * shadcn Button, restyled to the Jingler spec (primary/secondary/danger/ghost).
 *
 * `primary` is BRAND, `danger` is `red`, and the two are deliberately different
 * tokens even though Jingler's brand is itself a red — see the `--sb-brand` note
 * in globals.css. They also differ in WEIGHT, not just hue: primary is a filled
 * button and danger an outlined one, so the distinction survives for anyone who
 * cannot tell the two reds apart. That is the part that actually matters.
 */
const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[12.5px] font-semibold transition-[color,background-color,border-color,scale] duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // `text-white`, not `text-editor`: on a light theme `--sb-editor` is
        // near-white and would vanish into the fill.
        primary: "bg-brand text-white hover:bg-brand-hover",
        secondary: "border border-line text-text hover:bg-surface",
        danger: "border border-red/40 text-red hover:bg-red/10",
        ghost: "font-normal text-muted-foreground hover:text-text"
      },
      size: {
        sm: "px-2 py-1 text-[11.5px]",
        md: "px-[13px] py-1.5",
        icon: "size-7 p-0"
      }
    },
    defaultVariants: { variant: "primary", size: "md" }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return <Comp ref={ref} data-slot="button" className={cn(button({ variant, size }), className)} {...props} />
  }
)
Button.displayName = "Button"

export { button as buttonVariants }
