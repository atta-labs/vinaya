import type { FlexProps } from './types'

/**
 * Tailwind gap class mapping
 * Converts numeric gap values to Tailwind classes
 */
export const getGapClass = (gap: number | undefined): string | undefined => {
  if (gap === undefined) return undefined

  const gapMap: Record<number, string> = {
    0: 'gap-0',
    1: 'gap-1',
    2: 'gap-2',
    3: 'gap-3',
    4: 'gap-4',
    5: 'gap-5',
    6: 'gap-6',
    7: 'gap-7',
    8: 'gap-8',
    9: 'gap-9',
    10: 'gap-10',
    11: 'gap-11',
    12: 'gap-12',
    14: 'gap-14',
    16: 'gap-16',
    20: 'gap-20',
    24: 'gap-24',
    28: 'gap-28',
    32: 'gap-32',
    36: 'gap-36',
    40: 'gap-40',
    44: 'gap-44',
    48: 'gap-48',
    52: 'gap-52',
    56: 'gap-56',
    60: 'gap-60',
    64: 'gap-64',
    72: 'gap-72',
    80: 'gap-80',
    96: 'gap-96'
  }

  return gapMap[gap] || `gap-[${gap * 0.25}rem]`
}

/**
 * Get Tailwind classes for Flex props
 */
export const getFlexClasses = (
  props: Pick<FlexProps, 'direction' | 'align' | 'justify' | 'wrap' | 'gap'>
): string[] => {
  const { direction, align, justify, wrap, gap } = props
  const classes: string[] = ['flex']

  // Direction
  if (direction === 'column') classes.push('flex-col')
  if (direction === 'row-reverse') classes.push('flex-row-reverse')
  if (direction === 'column-reverse') classes.push('flex-col-reverse')

  // Align items
  if (align === 'start') classes.push('items-start')
  if (align === 'center') classes.push('items-center')
  if (align === 'end') classes.push('items-end')
  if (align === 'baseline') classes.push('items-baseline')
  if (align === 'stretch') classes.push('items-stretch')

  // Justify content
  if (justify === 'start') classes.push('justify-start')
  if (justify === 'center') classes.push('justify-center')
  if (justify === 'end') classes.push('justify-end')
  if (justify === 'between') classes.push('justify-between')
  if (justify === 'around') classes.push('justify-around')
  if (justify === 'evenly') classes.push('justify-evenly')

  // Wrap
  if (wrap === 'wrap') classes.push('flex-wrap')
  if (wrap === 'nowrap') classes.push('flex-nowrap')
  if (wrap === 'wrap-reverse') classes.push('flex-wrap-reverse')

  // Gap
  const gapClass = getGapClass(gap)
  if (gapClass) classes.push(gapClass)

  return classes
}
