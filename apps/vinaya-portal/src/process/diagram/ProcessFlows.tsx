'use client'

import type { ComponentProps } from 'react'
import type { FlowKey } from '../types'
import type { Moment } from './moment'
import { ProcessDiagram } from './ProcessDiagram'

/**
 * The five still diagrams: one per flow, each drawing only its own part, and the whole process with every flow.
 * They are not separate drawings. Each is `ProcessDiagram` at a fixed moment, so every layer in them (the upstream
 * cards, the Architect and Planners, the dev-review loop, the runtimes, the gates, closure, retrospecting, the
 * Improver, the Log and Studio) is the one component in `stages.tsx`: change a layer there and it changes in every
 * diagram that draws it. Nothing in them is picked or played; they are pictures.
 */

export const FLOW_NAMES: Record<FlowKey, string> = {
  feature: 'Deploy complex work',
  medium: 'Deploy medium work',
  backlog: 'Deploy backlog issues',
  hot: 'Deploy hot issue now'
}

export const FLOW_ORDER: FlowKey[] = ['feature', 'medium', 'backlog', 'hot']

/** One flow, its part only: what it never passes is left out, everything it passes drawn plain. */
const flowOnlyMoment = (flow: FlowKey): Moment => ({
  flow,
  stage: 'upstream',
  gates: [2, 2, 2],
  closed: true,
  settled: true,
  only: true
})

/** The whole process: every flow's cards and arrows, none faded. */
const wholeProcessMoment: Moment = {
  flow: 'feature',
  stage: 'upstream',
  gates: [2, 2, 2],
  closed: true,
  allFlows: true
}

type DiagramProps = Omit<ComponentProps<typeof ProcessDiagram>, 'moment' | 'onNode' | 'onStage'>

/** How a still diagram is drawn: at its natural height with no scroll box, the Log and Studio side by side under
 * the flow at full height, and enlarged so its small type reads. `scale` overrides the size where room is short. */
const STILL = { band: true, natural: true, scale: 1.35 } as const

/** A flow's own diagram. */
export function FlowOnlyDiagram({ flow, ...props }: DiagramProps & { flow: FlowKey }) {
  return <ProcessDiagram moment={flowOnlyMoment(flow)} {...STILL} {...props} />
}

/** Every flow on one diagram. */
export function WholeProcessDiagram(props: DiagramProps) {
  return <ProcessDiagram moment={wholeProcessMoment} {...STILL} {...props} />
}
