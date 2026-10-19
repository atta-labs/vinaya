'use client'

import * as Ariakit from '@ariakit/react'
import type * as React from 'react'
import { cn } from '../lib/utils'
import { CloseButton, Dialog, DialogClose, DialogTrigger, overlayClasses } from './dialog'

// A sheet is a dialog pinned to one edge. `data-side` stays on the element, so
// callers can still target one side (`data-[side=left]:border-r-0`).
const Sheet = Dialog

function SheetTrigger(props: React.ComponentProps<typeof DialogTrigger>) {
  return <DialogTrigger data-slot='sheet-trigger' {...props} />
}

function SheetClose(props: React.ComponentProps<typeof DialogClose>) {
  return <DialogClose data-slot='sheet-close' {...props} />
}

type SheetSide = 'top' | 'right' | 'bottom' | 'left'

// Closed: shifted 2.5rem out and transparent. Open (`data-enter`, two attribute
// selectors) wins over the one-selector closed offset.
const sideClasses =
  'data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:translate-y-[2.5rem] data-[side=bottom]:data-enter:translate-y-0 ' +
  'data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:translate-x-[-2.5rem] data-[side=left]:data-enter:translate-x-0 data-[side=left]:sm:max-w-sm ' +
  'data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:translate-x-[2.5rem] data-[side=right]:data-enter:translate-x-0 data-[side=right]:sm:max-w-sm ' +
  'data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:translate-y-[-2.5rem] data-[side=top]:data-enter:translate-y-0'

type SheetContentProps = Omit<Ariakit.DialogProps, 'store'> & {
  side?: SheetSide
  showCloseButton?: boolean
}

function SheetContent({ className, children, side = 'right', showCloseButton = true, ...props }: SheetContentProps) {
  return (
    <Ariakit.Dialog
      data-slot='sheet-content'
      data-side={side}
      unmountOnHide
      backdrop={<div data-slot='sheet-overlay' className={overlayClasses} />}
      className={cn(
        'fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg outline-none',
        'opacity-0 transition-[opacity,translate] duration-200 ease-in data-enter:opacity-100 data-enter:duration-300 data-enter:ease-out motion-reduce:transition-opacity',
        sideClasses,
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && <CloseButton slot='sheet-close' />}
    </Ariakit.Dialog>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot='sheet-header' className={cn('flex flex-col gap-0.5 p-4', className)} {...props} />
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot='sheet-footer' className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
}

function SheetTitle({ className, ...props }: Ariakit.DialogHeadingProps) {
  return (
    <Ariakit.DialogHeading
      data-slot='sheet-title'
      // biome-ignore lint/a11y/useHeadingContent: Ariakit renders the children into this element
      render={<h2 />}
      className={cn('font-serif text-base font-medium text-foreground', className)}
      {...props}
    />
  )
}

function SheetDescription({ className, ...props }: Ariakit.DialogDescriptionProps) {
  return (
    <Ariakit.DialogDescription
      data-slot='sheet-description'
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger }
