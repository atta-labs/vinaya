'use client'

import '../../_components/hero-canvas/hero-core.css'
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react'
import { cn } from '@/ui/lib/utils'
import { useReducedMotion } from '../../_components/landing/LandingInteractions'

// A gap on the track where the line crosses into or out of Vinaya's domain. The line is a pipe of energy: outside
// Vinaya it is many loose strands that converge on the boundary; inside it is one ordered beam. The boundary is the
// hero's fabric, stood up as a vertical wall (`fabric-wall.js`), and when the line's tip crosses it the hero's shock
// wave runs out through the wall from that point. Strands are ink, the pulses running along them are the ring.
// The scroll sets how far the energy has run (`draw`, 0…1) through the crossing's handle, every frame, without a React
// render; `into` says which side is Vinaya's.

/** Moves the energy along a crossing: the packet, the label and, on crossing the wall going forward, the shock wave. */
export type CrossingHandle = { setDraw: (draw: number) => void }

// Where the wall stands in the gap, as a share of its width.
const WALL = 0.5

// The loose strands outside: their offsets from the line, in the pipe's own units (the line is at 100 of 200), and
// how strongly each is drawn. Fixed, so the picture is the same on every render.
const STRANDS = [
  [-78, 0.18],
  [-58, 0.32],
  [-40, 0.22],
  [-24, 0.4],
  [-10, 0.28],
  [8, 0.36],
  [22, 0.2],
  [38, 0.34],
  [56, 0.24],
  [74, 0.16]
] as const

/** A point on a cubic Bézier at t. */
type Curve = readonly [number, number, number, number, number, number, number, number]

function bezier(p: Curve, t: number): [number, number] {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]]
}

/** A theme colour as the browser computed it, read off a probe so the canvas can paint with it. */
function themeColor(host: HTMLElement, className: string): string {
  const probe = document.createElement('span')
  probe.className = className
  host.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

/**
 * The pipe, painted in one canvas the size of the gap (the line runs through its middle): strands on the outside, the
 * beam on Vinaya's side, always there and faint, with one packet of energy at `draw` along it. It repaints only when
 * `draw` moves (`handle.setDraw`). Colours are the theme's foreground and ring, re-read on a theme switch.
 */
function Pipe({
  handle,
  into,
  vertical,
  at
}: {
  handle: Ref<CrossingHandle>
  into: boolean
  vertical: boolean
  at: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(0)
  const paint = useRef<() => void>(() => {})

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    let ink = themeColor(el.parentElement ?? el, 'text-foreground')
    let ring = themeColor(el.parentElement ?? el, 'text-ring')
    const themes = new MutationObserver(() => {
      ink = themeColor(el.parentElement ?? el, 'text-foreground')
      ring = themeColor(el.parentElement ?? el, 'text-ring')
      paint.current()
    })
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })

    paint.current = () => {
      const ratio = Math.min(devicePixelRatio || 1, 2)
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (!cw || !ch) return
      if (el.width !== Math.round(cw * ratio) || el.height !== Math.round(ch * ratio)) {
        el.width = Math.round(cw * ratio)
        el.height = Math.round(ch * ratio)
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, cw, ch)
      // Drawn along x; a vertical pipe is the same drawing turned a quarter, running down.
      if (vertical) {
        ctx.translate(cw, 0)
        ctx.rotate(Math.PI / 2)
      }
      const w = vertical ? ch : cw
      const h = vertical ? cw : ch
      const mid = h / 2
      const wall = at * w
      const spread = h / 200 // the strands' offsets are given for a 200-tall box
      const curve = (dy: number): Curve =>
        into
          ? [0, mid + dy * spread, wall * 0.55, mid + dy * spread, wall * 0.7, mid, wall, mid]
          : [wall, mid, wall + (w - wall) * 0.3, mid, wall + (w - wall) * 0.45, mid + dy * spread, w, mid + dy * spread]
      const [x0, x1] = into ? [wall, w] : [0, wall]
      const tip = drawRef.current * w
      const strand = (c: Curve) => {
        ctx.beginPath()
        ctx.moveTo(c[0], c[1])
        ctx.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7])
        ctx.stroke()
      }
      const beam = () => {
        ctx.beginPath()
        ctx.moveTo(x0, mid)
        ctx.lineTo(x1, mid)
        ctx.stroke()
      }

      // The pipe is always there, faint: the whole route, before any energy runs through it. It is drawn solid and then
      // dimmed as one layer, so where the strands meet and overlap it stays as muted as everywhere else instead of
      // their faintness adding up to a brighter spot.
      ctx.strokeStyle = ink
      ctx.globalAlpha = 1
      ctx.lineWidth = 1
      for (const [dy] of STRANDS) strand(curve(dy))
      beam()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'destination-in'
      ctx.globalAlpha = 0.18
      ctx.fillStyle = ink
      ctx.fillRect(0, 0, el.width, el.height)
      ctx.restore()

      // The energy: one packet travelling along the pipe. Only a short stretch behind the tip is lit, brightest at the
      // tip and fading out behind it, so the line goes quiet again once the packet has passed; on arrival it is gone.
      if (drawRef.current > 0 && drawRef.current < 1) {
        const length = w * 0.22
        const SLICES = 10
        for (let k = 0; k < SLICES; k++) {
          const from = tip - (length * (k + 1)) / SLICES
          const to = tip - (length * k) / SLICES
          if (to <= 0) break
          const fade = (1 - k / SLICES) ** 1.6
          ctx.save()
          ctx.beginPath()
          ctx.rect(Math.max(0, from), 0, to - Math.max(0, from), h)
          ctx.clip()
          // ink along the whole packet, the ring at its head
          ctx.strokeStyle = k < 3 ? ring : ink
          ctx.lineWidth = 1.25
          for (const [dy, strength] of STRANDS) {
            ctx.globalAlpha = Math.min(1, strength * 2) * fade
            strand(curve(dy))
          }
          ctx.lineWidth = 2
          ctx.globalAlpha = fade
          beam()
          ctx.restore()
        }
      }

      // The front of the energy: a glowing point in the ring on every line the tip is crossing.
      if (tip > 0 && tip < w) {
        const fronts: [number, number][] = []
        if (tip >= x0 && tip <= x1) fronts.push([tip, mid])
        else
          for (const [dy] of STRANDS) {
            const c = curve(dy)
            // the curve's x only grows along it: find the point at the tip by halving
            let lo = 0
            let hi = 1
            for (let k = 0; k < 14; k++) {
              const t = (lo + hi) / 2
              if (bezier(c, t)[0] < tip) lo = t
              else hi = t
            }
            fronts.push(bezier(c, lo))
          }
        ctx.fillStyle = ring
        ctx.shadowColor = ring
        ctx.shadowBlur = 12
        ctx.globalAlpha = 1
        for (const [x, y] of fronts) {
          ctx.beginPath()
          ctx.arc(x, y, fronts.length === 1 ? 3.5 : 2, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.shadowBlur = 0
      }
    }

    const raf = requestAnimationFrame(() => paint.current())
    const sizes = new ResizeObserver(() => paint.current())
    sizes.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      themes.disconnect()
      sizes.disconnect()
    }
  }, [into, vertical, at])

  // Repaint when the packet moves.
  useImperativeHandle(handle, () => ({
    setDraw(draw) {
      if (draw === drawRef.current) return
      drawRef.current = draw
      paint.current()
    }
  }))

  // A canvas does not stretch between `top` and `bottom` the way a box does, so the box sets the size and the canvas
  // fills it.
  return (
    <div
      className={
        vertical
          ? 'pointer-events-none absolute top-0 -bottom-8.5 left-1/2 w-40 -translate-x-1/2'
          : 'pointer-events-none absolute inset-x-0 top-1/2 h-40 -translate-y-1/2'
      }
    >
      <canvas ref={canvas} className='block size-full' />
    </div>
  )
}

/** The wall: the hero's fabric in its own canvas, the full height of the screen, centred on the line. */
function Wall({
  handle,
  vertical,
  into,
  at,
  shown
}: {
  handle: Ref<{ shock: () => void }>
  vertical: boolean
  into: boolean
  at: number
  shown: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const scene = useRef<{ shock: () => void; dispose: () => void } | null>(null)
  useEffect(() => {
    let cancelled = false
    import('./fabric-wall').then(({ mountFabricWall }) => {
      if (cancelled || !canvas.current || !host.current) return
      scene.current = mountFabricWall(canvas.current, host.current, { reduced, flat: vertical, mirror: !into })
    })
    return () => {
      cancelled = true
      scene.current?.dispose()
      scene.current = null
    }
  }, [reduced, vertical, into])
  useImperativeHandle(handle, () => ({ shock: () => scene.current?.shock() }))
  // The energy pierces the wall at its middle, which stands on the seam between two screens. Only the part of the wall
  // past the seam, on Vinaya's side, is drawn: a box half the wall's size, from the seam inward, clips it. So the wall
  // starts exactly where the lines meet it, and nothing of it shows on the screen the lines come from.
  // Down a phone the wall is the whole flat sheet, centred on the crossing, with soft edges all round; the pipe runs on
  // 8.5 spacing steps past the gap, through the next panel's label to its frame, and the wall sits at its crossing.
  if (vertical)
    return (
      <div
        ref={host}
        data-hero-viewport=''
        aria-hidden='true'
        className='pointer-events-none absolute left-1/2 -z-10 h-96 w-screen -translate-x-1/2 -translate-y-1/2 mask-x-from-70% mask-y-from-60%'
        style={{ opacity: shown, top: `calc(${at * 100}% + ${at * 8.5}rem / 4)` }}
      >
        <canvas ref={canvas} className='block size-full' />
      </div>
    )
  // Across, only the wall past the seam, on Vinaya's side, is drawn. The clip reaches a little (1.5rem) back over the
  // seam and fades in across it, so the wall's starting edge is soft rather than a hard line.
  return (
    <div
      aria-hidden='true'
      className={cn(
        'pointer-events-none absolute top-1/2 -z-10 h-screen w-[calc(12rem+1.5rem)] -translate-y-1/2 overflow-hidden',
        into ? '-ml-6 mask-l-from-78% mask-r-from-70%' : 'ml-6 -translate-x-full mask-r-from-78% mask-l-from-70%'
      )}
      style={{ opacity: shown, left: `${at * 100}%` }}
    >
      <div
        ref={host}
        data-hero-viewport=''
        className={cn('absolute inset-y-0 w-96 mask-y-from-70%', into ? '-left-42' : 'left-0')}
      >
        {/* the way out is the way-in wall flipped left to right about the seam */}
        <canvas ref={canvas} className={cn('block size-full', !into && '-scale-x-100')} />
      </div>
    </div>
  )
}

/**
 * A crossing: the pipe and the wall, and the label beside the beam (shown as the tip reaches it). `into` is true for the way into Vinaya, false for the way out.
 */
export function EnergyCrossing({
  ref,
  label,
  length,
  into,
  vertical = false,
  wall = WALL,
  fabric = 1,
  className
}: {
  ref?: Ref<CrossingHandle>
  label: string
  /** The gap's length along the track: its width, or its height when `vertical`. */
  length?: number
  into: boolean
  /** On a phone the track runs down the screen: the pipe runs down and the fabric lies across it. */
  vertical?: boolean
  /** Where the fabric stands along the gap, as a share of its length (the middle by default). */
  wall?: number
  /** How much of the fabric wall shows, 0 to 1: it belongs to the Vinaya scene, so it is hidden while a Product is framed. */
  fabric?: number
  className?: string
}) {
  // The label sits on the beam, inside Vinaya's domain: past the wall on the way in, before it on the way out.
  const labelAt = into ? (wall + 1) / 2 : wall / 2
  const pipe = useRef<CrossingHandle>(null)
  const wallScene = useRef<{ shock: () => void }>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  // The shock wave goes off once each time the tip crosses the wall going forward.
  const crossed = useRef(false)
  useImperativeHandle(ref, () => ({
    setDraw(draw) {
      pipe.current?.setDraw(draw)
      if (labelRef.current) labelRef.current.style.opacity = draw >= labelAt ? '1' : '0'
      const now = draw >= wall
      if (now && !crossed.current) wallScene.current?.shock()
      crossed.current = now
    }
  }))
  if (vertical)
    return (
      <div
        aria-hidden='true'
        className={cn('relative w-full', className)}
        style={length ? { height: length } : undefined}
      >
        <Wall handle={wallScene} vertical into={into} at={wall} shown={fabric} />
        <Pipe handle={pipe} into={into} vertical at={wall} />
        <span
          ref={labelRef}
          className='absolute left-1/2 ml-4 -translate-y-1/2 whitespace-nowrap text-lg leading-none text-foreground opacity-0 transition-opacity duration-300'
          style={{ top: `${labelAt * 100}%` }}
        >
          {label}
        </span>
      </div>
    )
  return (
    <div
      aria-hidden='true'
      className={cn('flex flex-col gap-3', className)}
      style={length ? { width: length } : undefined}
    >
      <span className='invisible font-mono text-base uppercase leading-snug'>·</span>
      <div className='relative flex flex-1 items-center'>
        <Wall handle={wallScene} vertical={false} into={into} at={wall} shown={fabric} />
        <Pipe handle={pipe} into={into} vertical={false} at={wall} />
        <span
          ref={labelRef}
          className='absolute bottom-1/2 mb-3 -translate-x-1/2 whitespace-nowrap text-lg leading-none text-foreground opacity-0 transition-opacity duration-300'
          style={{ left: `${labelAt * 100}%` }}
        >
          {label}
        </span>
      </div>
    </div>
  )
}
