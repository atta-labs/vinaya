import type * as React from 'react'
import { cn } from '../lib/utils'

type ChromeFrameVariant = 'topbar' | 'rail' | 'panel' | 'bar'

type ChromeFrameProps = React.ComponentProps<'div'> & {
  variant: ChromeFrameVariant
}

const frames: Record<ChromeFrameVariant, string> = {
  rail: 'flex h-full w-full flex-col overflow-hidden border-sidebar-border border-r bg-sidebar',
  panel: 'flex h-full w-full flex-col overflow-y-auto bg-card',
  bar: 'flex w-full items-center border-border border-b bg-card',
  topbar: 'relative flex h-14 w-full items-center border-border border-b px-6'
}

/** The app chrome's surface, edge to edge: a top bar, a side rail, a panel or a plain bar. */
function ChromeFrame({ variant, className, ...props }: ChromeFrameProps) {
  return <div data-slot='chrome-frame' className={cn(frames[variant], className)} {...props} />
}

export { ChromeFrame, type ChromeFrameProps, type ChromeFrameVariant }
