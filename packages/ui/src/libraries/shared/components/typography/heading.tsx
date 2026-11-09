import * as React from 'react'
import { cn } from '../../../../lib/utils'
import type { HeadingLevel, HeadingProps, HeadingSize, HeadingVariant } from '../../../../types/typography/heading'
import { familyClasses, leadingClasses, toneClasses, weightClasses } from './type-classes'

const defaultSizeByLevel: Record<HeadingLevel, string> = {
  1: 'text-4xl',
  2: 'text-3xl',
  3: 'text-2xl',
  4: 'text-xl',
  5: 'text-lg',
  6: 'text-base'
}

const sizeClasses: Record<HeadingSize, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
  '3xl': 'text-3xl',
  '4xl': 'text-4xl'
}

const variantClasses: Record<HeadingVariant, string> = {
  display: 'text-5xl leading-none tracking-tighter sm:text-6xl lg:text-7xl',
  headline: 'text-4xl leading-none tracking-tighter sm:text-6xl',
  page: 'text-4xl leading-tight sm:text-5xl',
  title: 'text-2xl leading-tight sm:text-3xl',
  subtitle: 'text-lg leading-snug'
}

const Heading = React.forwardRef<HTMLHeadingElement, HeadingProps>(
  ({ level = 2, variant, size, weight = 'bold', family, tone, leading, className, children, ...props }, ref) => {
    const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
    const sizeClass = size ? sizeClasses[size] : variant ? undefined : defaultSizeByLevel[level]

    return (
      <Tag
        ref={ref}
        className={cn(
          sizeClass,
          weightClasses[weight],
          'tracking-tight',
          variant && variantClasses[variant],
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
Heading.displayName = 'Heading'

export { Heading }
