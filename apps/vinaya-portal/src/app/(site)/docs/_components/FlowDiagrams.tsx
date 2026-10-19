'use client'

import { Maximize2, Network } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { FLOW_NAMES, FlowOnlyDiagram, WholeProcessDiagram } from '@/process/diagram/ProcessFlows'
import type { FlowKey } from '@/process/types'
import { Button, Dialog, DialogContent, DialogTitle } from '@/ui/components'

// The docs show the process diagram as a picture, never as the interactive walk: no flow tabs, no stage buttons,
// nothing to pick. A guide shows its own flow's part only; the whole-process view draws every flow at once. Both
// are the design system's diagrams (`process/diagram/ProcessFlows`).

/** A diagram full screen, read-only, closed with Esc or its close button. */
function FullScreen({
  open,
  onOpenChange,
  title,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='block h-dvh w-screen max-w-none gap-0 overflow-y-auto p-0 sm:max-w-none'>
        <div className='sticky top-0 z-10 flex min-h-14 items-center border-b border-border/50 bg-background py-3 pr-16 pl-5'>
          <DialogTitle className='font-mono text-sm font-normal uppercase tracking-widest'>{title}</DialogTitle>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** A guide's own flow, drawn in the page, with a button to see it full screen. */
export function FlowDiagram({ flow }: { flow: FlowKey }) {
  const [open, setOpen] = useState(false)
  const title = `${FLOW_NAMES[flow]} · the flow`
  return (
    <figure className='m-0 flex flex-col overflow-hidden rounded-lg border border-border'>
      <figcaption className='flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5'>
        <span className='font-mono text-sm uppercase tracking-widest text-muted-foreground'>{title}</span>
        <Button type='button' variant='outline' size='sm' hoverScale={1} tapScale={1} onClick={() => setOpen(true)}>
          <Maximize2 aria-hidden />
          Full screen
        </Button>
      </figcaption>
      <FlowOnlyDiagram flow={flow} scale={1.1} />
      <FullScreen open={open} onOpenChange={setOpen} title={title}>
        <FlowOnlyDiagram flow={flow} />
      </FullScreen>
    </figure>
  )
}

/** The whole process, every flow drawn, opened full screen from the end of a guide. */
export function WholeDiagramButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type='button'
        variant='outline'
        hoverScale={1}
        tapScale={1}
        onClick={() => setOpen(true)}
        className='self-start'
      >
        <Network aria-hidden />
        See whole flow diagram
      </Button>
      <FullScreen open={open} onOpenChange={setOpen} title='The Vinaya process · every flow'>
        <WholeProcessDiagram />
      </FullScreen>
    </>
  )
}
