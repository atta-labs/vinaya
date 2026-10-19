import type React from 'react'

/**
 * Base props shared by all layout primitives
 */
export type BaseLayoutProps = {
  /** Use Radix Slot for composition */
  asChild?: boolean
  /** Render as different element */
  as?: 'div' | 'span'
}

/**
 * Props for Flex layout primitive
 */
export type FlexProps = BaseLayoutProps & {
  direction?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch'
  justify?: 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly'
  wrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
  gap?: number
} & React.ComponentPropsWithoutRef<'div'>
