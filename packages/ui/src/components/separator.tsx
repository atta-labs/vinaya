'use client'

import * as Ariakit from '@ariakit/react'
import type * as React from 'react'
import { cn } from '../lib/utils'

type SeparatorProps = React.ComponentProps<'div'> & {
  orientation?: 'horizontal' | 'vertical'
  /** A purely visual rule (the default) is hidden from assistive technology. */
  decorative?: boolean
}

function Separator({ className, orientation = 'horizontal', decorative = true, ...props }: SeparatorProps) {
  const classes = cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)
  if (decorative) {
    return <div data-slot='separator' data-orientation={orientation} role='none' className={classes} {...props} />
  }
  return (
    <Ariakit.Separator
      data-slot='separator'
      data-orientation={orientation}
      orientation={orientation}
      render={<div />}
      className={classes}
      {...(props as React.HTMLAttributes<HTMLElement>)}
    />
  )
}

export { Separator, type SeparatorProps }
