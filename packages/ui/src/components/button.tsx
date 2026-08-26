import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { m, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { EASE_OUT, SPRING_PRESS } from "./beui/ease.js"
import { cn } from "../lib/cn.js"

const button = cva(
  "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-brand text-white hover:bg-brand-hover",
        secondary: "border border-line bg-panel text-text-bright hover:border-line-strong",
        danger: "border border-red/40 bg-transparent text-red hover:bg-red/10",
        ghost: "text-muted-foreground hover:bg-brand/5 hover:text-text-bright",
        outline: "border border-line bg-transparent text-text-bright hover:bg-brand/5"
      },
      size: {
        sm: "h-8 gap-1.5 rounded-lg px-3 text-xs",
        md: "h-10 gap-2 rounded-lg px-5 text-sm",
        lg: "h-12 gap-2 rounded-lg px-6 text-base",
        icon: "size-8 rounded-lg"
      }
    },
    defaultVariants: { variant: "primary", size: "md" }
  }
)

export interface ButtonProps
  extends Omit<HTMLMotionProps<"button">, "children">,
    VariantProps<typeof button> {
  children?: React.ReactNode
  pressScale?: number
  ripple?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, pressScale = 0.93, ripple = false, children, onPointerDown, ...props }, ref) => {
    const reduce = useReducedMotion()
    const [ripples, setRipples] = React.useState<ReadonlyArray<{ id: number; x: number; y: number; size: number }>>([])
    const nextRipple = React.useRef(0)
    const classes = cn(button({ variant, size }), ripple && "relative overflow-hidden", className)

    return (
      <m.button
        ref={ref}
        type="button"
        data-slot="button"
        whileTap={reduce ? undefined : { scale: pressScale }}
        whileHover={reduce ? undefined : { scale: 1.02 }}
        transition={SPRING_PRESS}
        className={classes}
        onPointerDown={(event) => {
          if (ripple && !reduce) {
            const rect = event.currentTarget.getBoundingClientRect()
            setRipples((current) => [...current, {
              id: nextRipple.current++,
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
              size: Math.max(rect.width, rect.height) * 2
            }])
          }
          onPointerDown?.(event)
        }}
        {...props}
      >
        {ripple && !reduce && (
          <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
            {ripples.map((item) => (
              <m.span
                key={item.id}
                className="absolute rounded-full bg-current"
                style={{ left: item.x, top: item.y, width: item.size, height: item.size, x: "-50%", y: "-50%" }}
                initial={{ scale: 0.05, opacity: 0.3 }}
                animate={{ scale: 1, opacity: 0 }}
                transition={{ duration: 1.6, ease: EASE_OUT }}
                onAnimationComplete={() => setRipples((current) => current.filter(({ id }) => id !== item.id))}
              />
            ))}
          </span>
        )}
        {children}
      </m.button>
    )
  }
)
Button.displayName = "Button"

export { button as buttonVariants }
