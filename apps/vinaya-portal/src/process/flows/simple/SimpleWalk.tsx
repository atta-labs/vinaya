'use client'

import type { ReactNode } from 'react'
import { DemoWalk } from '../../components/DemoWalk'
import { ProcessProvider } from '../../store'
import { SimpleScene } from './SimpleScene'

/** `/vinaya-process/demo/simple`: Simple task, walked step by step beside its backlog: one row, out and back. */
export function SimpleWalk({ logoUrl, search }: { logoUrl: string | null; search?: ReactNode }) {
  return (
    <ProcessProvider flow='backlog' started>
      <DemoWalk logoUrl={logoUrl} search={search} aside={<SimpleScene />} />
    </ProcessProvider>
  )
}
