'use client'

import { useState } from 'react'
import type { FlowKey, Stage } from '@/process/types'
import { MapView } from './MapDialog'

/** The whole process as one view, holding its own flow and stage: the full diagram page and its preview. */
export function DiagramPanel({
  flow: initialFlow = 'feature',
  stage: initialStage = 'planner',
  className
}: {
  flow?: FlowKey
  stage?: Stage
  className?: string
}) {
  const [flow, setFlow] = useState<FlowKey>(initialFlow)
  const [stage, setStage] = useState<Stage>(initialStage)
  return <MapView flow={flow} stage={stage} onFlow={setFlow} onStage={setStage} className={className} />
}
