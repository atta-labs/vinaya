import type { FlowKey, GateState, Stage } from '../types'
import type { DiagramEdge, DiagramNode } from './nodes'

/** A point in the walkthrough: which flow, which stage, how the gates stand. */
export type Moment = {
  flow: FlowKey
  stage: Stage
  gates?: GateState
  closed?: boolean
  /** A still picture, not a moment in a walk: every node the flow passes is drawn plain, nothing lit or muted. */
  settled?: boolean
  /** The whole process: every flow's nodes and edges drawn, none faded as impossible. Implies `settled`. */
  allFlows?: boolean
  /** Only this flow's part: a node the flow never passes is left out, not drawn faded, and its row closes up. */
  only?: boolean
}

/**
 * What a node looks like at a moment.
 * - `impossible`: the flow never passes here. The card keeps its place, faded and dashed, so the other paths stay readable.
 * - `future`: the flow will pass here later. Muted.
 * - `now`: the reader is here. Lit.
 * - `done`: already passed. Normal.
 * - `always`: the observed column; never muted.
 */
export type NodeState = 'impossible' | 'future' | 'now' | 'done' | 'always'

const stageOrder: Stage[] = [
  'upstream',
  'architect',
  'planner',
  'loop',
  'gates',
  'merge',
  'archive',
  'observed',
  'improve'
]
const rank = (s: Stage) => stageOrder.indexOf(s)

const inFlow = (flows: FlowKey[] | 'all' | undefined, flow: FlowKey) =>
  flows === 'all' || (Array.isArray(flows) && flows.includes(flow))

/** Whether a node is drawn at all: always, except a node outside the flow when the moment shows only the flow's part. */
export const shows = (node: { flows: FlowKey[] | 'all' }, m: Moment) =>
  !m.only || m.allFlows === true || inFlow(node.flows, m.flow)

/** The state of a whole stage at a moment, from the stage it is current at. */
export function stageState(at: Stage, m: Moment): NodeState {
  if (m.settled || m.allFlows) return 'done'
  const a = rank(at)
  const b = rank(m.stage)
  if (a === b) return 'now'
  return a < b ? 'done' : 'future'
}

export function nodeState(node: DiagramNode, m: Moment): NodeState {
  if (!m.allFlows && !inFlow(node.flows, m.flow)) return 'impossible'
  if (node.at === 'always') return 'always'
  if (m.settled || m.allFlows) return 'done'
  if (node.id.startsWith('ring') && m.gates) {
    const i = Number(node.id.slice(4)) as 0 | 1 | 2
    const g = m.gates[i]
    if (g === 1) return 'now'
    if (g === 2) return 'done'
  }
  const a = rank(node.at)
  const b = rank(m.stage)
  if (a === b) return 'now'
  return a < b ? 'done' : 'future'
}

export function edgeVisible(edge: DiagramEdge, m: Moment): boolean {
  return m.allFlows === true || inFlow(edge.flows, m.flow)
}
