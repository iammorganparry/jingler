import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { m, useReducedMotion, type HTMLMotionProps } from "motion/react"
import { EASE_OUT, SPRING_PRESS } from "./beui/ease.js"
import { cn } from "../lib/cn.js"

const button = cva(
  "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Neutral fill (spec §6.10). Rose/brand is never a button fill; it is the focus ring only.
        primary: "bg-primary-fill text-primary-fg hover:bg-primary-hover disabled:bg-primary-disabled disabled:text-dim disabled:opacity-100",
        secondary: "border border-line-strong bg-transparent text-text-bright hover:bg-text-bright/5",
        // Destructive = failed-coloured text on transparent. A solid fill is `destructive-solid`, reserved
        // for the last button of a ConfirmDialog.
        danger: "border border-line-strong bg-transparent text-state-failed hover:bg-state-failed/10",
        "destructive-solid": "bg-state-failed text-primary-fg hover:bg-state-failed/90",
        ghost: "text-muted-foreground hover:bg-text-bright/5 hover:text-text-bright",
        outline: "border border-line bg-transparent text-text-bright hover:bg-text-bright/5"
      },
      size: {
        sm: "h-7 gap-1.5 rounded-[6px] px-3 text-xs",
        md: "h-8 gap-2 rounded-[6px] px-3.5 text-[13px]",
        lg: "h-10 gap-2 rounded-[6px] px-5 text-sm",
        icon: "size-8 rounded-[6px]"
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
