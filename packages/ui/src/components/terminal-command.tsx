'use client'

import * as Ariakit from '@ariakit/react'
import { Check, Copy, Terminal } from 'lucide-react'
import { useState } from 'react'

// A terminal-styled, click-to-copy command: `$ <command>` in a box that stays dark in both colour schemes (the
// foreground ink as a fill in light, the card surface in dark). The box stays perfectly still: no scale and no
// hover treatment, which is why it is its own component and not a `Button` variant.
export function TerminalCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Ariakit.Button
      onClick={copy}
      aria-label={`Copy ${command}`}
      className='flex max-w-full cursor-pointer items-center gap-4 rounded-lg border border-border bg-foreground px-7 py-5 text-left font-mono text-base leading-none sm:text-xl text-background outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-card dark:text-card-foreground'
    >
      <Terminal className='size-[1.1em] shrink-0 text-success' />
      <span className='text-background/60 dark:text-muted-foreground'>$</span>
      <span className='min-w-0 whitespace-normal [overflow-wrap:anywhere]'>{command}</span>
      {copied ? (
        <Check className='size-[1.1em] shrink-0' />
      ) : (
        <Copy className='size-[1.1em] shrink-0 text-background/60 dark:text-muted-foreground' />
      )}
    </Ariakit.Button>
  )
}
