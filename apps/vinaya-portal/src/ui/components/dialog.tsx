'use client'

import * as Ariakit from '@ariakit/react'
import { XIcon } from 'lucide-react'
import type * as React from 'react'
import { resolveRender } from '../lib/slot'
import { cn } from '../lib/utils'
import { Button } from './button'

// Ariakit's animated-dialog recipe: the closed state is the element's base
// style; Ariakit adds `data-enter` once it is shown and `data-leave` while it
// hides, and waits for the transition to end before hiding or unmounting.
// Enter eases out over 200ms, leave eases in over 150ms. The leave timing sits
// on the base style: Ariakit drops `data-enter` a frame before it adds
// `data-leave`, so a `data-leave:` timing would come too late.
const overlayClasses =
  'fixed inset-0 z-50 bg-background/40 opacity-0 transition-opacity duration-150 ease-in data-enter:opacity-100 data-enter:duration-200 data-enter:ease-out motion-reduce:transition-none supports-backdrop-filter:backdrop-blur-xs'

type RootProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

function Dialog({ open, defaultOpen, onOpenChange, children }: RootProps) {
  return (
    <Ariakit.DialogProvider open={open} defaultOpen={defaultOpen} setOpen={onOpenChange}>
      {children}
    </Ariakit.DialogProvider>
  )
}

type TriggerProps = Omit<Ariakit.DialogDisclosureProps, 'render'> & {
  asChild?: boolean
  render?: React.ReactElement
}

function DialogTrigger({ asChild, render, children, ...props }: TriggerProps) {
  const element = resolveRender(asChild, children, render)
  return (
    <Ariakit.DialogDisclosure data-slot='dialog-trigger' render={element} {...props}>
      {render || !asChild ? children : undefined}
    </Ariakit.DialogDisclosure>
  )
}

type CloseProps = Omit<Ariakit.DialogDismissProps, 'render'> & {
  asChild?: boolean
  render?: React.ReactElement
}

function DialogClose({ asChild, render, children, ...props }: CloseProps) {
  const element = resolveRender(asChild, children, render)
  return (
    <Ariakit.DialogDismiss data-slot='dialog-close' render={element} {...props}>
      {render || !asChild ? children : undefined}
    </Ariakit.DialogDismiss>
  )
}

/** Ariakit portals the dialog itself; kept so existing markup still composes. */
function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function DialogOverlay({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot='dialog-overlay' className={cn(overlayClasses, className)} {...props} />
}

function CloseButton({ slot }: { slot: string }) {
  return (
    <Ariakit.DialogDismiss
      data-slot={slot}
      render={<Button variant='ghost' size='icon' className='absolute top-3 right-3' />}
    >
      <XIcon />
      <span className='sr-only'>Close</span>
    </Ariakit.DialogDismiss>
  )
}

type ContentProps = Omit<Ariakit.DialogProps, 'store'> & {
  showCloseButton?: boolean
}

function DialogContent({ className, children, showCloseButton = true, ...props }: ContentProps) {
  return (
    <Ariakit.Dialog
      data-slot='dialog-content'
      unmountOnHide
      backdrop={<div data-slot='dialog-overlay' className={overlayClasses} />}
      className={cn(
        'fixed top-1/2 left-1/2 z-50 flex w-full max-w-lg -translate-x-1/2 flex-col gap-4 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg outline-none',
        'translate-y-[calc(-50%+0.5rem)] scale-[0.96] opacity-0 transition-[opacity,scale,translate] duration-150 ease-in',
        'data-enter:-translate-y-1/2 data-enter:scale-100 data-enter:opacity-100 data-enter:duration-200 data-enter:ease-out',
        'motion-reduce:translate-y-[-50%] motion-reduce:scale-100 motion-reduce:transition-opacity',
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && <CloseButton slot='dialog-close' />}
    </Ariakit.Dialog>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot='dialog-header' className={cn('flex flex-col gap-1.5', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='dialog-footer'
      className={cn('mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: Ariakit.DialogHeadingProps) {
  return (
    <Ariakit.DialogHeading
      data-slot='dialog-title'
      // biome-ignore lint/a11y/useHeadingContent: Ariakit renders the children into this element
      render={<h2 />}
      className={cn('font-serif text-lg leading-none font-semibold tracking-tight', className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: Ariakit.DialogDescriptionProps) {
  return (
    <Ariakit.DialogDescription
      data-slot='dialog-description'
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  CloseButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  overlayClasses
}
