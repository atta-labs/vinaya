// The class maps Text and Heading share: family, tone, line height and weight.

export const familyClasses = {
  sans: 'font-sans',
  mono: 'font-mono',
  serif: 'font-serif'
} as const

export const toneClasses = {
  muted: 'text-muted-foreground',
  foreground: 'text-foreground',
  accent: 'text-ring'
} as const

export const leadingClasses = {
  none: 'leading-none',
  tight: 'leading-tight',
  snug: 'leading-snug',
  normal: 'leading-normal',
  relaxed: 'leading-relaxed'
} as const

export const weightClasses = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold'
} as const
