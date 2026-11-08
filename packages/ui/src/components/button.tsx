'use client'

import * as Ariakit from '@ariakit/react'
import { cva, type VariantProps } from 'class-variance-authority'
import { type HTMLMotionProps, motion, useReducedMotion } from 'motion/react'
import type * as React from 'react'
import { singleChild } from '../lib/slot'
import { cn } from '../lib/utils'

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium leading-none transition-[box-shadow,_color,_background-color,_border-color,_outline-color,_text-decoration-color,_fill,_stroke] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        accent: 'bg-accent text-accent-foreground shadow-xs hover:bg-accent/90',
        destructive:
          'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:text-foreground dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
        // an outline button at regular weight, for quiet controls
        subtle:
          'border bg-background font-normal shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        // a subtle button that reads like an input: a search field's trigger
        field:
          'border bg-background font-normal text-muted-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        // a subtle button set in mono, muted: a chip that picks something
        code: 'border bg-background font-mono font-normal text-muted-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        // on a primary-coloured band: the band's ink as the fill
        inverse: 'bg-primary-foreground text-foreground shadow-xs hover:bg-primary-foreground/90',
        // on a primary-coloured band: outlined in the band's ink
        'inverse-outline':
          'border border-primary-foreground/35 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground'
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        // a page's call to action: 48px on a phone, 52px from `sm`
        xl: 'h-12 gap-2 rounded-md px-5 text-lg sm:h-13 sm:px-7',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8 rounded-md',
        'icon-lg': 'size-10 rounded-md'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

type ButtonProps = Omit<HTMLMotionProps<'button'>, 'ref'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Scale on hover; 1 turns the motion off. */
    hoverScale?: number
    /** Scale while pressed; 1 turns the motion off. */
    tapScale?: number
    ref?: React.Ref<HTMLButtonElement>
  }

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  hoverScale = 1.05,
  tapScale = 0.95,
  children,
  ...props
}: ButtonProps) {
  const reduce = useReducedMotion()
  const classes = cn(buttonVariants({ variant, size }), className)
  const data = { 'data-slot': 'button', 'data-variant': variant, 'data-size': size }

  // A link (or any element) passed with asChild keeps its own role: Ariakit's
  // Role merges our props into it without adding button semantics.
  if (asChild) {
    const child = singleChild(children as React.ReactNode)
    if (child) {
      return (
        <Ariakit.Role render={child} className={classes} {...data} {...(props as React.HTMLAttributes<HTMLElement>)} />
      )
    }
  }

  return (
    <Ariakit.Button
      className={classes}
      {...data}
      render={
        <motion.button
          whileHover={reduce || hoverScale === 1 ? undefined : { scale: hoverScale }}
          whileTap={reduce || tapScale === 1 ? undefined : { scale: tapScale }}
        />
      }
      {...(props as Ariakit.ButtonProps)}
    >
      {children as React.ReactNode}
    </Ariakit.Button>
  )
}

export { Button, type ButtonProps, buttonVariants }
