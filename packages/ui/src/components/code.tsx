import type * as React from 'react'
import { cn } from '../lib/utils'

function Code({ className, ...props }: React.ComponentProps<'code'>) {
  return (
    <code
      data-slot='code'
      className={cn('rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground', className)}
      {...props}
    />
  )
}

function CodeBlock({ className, ...props }: React.ComponentProps<'pre'>) {
  return (
    <pre
      data-slot='code-block'
      className={cn('my-4 overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm text-foreground', className)}
      {...props}
    />
  )
}

export { Code, CodeBlock }
