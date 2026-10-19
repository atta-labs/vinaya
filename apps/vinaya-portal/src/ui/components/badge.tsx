'use client'

import { motion, useReducedMotion } from 'motion/react'
import type * as React from 'react'
import { cn } from '../lib/utils'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'label' | 'code'
type BadgeSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
/** A status colour on an outlined badge: its text and a light border in that colour. */
type BadgeTone = 'primary' | 'success' | 'retired'

type BadgeProps = React.HTMLAttributes<HTMLElement> & {
  size?: BadgeSize
  variant?: BadgeVariant
  tone?: BadgeTone
  href?: string
  onHover?: React.MouseEventHandler<HTMLElement>
}

const sizeClasses: Record<BadgeSize, string> = {
  '2xs': 'h-4 px-1.5 text-[9px]',
  xs: 'px-1.5 py-0.5 text-xs',
  sm: 'px-2.5 py-0.5 text-xs',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-base',
  xl: 'px-5 py-2.5 text-lg',
  '2xl': 'px-6 py-3 text-xl'
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
  outline: 'border border-border bg-background text-foreground',
  // a quiet outlined tag: regular weight, muted ink
  label: 'border border-border bg-background font-normal text-muted-foreground',
  // a label set in mono: an identifier, a version, a type
  code: 'border border-border bg-background font-mono font-normal text-muted-foreground'
}

const toneClasses: Record<BadgeTone, string> = {
  primary: 'border-primary/40 text-primary',
  success: 'border-success/40 text-success',
  retired: 'border-dashed text-muted-foreground line-through'
}

const motionProps = {
  whileHover: { scale: 1.05 },
  whileTap: { scale: 0.95 },
  transition: { type: 'spring' as const, stiffness: 400, damping: 17 }
}

// Motion's own event props (onAnimationStart, onDrag…) differ from React's, so
// the native attributes are passed through as plain props.
type MotionSafe = Record<string, unknown>

function Badge({
  children,
  size = 'md',
  variant = 'default',
  tone,
  className,
  onClick,
  href,
  onHover,
  ...props
}: BadgeProps) {
  const classes = cn(
    'inline-flex items-center justify-center rounded-md font-medium transition-all',
    sizeClasses[size],
    variantClasses[variant],
    tone && toneClasses[tone],
    className
  )
  const rest = props as MotionSafe
  const hover = useReducedMotion() ? {} : motionProps

  if (href) {
    return (
      <motion.a href={href} className={classes} onMouseEnter={onHover} {...hover} {...rest}>
        {children}
      </motion.a>
    )
  }
  if (onClick) {
    return (
      <motion.button type='button' onClick={onClick} className={classes} onMouseEnter={onHover} {...hover} {...rest}>
        {children}
      </motion.button>
    )
  }
  return (
    <motion.div className={classes} onMouseEnter={onHover} {...hover} {...rest}>
      {children}
    </motion.div>
  )
}

export { Badge, type BadgeProps, type BadgeSize, type BadgeTone, type BadgeVariant }
