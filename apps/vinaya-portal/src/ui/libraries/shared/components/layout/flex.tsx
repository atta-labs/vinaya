import React from 'react'
import { Slot } from '@/ui/lib/slot'
import { cn } from '../../../../lib/utils'
import { getFlexClasses } from './class-utils'
import type { FlexProps } from './types'

/**
 * Flex primitive - A flexbox container with declarative props
 *
 * This primitive handles:
 * - asChild composition via an Ariakit-backed Slot
 * - Prop-to-Tailwind class mapping
 * - Ref forwarding
 *
 * @example
 * <Flex direction="column" gap={4} align="center">
 *   <Child />
 * </Flex>
 */
export const Flex = React.forwardRef<HTMLDivElement, FlexProps>(
  ({ asChild, as = 'div', direction, align, justify, wrap, gap, className, ...props }, forwardedRef) => {
    const Component = asChild ? Slot : as

    const flexClasses = cn(getFlexClasses({ direction, align, justify, wrap, gap }), className)

    return <Component {...props} ref={forwardedRef} className={flexClasses} />
  }
)

Flex.displayName = 'Flex'

export type { FlexProps }
