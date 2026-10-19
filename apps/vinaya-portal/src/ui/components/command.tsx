'use client'

import * as Ariakit from '@ariakit/react'
import { SearchIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from '../lib/utils'

// A filtered list on Ariakit's combobox: the input keeps focus, arrows move the
// active item, Enter or a click runs `onSelect`. Items that miss the search
// render nothing; a group with no items left and the empty state are hidden in
// CSS, so no registry is needed. The `cmdk-*` attributes are rendered so
// selectors keyed on them (`[&_[cmdk-group-heading]]:…`) apply.
const CommandContext = React.createContext<{ search: string }>({ search: '' })

function matches(search: string, text: string) {
  const haystack = text.toLowerCase()
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

type CommandProps = React.ComponentProps<'div'> & {
  /** Controlled search text. */
  value?: string
  onValueChange?: (value: string) => void
}

function Command({ className, value, onValueChange, ...props }: CommandProps) {
  const [inner, setInner] = React.useState('')
  const search = value ?? inner
  const setSearch = (next: string) => {
    if (value === undefined) setInner(next)
    onValueChange?.(next)
  }
  return (
    <CommandContext.Provider value={{ search }}>
      {/* Always open: the list is inline, not a popup. */}
      <Ariakit.ComboboxProvider value={search} setValue={setSearch} open setOpen={() => {}}>
        <div
          data-slot='command'
          {...{ 'cmdk-root': '' }}
          className={cn(
            'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
            className
          )}
          {...props}
        />
      </Ariakit.ComboboxProvider>
    </CommandContext.Provider>
  )
}

function CommandInput({ className, ...props }: Omit<Ariakit.ComboboxProps, 'store'>) {
  return (
    <div data-slot='command-input-wrapper' className='flex h-9 items-center gap-2 border-b border-border px-3'>
      <SearchIcon className='size-4 shrink-0 text-muted-foreground' />
      <Ariakit.Combobox
        data-slot='command-input'
        {...{ 'cmdk-input': '' }}
        autoSelect='always'
        autoComplete='list'
        className={cn(
          'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: Omit<Ariakit.ComboboxListProps, 'store'>) {
  return (
    <Ariakit.ComboboxList
      data-slot='command-list'
      {...{ 'cmdk-list': '' }}
      alwaysVisible
      className={cn(
        'max-h-[320px] scroll-py-1 overflow-x-hidden overflow-y-auto',
        '[&:has([data-slot=command-item])>[data-slot=command-empty]]:hidden',
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='command-empty'
      {...{ 'cmdk-empty': '' }}
      role='presentation'
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

type CommandGroupProps = Omit<Ariakit.ComboboxGroupProps, 'store'> & { heading?: React.ReactNode }

function CommandGroup({ className, heading, children, ...props }: CommandGroupProps) {
  return (
    <Ariakit.ComboboxGroup
      data-slot='command-group'
      {...{ 'cmdk-group': '' }}
      className={cn(
        'overflow-hidden p-1 text-foreground [&:not(:has([data-slot=command-item]))]:hidden',
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
        className
      )}
      {...props}
    >
      {heading !== undefined && (
        <Ariakit.ComboboxGroupLabel {...{ 'cmdk-group-heading': '' }}>{heading}</Ariakit.ComboboxGroupLabel>
      )}
      {children}
    </Ariakit.ComboboxGroup>
  )
}

function CommandSeparator({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot='command-separator' role='none' className={cn('-mx-1 h-px bg-border', className)} {...props} />
}

type CommandItemProps = Omit<Ariakit.ComboboxItemProps, 'store' | 'value' | 'onSelect'> & {
  /** Text the search matches against; the item's own text when omitted. */
  value?: string
  keywords?: string[]
  onSelect?: (value: string) => void
}

function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

function CommandItem({ className, value, keywords, onSelect, children, onClick, ...props }: CommandItemProps) {
  const { search } = React.useContext(CommandContext)
  const text = value ?? textOf(children)
  if (!matches(search, [text, ...(keywords ?? [])].join(' '))) return null
  return (
    <Ariakit.ComboboxItem
      data-slot='command-item'
      {...{ 'cmdk-item': '' }}
      focusOnHover
      setValueOnClick={false}
      hideOnClick={false}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) onSelect?.(text)
      }}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden transition-colors duration-150 ease-out motion-reduce:transition-none',
        'aria-disabled:pointer-events-none aria-disabled:opacity-50',
        'data-[active-item]:bg-accent data-[active-item]:text-accent-foreground',
        "[&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
    </Ariakit.ComboboxItem>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot='command-shortcut'
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
}
