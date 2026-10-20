import * as React from 'react'
import { cn } from '../../../../lib/utils'
import type { TextProps, TextSize, TextVariant } from '../../../../types'
import { familyClasses, leadingClasses, toneClasses, weightClasses } from './type-classes'

const sizeClasses: Record<TextSize, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl'
}

const variantClasses: Record<TextVariant, string> = {
  eyebrow: 'font-mono uppercase tracking-widest',
  lead: 'text-lg leading-normal sm:text-xl',
  intro: 'text-xl leading-snug sm:text-2xl',
  title: 'text-xl leading-tight tracking-tight',
  figure: 'text-4xl leading-none tracking-tighter sm:text-6xl'
}

/** The size a role starts from: an eyebrow is small, a role that carries its own size takes none. */
function sizeFor(variant: TextVariant | undefined, size: TextSize | undefined): TextSize | undefined {
  if (size) return size
  if (!variant) return 'md'
  return variant === 'eyebrow' ? 'sm' : undefined
}

const Text = React.forwardRef<HTMLElement, TextProps>(
  ({ as: Tag = 'p', variant, size, weight, family, tone, leading, className, children, ...props }, ref) => {
    const resolvedSize = sizeFor(variant, size)
    return (
      <Tag
        ref={ref as any}
        className={cn(
          variant && variantClasses[variant],
          resolvedSize && sizeClasses[resolvedSize],
          weight && weightClasses[weight],
          family && familyClasses[family],
          tone && toneClasses[tone],
          leading && leadingClasses[leading],
          className
        )}
        {...props}
      >
        {children}
      </Tag>
    )
  }
)
Text.displayName = 'Text'

export { Text }
