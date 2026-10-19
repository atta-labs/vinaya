'use client'

import dynamic from 'next/dynamic'
import type { GateState } from '@/process/types'
import { initialScene } from '@/process/types'
import { Group, SectionHeader } from '../shell'

const ProcessScene = dynamic(() => import('@/process/components/ProcessScene').then((m) => m.ProcessScene), {
  ssr: false
})

const moments = [
  { label: 'upstream', s: { ...initialScene } },
  { label: 'planner · 3 tasks', s: { ...initialScene, stage: 'planner' as const, tasks: 3, milestone: true } },
  {
    label: 'loop · orbit · gates',
    s: { ...initialScene, stage: 'loop' as const, tasks: 3, done: 1, orbit: true, gates: [2, 1, 0] as GateState }
  },
  { label: 'hot', s: { ...initialScene, stage: 'loop' as const, tasks: 1, hot: true, gates: [2, 2, 0] as GateState } },
  {
    label: 'archive · closed',
    s: { ...initialScene, stage: 'archive' as const, tasks: 3, done: 3, closed: true, gates: [2, 2, 2] as GateState }
  },
  { label: 'improve', s: { ...initialScene, stage: 'improve' as const, tasks: 3, done: 3, closed: true } }
]

export function SceneSection() {
  return (
    <>
      <SectionHeader slug='scene' />
      <Group name='ProcessScene · six states'>
        <div className='grid gap-3 md:grid-cols-3'>
          {moments.map((x) => (
            <div key={x.label} className='grid gap-1.5'>
              <span className='font-mono text-xs text-muted-foreground'>{x.label}</span>
              <div className='aspect-[4/3] overflow-hidden rounded-md border border-border bg-card'>
                <ProcessScene state={x.s} />
              </div>
            </div>
          ))}
        </div>
      </Group>
    </>
  )
}
