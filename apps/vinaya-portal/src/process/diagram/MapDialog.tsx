'use client'

import { flowList } from '@/process/fixtures'
import type { FlowKey, GateState, Stage } from '@/process/types'
import { Button, Dialog, DialogContent, DialogTitle, Tabs, TabsList, TabsTrigger } from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import type { Moment } from './moment'
import { ProcessDiagram } from './ProcessDiagram'

const pickerStages: Stage[] = ['upstream', 'architect', 'planner', 'loop', 'merge', 'archive', 'improve']

/** What the picker calls each stage. */
const pickerLabel: Partial<Record<Stage, string>> = {
  upstream: 'Upstream',
  architect: 'Architect',
  planner: 'Planner',
  loop: 'Loop',
  merge: 'Merge',
  archive: 'Archive',
  improve: 'Improve'
}

/** The rings follow the stage: nothing before the loop, Ring 1 running in the loop, all green once merged. */
const gatesFor = (stage: Stage): GateState =>
  stage === 'loop'
    ? [2, 1, 0]
    : stage === 'merge'
      ? [2, 2, 1]
      : stage === 'archive' || stage === 'improve'
        ? [2, 2, 2]
        : [0, 0, 0]

/** The moment a picker selection stands for. */
export const momentOf = (flow: FlowKey, stage: Stage): Moment => ({
  flow,
  stage,
  gates: gatesFor(stage),
  closed: stage === 'archive' || stage === 'improve'
})

/** The moment picker: flow tabs and the stage row. One component, on `/system/diagram` and in the full-screen map. */
export function MomentPicker({
  flow,
  stage,
  onFlow,
  onStage,
  trailing,
  flows = true
}: {
  flow: FlowKey
  stage: Stage
  onFlow: (f: FlowKey) => void
  onStage: (s: Stage) => void
  trailing?: React.ReactNode
  /** The flow tabs; off where the flow is chosen elsewhere (the process page's top bar). */
  flows?: boolean
}) {
  return (
    <div className='grid gap-3'>
      {flows && (
        <Tabs value={flow} onValueChange={(v) => onFlow(v as FlowKey)}>
          <TabsList>
            {flowList.map((f) => (
              <TabsTrigger key={f.key} value={f.key}>
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      <div className='flex flex-wrap items-center gap-1.5'>
        {trailing}
        {pickerStages.map((s) => (
          <Button key={s} size='sm' variant={s === stage ? 'default' : 'outline'} onClick={() => onStage(s)}>
            {pickerLabel[s] ?? s}
          </Button>
        ))}
      </div>
    </div>
  )
}

type MapProps = {
  flow: FlowKey
  stage: Stage
  onFlow: (f: FlowKey) => void
  onStage: (s: Stage) => void
  /** Show the flow tabs in the picker. */
  flows?: boolean
  className?: string
}

/**
 * The whole process as one view: the picker fixed on top, the diagram filling
 * the rest and scrolling inside. Controlled: the caller owns the flow and the
 * stage. The process page's Diagram view and `MapDialog` both render it.
 */
export function MapView({ flow, stage, onFlow, onStage, flows = true, className }: MapProps) {
  return (
    <div className={cn('grid min-h-0 grid-rows-[auto_minmax(0,1fr)]', className)}>
      <div className='border-b border-border px-4 py-3 pr-12'>
        <MomentPicker flow={flow} stage={stage} onFlow={onFlow} onStage={onStage} flows={flows} />
      </div>
      <ProcessDiagram moment={momentOf(flow, stage)} onStage={onStage} height='h-full' />
    </div>
  )
}

/** `MapView` full screen, in the library `Dialog`. */
export function MapDialog({
  open,
  onOpenChange,
  ...p
}: MapProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='h-[94vh] w-[96vw] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none'>
        <DialogTitle className='sr-only'>The Vinaya process, full screen</DialogTitle>
        <MapView {...p} className='h-full' />
      </DialogContent>
    </Dialog>
  )
}
