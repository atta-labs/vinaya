'use client'

import { Maximize2 } from 'lucide-react'
import { useState } from 'react'
import { MapDialog, MomentPicker, momentOf } from '@/process/diagram/MapDialog'
import { ProcessDiagram } from '@/process/diagram/ProcessDiagram'
import type { FlowKey, Stage } from '@/process/types'
import { Button } from '@/ui/components'
import { SectionHeader } from '../shell'

/** The full diagram with a moment picker; Full screen opens the same `MapDialog` the process page's Map opens. */
export function DiagramSection() {
  const [flow, setFlow] = useState<FlowKey>('feature')
  const [stage, setStage] = useState<Stage>('planner')
  const [full, setFull] = useState(false)
  return (
    <>
      <SectionHeader slug='diagram' />
      <div className='sticky top-0 z-20 -mx-5 mb-6 border-b border-border bg-background/90 px-5 py-3 backdrop-blur md:-mx-10 md:px-10'>
        <MomentPicker
          flow={flow}
          stage={stage}
          onFlow={setFlow}
          onStage={setStage}
          trailing={
            <Button variant='outline' size='sm' onClick={() => setFull(true)} className='order-last ml-auto'>
              <Maximize2 /> Full screen
            </Button>
          }
        />
      </div>
      <div className='rounded-md border border-border'>
        <ProcessDiagram moment={momentOf(flow, stage)} onStage={setStage} />
      </div>
      <MapDialog open={full} onOpenChange={setFull} flow={flow} stage={stage} onFlow={setFlow} onStage={setStage} />
    </>
  )
}
