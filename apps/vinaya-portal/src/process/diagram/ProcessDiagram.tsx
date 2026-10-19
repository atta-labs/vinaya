'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/ui/lib/utils'
import type { Stage } from '../types'
import { DiagramFrame, Linked, MomentProvider } from './links'
import type { Moment } from './moment'
import type { DiagramNode } from './nodes'
import { Observability, StageExecuting, StageImprovement, StageThinking, StageUpstream } from './stages'

/**
 * The whole process, driven by a `moment`: the stage components stacked in
 * order on the left, scrolling inside the frame; the Observability column on
 * the right, full height. Arrows are react-archer relations (`links.tsx`); the ones into
 * observability end at the flow's right edge, where the column begins.
 */
const frameOf = (s: Stage) =>
  s === 'upstream'
    ? 'product'
    : s === 'architect' || s === 'planner'
      ? 'stage1'
      : s === 'loop' || s === 'gates'
        ? 'stage2'
        : s === 'merge'
          ? 'closure'
          : s === 'archive'
            ? 'stage3'
            : s === 'observed'
              ? 'stage3'
              : 'stage4'

/** The narrowest width a still diagram lays out at: below it, cards would crush, so the diagram shrinks instead.
 * The whole process sets the loop and hot mode side by side, so it needs the width a desktop gives it. */
const stillMinWidth = (m: Moment) => (m.allFlows ? 1140 : 760)

/**
 * A still diagram's scale: its set scale while the room allows, smaller when the room is narrower than the
 * diagram's minimum width at that scale, so it always lays out at least its minimum width. Measured from the
 * element's parent, the width the diagram is given.
 */
function useFitScale(box: React.RefObject<HTMLDivElement | null>, scale: number, enabled: boolean, minWidth: number) {
  const [fit, setFit] = useState(scale)
  useEffect(() => {
    const parent = box.current?.parentElement
    if (!enabled || !parent) {
      setFit(scale)
      return
    }
    const measure = () => setFit(Math.min(scale, parent.clientWidth / minWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [box, scale, enabled, minWidth])
  return fit
}

/**
 * A still diagram on a scrolling page lights as the reader reaches it: every frame, the stages and each card in them,
 * is marked `data-active` once its top has passed a line two thirds down the reader's view, and stays lit below it,
 * so what has been read stays lit and scrolling back up un-lights in reverse. The root carries `data-scroll` while
 * this runs; unlit frames are dimmed by `DiagramContainer`. Under reduced motion nothing is marked, so all reads lit.
 * The view is the nearest ancestor that really scrolls.
 */
function useActiveFrames(box: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = box.current
    if (!enabled || !el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // The ancestor that really scrolls vertically: an `overflow-x` wrapper reads as `overflow-y: auto` but never scrolls.
    let view: HTMLElement | null = el.parentElement
    while (view && !(/(auto|scroll)/.test(getComputedStyle(view).overflowY) && view.scrollHeight > view.clientHeight))
      view = view.parentElement
    let frame = 0
    const check = () => {
      frame = 0
      const rect = view ? view.getBoundingClientRect() : { top: 0, height: window.innerHeight }
      const line = rect.top + (rect.height * 2) / 3
      for (const node of el.querySelectorAll<HTMLElement>('[data-node]'))
        node.toggleAttribute('data-active', node.getBoundingClientRect().top <= line)
    }
    const on = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    el.setAttribute('data-scroll', '')
    check()
    // Scroll events do not bubble; captured on the document, any scroller's reach here.
    document.addEventListener('scroll', on, { capture: true, passive: true })
    window.addEventListener('resize', on)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', on, { capture: true })
      window.removeEventListener('resize', on)
      el.removeAttribute('data-scroll')
      for (const node of el.querySelectorAll<HTMLElement>('[data-active]')) node.removeAttribute('data-active')
    }
  }, [box, enabled])
}

/** The stage a frame stands for when the reader scrolls to it. */
const stageOfFrame: Record<string, Stage> = {
  product: 'upstream',
  stage1: 'planner',
  stage2: 'loop',
  gates: 'loop',
  closure: 'merge',
  stage3: 'archive',
  stage4: 'improve'
}

export function ProcessDiagram({
  moment,
  onNode,
  onStage,
  className,
  height = 'h-[82vh]',
  band = false,
  zoom = 1,
  natural = false,
  scale = 1
}: {
  moment: Moment
  onNode?: (n: DiagramNode) => void
  /** Called when the reader scrolls a stage frame to the top: the picker follows the scroll. */
  onStage?: (s: Stage) => void
  className?: string
  /** Tailwind height class for the two-column frame; the flow scrolls inside it. */
  height?: string
  /** A phone's layout: the Observability column becomes a band under the flow, the Log and Studio side by side. */
  band?: boolean
  /** The flow's scale (CSS zoom, so the arrows are measured at the drawn size); it pans both ways inside the frame. */
  zoom?: number
  /** A still picture at its natural size: no fixed height and no scroll box, the Log and Studio as tall as they need. */
  natural?: boolean
  /** The whole diagram's scale (CSS zoom), text included: the still diagrams use it to stay readable. */
  scale?: number
}) {
  const p = { moment, onNode }
  const scroller = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  // A still diagram fits its width; the walk keeps its own scale and scrolls.
  const shown = useFitScale(root, scale, natural, stillMinWidth(moment))
  useActiveFrames(root, natural)
  // A new flow starts at the top; a new stage brings its frame into view.
  const prevFlow = useRef(moment.flow)
  // While a programmatic scroll is in flight the scroll-spy stays quiet, so a click does not select every frame it passes.
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quiet = useCallback(() => {
    if (settling.current) clearTimeout(settling.current)
    settling.current = setTimeout(() => {
      settling.current = null
    }, 700)
  }, [])
  // A stage the spy selected must not scroll back to its frame: the reader is already there.
  const fromSpy = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (prevFlow.current !== moment.flow) {
      prevFlow.current = moment.flow
      quiet()
      el.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (fromSpy.current) {
      fromSpy.current = false
      return
    }
    const target = el.querySelector<HTMLElement>(`[data-node="${frameOf(moment.stage)}"]`)
    if (!target) return
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16
    quiet()
    el.scrollTo({ top, behavior: 'smooth' })
  }, [moment.flow, moment.stage, quiet])
  // Scroll-spy: the last frame whose top has crossed the selection line is the current stage.
  const currentFrame = useRef<string | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el || !onStage) return
    let busy = false
    const on = () => {
      // Immediate: at most one check per scroll event, no trailing delay.
      if (busy) return
      busy = true
      queueMicrotask(() => {
        busy = false
        if (settling.current) return
        // The selection line sits a third of the way down: the last frames can never reach the very top.
        const box = el.getBoundingClientRect()
        const line = box.top + box.height * 0.35
        const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
        let frame: string | null = null
        const ids = Object.keys(stageOfFrame)
        for (const id of ids) {
          const f = el.querySelector<HTMLElement>(`[data-node="${id}"]`)
          if (f && f.getBoundingClientRect().top <= line) frame = id
        }
        if (atEnd) frame = ids[ids.length - 1] as string
        if (!frame || frame === currentFrame.current) return
        currentFrame.current = frame
        const stage = stageOfFrame[frame] as Stage
        if (stage !== moment.stage) {
          fromSpy.current = true
          onStage(stage)
        }
      })
    }
    // The reader's own wheel or touch ends any programmatic settling at once.
    const user = () => {
      if (settling.current) clearTimeout(settling.current)
      settling.current = null
    }
    el.addEventListener('scroll', on, { passive: true })
    el.addEventListener('wheel', user, { passive: true })
    el.addEventListener('touchmove', user, { passive: true })
    return () => {
      el.removeEventListener('scroll', on)
      el.removeEventListener('wheel', user)
      el.removeEventListener('touchmove', user)
    }
  }, [onStage, moment.stage])
  return (
    <MomentProvider moment={moment}>
      {/* A still diagram sits in a box whose width its content cannot push (inline-size containment), so the fit
          scale is measured from the room the page gives, not from the diagram itself. */}
      <div className={natural ? 'w-full min-w-0 [contain:inline-size]' : 'contents'}>
        <div
          className={cn(
            // The diagram's own line height, as a ratio of each text size: a page that sets a large fixed line height
            // (the docs' prose) must not spread its small type.
            'grid bg-background leading-normal',
            band
              ? natural
                ? 'grid-rows-[auto_auto]'
                : 'grid-rows-[minmax(0,1fr)_220px]'
              : 'grid-cols-[minmax(0,1fr)_minmax(240px,300px)]',
            !natural && height,
            className
          )}
          ref={root}
          data-diagram='process'
          style={shown === 1 ? undefined : { zoom: shown }}
        >
          <div ref={scroller} className={natural ? 'min-w-0' : 'min-w-0 overflow-auto'}>
            <div style={zoom === 1 ? undefined : { zoom }}>
              <DiagramFrame
                moment={moment}
                zoom={zoom * shown}
                className={cn(
                  'relative grid content-start gap-12 py-4 pl-10 pr-6',
                  // Zoomed out, the flow keeps the width a desktop gives it, so its cards lay out as they do there and the reader pans.
                  zoom === 1 && !(natural && moment.allFlows) ? 'min-w-[760px]' : 'min-w-[1140px]'
                )}
              >
                <StageUpstream {...p} />
                <StageThinking {...p} />
                <StageExecuting {...p} />
                <StageImprovement {...p} />
                <Linked id='observe'>
                  <div
                    data-node='observe'
                    aria-hidden
                    className='pointer-events-none absolute inset-y-4 right-0 w-px'
                  />
                </Linked>
              </DiagramFrame>
            </div>
          </div>
          <Observability {...p} row={band} className={band ? 'rounded-none border-x-0 border-b-0' : undefined} />
        </div>
      </div>
    </MomentProvider>
  )
}
