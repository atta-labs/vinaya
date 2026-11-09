/** @category typography */
import type * as React from 'react'

/**
 * Text element options.
 */
export type TextAs = 'p' | 'span' | 'small' | 'strong' | 'em' | 'label'

/**
 * Text size options.
 */
export type TextSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/**
 * Text weight options.
 */
export type TextWeight = 'normal' | 'medium' | 'semibold' | 'bold'

/**
 * Typographic roles. `eyebrow` is a style that takes `size`; the others carry their own size.
 * - `eyebrow`: mono, uppercase, open tracking — a label above a title
 * - `lead`: the paragraph under a section title
 * - `intro`: a larger lead, for a page or a hero
 * - `title`: a card or step title set in body text
 * - `figure`: a large number or symbol
 */
export type TextVariant = 'eyebrow' | 'lead' | 'intro' | 'title' | 'figure'

/**
 * Font family, from the theme's `--font-sans`, `--font-mono` and `--font-serif`.
 */
export type TypeFamily = 'sans' | 'mono' | 'serif'

/**
 * Text colour, from the theme: `muted` (secondary), `foreground` (full ink, inside a muted
 * parent) or `accent` (the theme's `--ring`).
 */
export type TypeTone = 'muted' | 'foreground' | 'accent'

/**
 * Line height.
 */
export type TypeLeading = 'none' | 'tight' | 'snug' | 'normal' | 'relaxed'

/**
 * Text component props contract.
 * Renders semantic text elements with consistent typography.
 * All template implementations must satisfy this interface.
 */
export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  /** Render as different element
   * @default 'p'
   */
  as?: TextAs
  /** Typographic role */
  variant?: TextVariant
  /** Visual size
   * @default 'md' ('sm' for an eyebrow; a role with its own size ignores it)
   */
  size?: TextSize
  /** Text weight */
  weight?: TextWeight
  /** Font family; inherited when omitted */
  family?: TypeFamily
  /** Text colour; inherited when omitted */
  tone?: TypeTone
  /** Line height; the size's own when omitted */
  leading?: TypeLeading
}
