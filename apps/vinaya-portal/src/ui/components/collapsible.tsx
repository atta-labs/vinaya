'use client'

import * as Ariakit from '@ariakit/react'
import * as React from 'react'
import { resolveRender } from '../lib/slot'
import { cn } from '../lib/utils'

const CollapsibleContext = React.createContext<{ isOpen: boolean } | null>(null)

function useCollapsible() {
  const context = React.useContext(CollapsibleContext)
  if (!context) throw new Error('useCollapsible must be used within a Collapsible')
  return context
}

type CollapsibleProps = React.ComponentProps<'div'> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

function Collapsible({ open, defaultOpen = false, onOpenChange, ...props }: CollapsibleProps) {
  return (
    <Ariakit.DisclosureProvider open={open} defaultOpen={defaultOpen} setOpen={onOpenChange}>
      <CollapsibleRoot {...props} />
    </Ariakit.DisclosureProvider>
  )
}

function CollapsibleRoot(props: React.ComponentProps<'div'>) {
  const store = Ariakit.useDisclosureContext()
  const isOpen = Ariakit.useStoreState(store, 'open') ?? false
  return (
    <CollapsibleContext.Provider value={{ isOpen }}>
      <div data-slot='collapsible' data-state={isOpen ? 'open' : 'closed'} {...props} />
    </CollapsibleContext.Provider>
  )
}

type CollapsibleTriggerProps = Omit<Ariakit.DisclosureProps, 'render'> & {
  asChild?: boolean
  render?: React.ReactElement
}

/** `data-state="open|closed"` stays on the trigger, so `group-data-[state=open]:` still styles its icon. */
function CollapsibleTrigger({ asChild, render, children, ...props }: CollapsibleTriggerProps) {
  const { isOpen } = useCollapsible()
  const element = resolveRender(asChild, children, render)
  return (
    <Ariakit.Disclosure
      data-slot='collapsible-trigger'
      data-state={isOpen ? 'open' : 'closed'}
      render={element}
      {...props}
    >
      {render || !asChild ? children : undefined}
    </Ariakit.Disclosure>
  )
}

type CollapsibleContentProps = Omit<Ariakit.DisclosureContentProps, 'store'> & {
  /** Stay in the DOM (collapsed, `hidden`) while closed. */
  keepRendered?: boolean
}

/**
 * Ariakit's animated-disclosure recipe: a one-row grid whose row grows from
 * `0fr` to `1fr` on `data-enter`, so the height animates to the content's real
 * size; the content fades in with it. Ariakit hides it once the transition ends.
 */
function CollapsibleContent({ keepRendered = false, className, children, ...props }: CollapsibleContentProps) {
  const { isOpen } = useCollapsible()
  return (
    <Ariakit.DisclosureContent
      data-slot='collapsible-content'
      data-state={isOpen ? 'open' : 'closed'}
      unmountOnHide={!keepRendered}
      className={cn(
        'grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-in',
        'data-enter:grid-rows-[1fr] data-enter:opacity-100 data-enter:duration-300 data-enter:ease-out',
        'motion-reduce:transition-none',
        className
      )}
      {...props}
    >
      <div className='min-h-0 overflow-hidden'>{children}</div>
    </Ariakit.DisclosureContent>
  )
}

export {
  Collapsible,
  CollapsibleContent,
  type CollapsibleContentProps,
  type CollapsibleProps,
  CollapsibleTrigger,
  type CollapsibleTriggerProps,
  useCollapsible
}
