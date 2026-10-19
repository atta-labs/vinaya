import type { HTMLAttributes } from 'react'
import { cn } from '../lib/utils'

type CardProps = HTMLAttributes<HTMLDivElement>

/**
 * The card's surface:
 * - `default`: the raised card
 * - `flat`: no shadow, tighter corners — a window drawn inside a page
 * - `inset`: flat on the muted surface — a terminal or a log
 * - `terminal`: an inset set in mono
 * - `link`: flat, its border darkening on hover — a card that is a link
 * - `square`: square corners — a mock of another product's surface
 */
type CardVariant = 'default' | 'flat' | 'inset' | 'terminal' | 'link' | 'square'

const cardVariants: Record<CardVariant, string> = {
  default: '',
  flat: 'rounded-md shadow-none',
  inset: 'rounded-md bg-muted/60 shadow-none',
  terminal: 'rounded-md bg-muted/60 font-mono shadow-none',
  link: 'shadow-none transition-colors hover:border-foreground/40',
  square: 'rounded-none'
}

function Card({ variant = 'default', className, ...props }: CardProps & { variant?: CardVariant }) {
  return (
    <div
      data-slot='card'
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        cardVariants[variant],
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: CardProps) {
  return <div data-slot='card-header' className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
}

type CardTitleSize = 'md' | 'xl' | '2xl'
type CardTitleWeight = 'normal' | 'medium' | 'semibold'
type CardFamily = 'sans' | 'mono' | 'serif'

const titleSizes: Record<CardTitleSize, string> = { md: 'text-base', xl: 'text-xl', '2xl': 'text-2xl' }
const titleWeights: Record<CardTitleWeight, string> = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold'
}
const families: Record<CardFamily, string> = { sans: 'font-sans', mono: 'font-mono', serif: 'font-serif' }

function CardTitle({
  size = '2xl',
  weight = 'semibold',
  family,
  className,
  ...props
}: CardProps & { size?: CardTitleSize; weight?: CardTitleWeight; family?: CardFamily }) {
  return (
    <h3
      data-slot='card-title'
      className={cn(
        'leading-none tracking-tight',
        titleSizes[size],
        titleWeights[weight],
        family && families[family],
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ family, className, ...props }: CardProps & { family?: CardFamily }) {
  return (
    <p
      data-slot='card-description'
      className={cn('text-sm text-muted-foreground', family && families[family], className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: CardProps) {
  return (
    <div
      data-slot='card-action'
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  )
}

// `pt-6` comes before the caller's className, so an explicit `pt-*` still wins.
function CardContent({ className, ...props }: CardProps) {
  return <div data-slot='card-content' className={cn('p-6 pt-6', className)} {...props} />
}

function CardFooter({ className, ...props }: CardProps) {
  return <div data-slot='card-footer' className={cn('flex items-center p-6 pt-0', className)} {...props} />
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, type CardVariant }
