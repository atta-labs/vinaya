import type { Tone } from './types'

/** A stage tone, or `neutral` for a quiet one in muted ink. */
type ToneKey = Tone | 'neutral'

export const toneText: Record<ToneKey, string> = {
  think: 'text-chart-3',
  exec: 'text-chart-4',
  retro: 'text-chart-2',
  hot: 'text-destructive',
  log: 'text-primary',
  product: 'text-chart-5',
  neutral: 'text-muted-foreground'
}

export const toneBg: Record<ToneKey, string> = {
  think: 'bg-chart-3',
  exec: 'bg-chart-4',
  retro: 'bg-chart-2',
  hot: 'bg-destructive',
  log: 'bg-primary',
  product: 'bg-chart-5',
  neutral: 'bg-muted-foreground'
}

export const toneBorder: Record<ToneKey, string> = {
  think: 'border-chart-3',
  exec: 'border-chart-4',
  retro: 'border-chart-2',
  hot: 'border-destructive',
  log: 'border-primary',
  product: 'border-chart-5',
  neutral: 'border-muted-foreground'
}

/** List bullets in the tone. */
export const toneMarker: Record<ToneKey, string> = {
  think: 'marker:text-chart-3',
  exec: 'marker:text-chart-4',
  retro: 'marker:text-chart-2',
  hot: 'marker:text-destructive',
  log: 'marker:text-primary',
  product: 'marker:text-chart-5',
  neutral: 'marker:text-muted-foreground'
}

/** A tinted surface: the tone at 10%. */
export const toneTint: Record<ToneKey, string> = {
  think: 'bg-chart-3/10',
  exec: 'bg-chart-4/10',
  retro: 'bg-chart-2/10',
  hot: 'bg-destructive/10',
  log: 'bg-primary/10',
  product: 'bg-chart-5/10',
  neutral: 'bg-muted-foreground/10'
}

/** A line's `::before` mark in the tone: the agent's name in a shell. */
export const toneBefore: Record<ToneKey, string> = {
  think: 'before:text-chart-3',
  exec: 'before:text-chart-4',
  retro: 'before:text-chart-2',
  hot: 'before:text-destructive',
  log: 'before:text-primary',
  product: 'before:text-chart-5',
  neutral: 'before:text-muted-foreground'
}
