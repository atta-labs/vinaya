'use client'

import * as Ariakit from '@ariakit/react'
import { cva, type VariantProps } from 'class-variance-authority'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import * as React from 'react'
import { cn } from '../lib/utils'

const toggleVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-[color,background-color,box-shadow] duration-200 ease-in-out hover:bg-muted/40 hover:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 relative isolate aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=on]:text-accent-foreground dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-transparent shadow-xs hover:bg-accent/40 hover:text-accent-foreground'
      },
      size: {
        default: 'h-9 min-w-9 px-2',
        sm: 'h-8 min-w-8 px-1.5',
        lg: 'h-10 min-w-10 px-2.5',
        icon: 'size-9'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

type ToggleProps = Omit<Ariakit.ButtonProps, 'onChange'> &
  VariantProps<typeof toggleVariants> & {
    pressed?: boolean
    defaultPressed?: boolean
    onPressedChange?: (pressed: boolean) => void
  }

// The highlight animates only for a press. A change from outside (a page
// syncing the state after mount) jumps, so nothing fades in or out on load.
// `custom` is whether this change came from a press; AnimatePresence hands
// the current value to a highlight that is leaving.
const highlight = {
  hidden: (pressedNow: boolean) =>
    pressedNow ? { opacity: 0, scale: 0.85 } : { opacity: 0, transition: { duration: 0 } },
  shown: { opacity: 1, scale: 1, transition: { type: 'spring', duration: 0.3, bounce: 0.2 } }
} satisfies Variants

/**
 * A two-state button: `aria-pressed` for assistive technology, `data-state="on|off"` for styling.
 * Pressing it springs an accent highlight in behind the content (and out when released); the
 * button itself gives a little on press.
 */
function Toggle({
  className,
  variant,
  size,
  pressed: pressedProp,
  defaultPressed = false,
  onPressedChange,
  onClick,
  children,
  ...props
}: ToggleProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultPressed)
  const pressed = pressedProp ?? uncontrolled
  const reduce = useReducedMotion()
  const fromPress = React.useRef(false)
  const animated = fromPress.current && !reduce
  // Cleared after each commit, not during render (React may render twice).
  React.useEffect(() => {
    fromPress.current = false
  })
  return (
    <Ariakit.Button
      render={<motion.button whileTap={reduce ? undefined : { scale: 0.97 }} />}
      data-slot='toggle'
      data-state={pressed ? 'on' : 'off'}
      aria-pressed={pressed}
      className={cn(toggleVariants({ variant, size }), className)}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        fromPress.current = true
        if (pressedProp === undefined) setUncontrolled(!pressed)
        onPressedChange?.(!pressed)
      }}
      {...props}
    >
      <AnimatePresence initial={false} custom={animated}>
        {pressed && (
          <motion.span
            aria-hidden
            className='absolute inset-0 -z-10 rounded-[inherit] bg-accent'
            custom={animated}
            variants={highlight}
            initial={animated ? 'hidden' : false}
            animate='shown'
            exit='hidden'
          />
        )}
      </AnimatePresence>
      {children}
    </Ariakit.Button>
  )
}

export { Toggle, type ToggleProps, toggleVariants }
