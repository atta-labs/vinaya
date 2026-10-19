'use client'

import { Check, ChevronDown, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  Button,
  CodeBlock,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from '@/ui/components'

/** Labelled panels, one shown at a time: the docs' "Using the CLI / Using the config file" switch. */
export function DocTabs({ panels }: { panels: { label: string; body: ReactNode }[] }) {
  const first = panels[0]?.label
  return (
    <Tabs defaultValue={first} className='my-2'>
      <TabsList>
        {panels.map((p) => (
          <TabsTrigger key={p.label} value={p.label}>
            {p.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {panels.map((p) => (
        <TabsContent key={p.label} value={p.label} className='mt-4 flex flex-col gap-4'>
          {p.body}
        </TabsContent>
      ))}
    </Tabs>
  )
}

/** Questions that open in place: troubleshooting, "when to use which", long reference lists. */
export function DocAccordion({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <div className='my-2 flex flex-col divide-y divide-border rounded-lg border border-border'>
      {items.map((item) => (
        <Collapsible key={item.title}>
          <CollapsibleTrigger className='group flex w-full items-center justify-between gap-4 px-4 py-3 text-left font-sans text-base text-foreground'>
            <span>{item.title}</span>
            <ChevronDown
              className='size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180'
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className='flex flex-col gap-4 px-4 pb-4'>{item.body}</div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  )
}

/** A code block with an optional file name and a copy control. */
export function DocCode({ code, title, children }: { code: string; title?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className='group relative overflow-hidden rounded-lg border border-border bg-muted/40'>
      {title && <div className='border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground'>{title}</div>}
      <Button
        variant='ghost'
        size='icon-sm'
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        hoverScale={1}
        tapScale={1}
        className='absolute right-2 bottom-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100'
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
      <CodeBlock className='my-0 rounded-none bg-transparent leading-6'>{children}</CodeBlock>
    </div>
  )
}
