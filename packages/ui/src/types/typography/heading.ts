/** @category typography */
import type * as React from 'react'
import type { TypeFamily, TypeLeading, TypeTone } from './text'

/**
 * Heading size options.
 */
export type HeadingSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl'

/**
 * Heading level options (maps to h1-h6).
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/**
 * Heading font-weight options. Default `'bold'`.
 */
export type HeadingWeight = 'normal' | 'medium' | 'semibold' | 'bold'

/**
 * Typographic roles, largest first. Each carries its own size, line height and tracking.
 * - `display`: a page's hero line
 * - `headline`: a landing section's title
 * - `page`: a document page's title
 * - `title`: a section or panel title
 * - `subtitle`: a sub-section title
 */
export type HeadingVariant = 'display' | 'headline' | 'page' | 'title' | 'subtitle'

/**
 * Heading component props contract.
 * Renders semantic h1-h6 elements with consistent typography.
 * All template implementations must satisfy this interface.
 */
export interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** Semantic heading level (renders h1-h6)
   * @default 2
   */
  level?: HeadingLevel
  /** Typographic role; overrides the level's default size */
  variant?: HeadingVariant
  /** Visual size override (decouple semantics from appearance) */
  size?: HeadingSize
  /** Font weight (overrides the default `font-bold`)
   * @default 'bold'
   */
  weight?: HeadingWeight
  /** Font family; inherited when omitted */
  family?: TypeFamily
  /** Text colour; inherited when omitted */
  tone?: TypeTone
  /** Line height; the role's or size's own when omitted */
  leading?: TypeLeading
}
