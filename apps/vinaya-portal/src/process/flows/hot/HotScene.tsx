'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@/ui/lib/utils'
import type { HotStory } from './story'

/**
 * Hot issue's scene: one descent from main, red, and the hot Issue to the new
 * Project the Log produces, driven by the walk. Copied from Medium work's `MediumScene`.
 *
 * The scene (`hot-scene.js`) reads its progress from one place,
 * `track.getBoundingClientRect()`, as `(canvasTop - track.top) / (track.height - canvasHeight)`.
 * So this component hands it a stand-in track whose rectangle encodes
 * `progress`; the scene still eases towards it itself. `archive` (0..1 through
 * the closing lines) is read every frame too; `story` once, on mount
 * (remount the component to change it, e.g. on a new tracker).
 */

type LabelTone = 'ink' | 'muted' | 'merged'
type LabelShape = 'tiny' | 'chip' | 'title'

// As in Complex work's scene: the scene creates its own label spans,
// so their classes must be authored in a .tsx file for Tailwind to generate them.
const LBL_BASE = 'absolute left-0 top-0 whitespace-nowrap opacity-0 transition-opacity duration-150 ease-out'
const LBL_SHAPE: Record<LabelShape | 'default', string> = {
  // no label under 14px at 1440 (text-sm is 15.75px there): `tiny` keeps its tighter tracking, not a smaller size
  default: 'font-mono text-sm uppercase tracking-widest',
  tiny: 'font-mono text-sm uppercase tracking-widest',
  chip: 'font-mono text-sm font-medium normal-case tracking-wide',
  title: 'font-sans text-2xl sm:text-4xl font-normal normal-case tracking-tight'
}
const LBL_TONE: Record<LabelTone, string> = {
  ink: 'text-foreground',
  muted: 'text-muted-foreground',
  merged: 'text-success'
}
function labelClass(tone: LabelTone, shape?: LabelShape) {
  return `${LBL_BASE} ${LBL_SHAPE[shape ?? 'default']} ${LBL_TONE[tone] ?? LBL_TONE.ink}`
}

export function HotScene({
  progress,
  archive = 0,
  story,
  className
}: {
  progress: number
  /** 0..1 through the closing lines: the Issue closes one unit per line. */
  archive?: number
  story: HotStory
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  // Read by the scene every frame through the stand-in track; never re-mounts the scene.
  const progressRef = useRef(progress)
  progressRef.current = progress
  const archiveRef = useRef(archive)
  archiveRef.current = archive
  // Read once, on mount: the scene is built from it.
  const storyRef = useRef(story)

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const labelLayer = labelsRef.current
    if (!(root && canvas && labelLayer)) return

    // A track whose rect puts the scene at `progress`: target = (top - r.top) / (r.height - h).
    const track = {
      getBoundingClientRect: () => {
        const c = canvas.getBoundingClientRect()
        const h = Math.max(1, Math.round(c.height))
        const height = h + 10000
        return { top: c.top - progressRef.current * (height - h), height }
      }
    }

    let cancelled = false
    let scene: { dispose: () => void } | null = null
    // Imported on mount so `three` stays out of the server graph and the initial chunk.
    import('./hot-scene').then(({ mountHotScene }) => {
      if (cancelled) return
      scene = mountHotScene({
        canvas,
        labelLayer,
        track,
        labelClass,
        story: storyRef.current,
        archive: () => archiveRef.current
      })
    })
    return () => {
      cancelled = true
      scene?.dispose()
    }
  }, [])

  return (
    <div
      ref={rootRef}
      data-progress={progress.toFixed(3)}
      data-archive={archive.toFixed(3)}
      className={cn(
        'relative overflow-hidden',
        // The drawing never ends on a hard line: it fades out over the box's edges.
        '[mask-composite:intersect] [mask-image:linear-gradient(to_right,transparent,black_14%,black_92%,transparent),linear-gradient(to_bottom,transparent,black_10%,black_90%,transparent)]',
        className
      )}
    >
      <canvas ref={canvasRef} aria-hidden className='absolute inset-0 block size-full' />
      <div ref={labelsRef} aria-hidden className='pointer-events-none absolute inset-0' />
    </div>
  )
}
