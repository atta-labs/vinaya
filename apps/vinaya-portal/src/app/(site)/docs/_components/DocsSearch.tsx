'use client'

import { SearchIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle
} from '@/ui/components'
import type { SearchGroup } from '../_lib/search-index'

/** The docs search: a button in the bar and ⌘K (Ctrl K) anywhere, over pages, commands and config keys. */
export function DocsSearch({ groups }: { groups: SearchGroup[] }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const go = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  return (
    <>
      <Button variant='field' size='sm' onClick={() => setOpen(true)} className='w-40 justify-start gap-2 xl:w-56'>
        <SearchIcon className='size-4' aria-hidden />
        <span className='flex-1 text-left'>Search docs</span>
        <kbd className='rounded border border-border px-1.5 font-mono text-xs'>⌘K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='overflow-hidden p-0 sm:max-w-xl' showCloseButton={false}>
          <DialogTitle className='sr-only'>Search docs</DialogTitle>
          <Command className='[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted-foreground'>
            <CommandInput placeholder='Search pages, commands, settings' className='text-base' />
            <CommandList className='max-h-96'>
              <CommandEmpty>Nothing found.</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup key={group.heading} heading={group.heading}>
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.href}
                      value={`${item.label} ${item.hint}`}
                      onSelect={() => go(item.href)}
                      className='flex flex-col items-start gap-0.5 py-2'
                    >
                      <span className='font-sans text-foreground'>{item.label}</span>
                      <span className='line-clamp-1 font-sans text-sm text-muted-foreground'>{item.hint}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
