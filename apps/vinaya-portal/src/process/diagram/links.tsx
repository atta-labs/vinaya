'use client'

import { createContext, type ReactNode, use, useEffect, useMemo, useState } from 'react'
import { ArcherContainer, ArcherElement } from 'react-archer'
import { cn } from '@/ui/lib/utils'
import type { Tone } from '../types'
import { edgeVisible, type Moment, type NodeState, nodeState, stageState } from './moment'
import { bandById, type DiagramEdge, type DiagramTone, edges, nodes, stageAt } from './nodes'

/**
 * Arrows on react-archer. The diagram provides the moment through context;
 * every card and stage frame wraps itself in `Linked`, which derives its
 * outgoing relations from the edge list: anchors from the edge's sides, line
 * style from its shape, tone and state as classes, arrowhead colour from the
 * theme token resolved at mount.
 */
type RelationType = NonNullable<React.ComponentProps<typeof ArcherElement>['relations']>[number]

const MomentContext = createContext<Moment | null>(null)
/** True inside a `DiagramFrame`: only there can an element carry arrows. */
const FrameContext = createContext(false)

/** The moment alone, for parts of a diagram that sit outside its arrow frame (the observability column). */
export function MomentProvider({ moment, children }: { moment: Moment; children: ReactNode }) {
  return <MomentContext value={moment}>{children}</MomentContext>
}

export function DiagramFrame({
  moment,
  className,
  children,
  zoom = 1
}: {
  moment: Moment
  className?: string
  children: ReactNode
  /** The CSS zoom the frame is drawn at: react-archer measures in screen pixels, so its arrow layer takes the inverse. */
  zoom?: number
}) {
  // A frame inside a dialog is measured while the dialog is still zooming in, and react-archer only
  // re-measures on a window resize. So: a short burst of resize events after mount, and one on every
  // animation that ends anywhere on the page (the dialog's zoom included).
  useEffect(() => {
    const remeasure = () => window.dispatchEvent(new Event('resize'))
    const id = setInterval(remeasure, 200)
    const stop = setTimeout(() => clearInterval(id), 2200)
    document.addEventListener('animationend', remeasure)
    document.addEventListener('transitionend', remeasure)
    return () => {
      clearInterval(id)
      clearTimeout(stop)
      document.removeEventListener('animationend', remeasure)
      document.removeEventListener('transitionend', remeasure)
    }
  }, [])
  return (
    <MomentContext value={moment}>
      <FrameContext value={true}>
        <ArcherContainer
          className='relative'
          strokeColor='currentColor'
          strokeWidth={1.4}
          offset={2}
          endShape={{ arrow: { arrowLength: 5, arrowThickness: 5 } }}
          svgContainerStyle={zoom === 1 ? { zIndex: 1 } : { zIndex: 1, zoom: 1 / zoom }}
        >
          {/* react-archer renders its own inner wrapper; the layout lives on this element, not on the container */}
          <div className={className}>{children}</div>
        </ArcherContainer>
      </FrameContext>
    </MomentContext>
  )
}

export function useMoment(): Moment | null {
  return use(MomentContext)
}

/** State of any endpoint: a card by its node, a stage frame by the stage it is current at. */
function endpointState(id: string, m: Moment): NodeState {
  const node = nodes[id]
  if (node) return nodeState(node, m)
  const at = stageAt[id]
  if (!at || at === 'always') return 'always'
  return stageState(at, m)
}

function edgeState(e: DiagramEdge, m: Moment): NodeState {
  const a = endpointState(e.from, m)
  const b = endpointState(e.to, m)
  if (a === 'impossible' || b === 'impossible') return 'impossible'
  if (a === 'future' || b === 'future') return 'future'
  if (a === 'now' || b === 'now') return 'now'
  return 'done'
}

/** An arrow's colour, the same as the frames it joins: the ring at 70% for every stage arrow (no stage hue), muted for
 * the arrows into the Log and Studio. */
const toneColor = (t: DiagramTone) =>
  t === 'neutral' ? 'var(--muted-foreground)' : 'color-mix(in oklab, var(--ring) 70%, transparent)'

/** Resolves a theme token to the colour string the browser computed for it, so SVG attributes can take it. */
function useResolvedTones(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({})
  useEffect(() => {
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const out: Record<string, string> = {}
    for (const t of ['think', 'exec', 'retro', 'hot', 'log', 'product', 'neutral'] as DiagramTone[]) {
      probe.style.color = toneColor(t)
      out[t] = getComputedStyle(probe).color
    }
    probe.remove()
    setMap(out)
  }, [])
  return map
}

/** Relations leaving `id` at the moment, ready for `ArcherElement`. */
function useRelations(id: string): RelationType[] {
  const moment = useMoment()
  const tones = useResolvedTones()
  return useMemo(() => {
    if (!moment) return []
    const out: RelationType[] = []
    for (const e of edges) {
      if (e.from !== id || !edgeVisible(e, moment)) continue
      const state = edgeState(e, moment)
      if (state === 'impossible') continue
      const tone: DiagramTone = e.tone ?? nodes[e.to]?.tone ?? bandById[e.to]?.tone ?? 'neutral'
      out.push({
        targetId: e.to,
        sourceAnchor: e.fromSide ?? 'bottom',
        targetAnchor: e.toSide ?? 'top',
        className: cn('diagram-edge', `edge-${state}`, e.dashed && 'edge-dashed'),
        style: {
          strokeColor: tones[tone],
          strokeWidth: state === 'now' ? 2 : 1.4,
          strokeDasharray: e.dashed ? '4 4' : undefined,
          lineStyle: e.shape === 'straight' ? 'straight' : e.dashed ? 'angle' : 'curve'
        }
      })
    }
    return out
  }, [id, moment, tones])
}

/** Wraps one element that arrows can leave from or land on. Outside a `DiagramFrame` it is transparent. */
export function Linked({ id, children }: { id: string; children: React.ReactElement }) {
  const relations = useRelations(id)
  const inFrame = use(FrameContext)
  if (!inFrame) return children
  return (
    <ArcherElement id={id} relations={relations}>
      {children}
    </ArcherElement>
  )
}

export type { Tone }
