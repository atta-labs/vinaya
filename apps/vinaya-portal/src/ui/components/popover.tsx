'use client'

import * as Ariakit from '@ariakit/react'
import * as React from 'react'
import { resolveRender } from '../lib/slot'
import { cn } from '../lib/utils'

type RootProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

function Popover({ open, defaultOpen, onOpenChange, children }: RootProps) {
  return (
    <Ariakit.PopoverProvider open={open} defaultOpen={defaultOpen} setOpen={onOpenChange}>
      {children}
    </Ariakit.PopoverProvider>
  )
}

type TriggerProps = Omit<Ariakit.PopoverDisclosureProps, 'render'> & {
  asChild?: boolean
  render?: React.ReactElement
}

function PopoverTrigger({ asChild, render, children, ...props }: TriggerProps) {
  const element = resolveRender(asChild, children, render)
  return (
    <Ariakit.PopoverDisclosure data-slot='popover-trigger' render={element} {...props}>
      {render || !asChild ? children : undefined}
    </Ariakit.PopoverDisclosure>
  )
}

function PopoverAnchor(props: Ariakit.PopoverAnchorProps) {
  return <Ariakit.PopoverAnchor data-slot='popover-anchor' {...props} />
}

/**
 * Ariakit's animated-select recipe for any popup: fade, grow out of the anchor
 * (`--popover-transform-origin`) and slide in from the side it opened on.
 * Shared by the navigation menu.
 */
export const popupMotion =
  'origin-(--popover-transform-origin) scale-95 opacity-0 transition-[opacity,scale,translate] duration-150 ease-in ' +
  'data-[side=bottom]:[translate:0_-0.5rem] data-[side=top]:[translate:0_0.5rem] data-[side=left]:[translate:0.5rem_0] data-[side=right]:[translate:-0.5rem_0] ' +
  'data-enter:scale-100 data-enter:opacity-100 data-enter:![translate:0] data-enter:duration-200 data-enter:ease-out ' +
  'motion-reduce:scale-100 motion-reduce:![translate:0] motion-reduce:transition-opacity'

type Side = 'top' | 'right' | 'bottom' | 'left'
type Align = 'start' | 'center' | 'end'

type ContentProps = Omit<Ariakit.PopoverProps, 'store'> & {
  side?: Side
  align?: Align
  sideOffset?: number
}

function PopoverContent({ className, side = 'bottom', align = 'center', sideOffset = 4, ...props }: ContentProps) {
  // Ariakit keeps placement on the store; the content sets it, as Radix took it here.
  const store = Ariakit.usePopoverContext()
  const placement = (align === 'center' ? side : `${side}-${align}`) as Ariakit.PopoverStoreState['placement']
  React.useLayoutEffect(() => {
    store?.setState('placement', placement)
  }, [store, placement])
  // The side it actually opened on (it flips when there's no room), so it slides in from there.
  const currentPlacement = Ariakit.useStoreState(store, 'currentPlacement')

  return (
    <Ariakit.Popover
      data-slot='popover-content'
      portal
      unmountOnHide
      gutter={sideOffset}
      data-side={currentPlacement?.split('-')[0]}
      className={cn(
        'z-50 w-72 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none',
        popupMotion,
        className
      )}
      {...props}
    />
  )
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
