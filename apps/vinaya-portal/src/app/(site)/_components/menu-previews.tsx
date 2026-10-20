'use client'

import { Code, Eye, FileText, GitPullRequest, Shield } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { improveStats } from '@/process/fixtures/lifecycle'
import { cn } from '@/ui/lib/utils'
import { colorHex } from '@/ui/lib/theme-color'
import { LOG_LINES } from './landing/FeatureSections'
import { Terminal } from './landing/Terminal'

// The Product menu's right-hand scenes: each feature's own content, played once per menu opening and then held on
// its last frame. The Self-improvement infinity is the one that keeps flowing while the menu is open. Under reduced
// motion every scene draws its last frame. Each fills the panel's 446 × 176 visual area.

const START_MS = 180

// What has already played in this opening. Switching items unmounts one scene and mounts the next at once, so the
// count only stays at zero once the menu has closed; then the set clears and the next opening plays again.
const played = new Set<string>()
let mounted = 0
let clearTimer: ReturnType<typeof setTimeout> | undefined

function usePlayOnce(key: string, durationMs: number) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    mounted++
    clearTimeout(clearTimer)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    if (reduced || played.has(key)) setElapsed(Number.POSITIVE_INFINITY)
    else {
      const t0 = performance.now()
      const tick = (now: number) => {
        const e = now - t0 - START_MS
        setElapsed(e)
        if (e < durationMs) raf = requestAnimationFrame(tick)
        else played.add(key)
      }
      raf = requestAnimationFrame(tick)
    }
    return () => {
      cancelAnimationFrame(raf)
      mounted--
      if (mounted === 0) clearTimer = setTimeout(() => played.clear(), 300)
    }
  }, [key, durationMs])
  return elapsed
}

const ease = (p: number) => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3
const AREA = 'h-[176px] w-full'

/* ── Log: the merge of checkout-v2 arriving in the `vinaya log --follow` terminal ── */

const LOG_FIRST = 3
const LOG_STEP = 280

export function LogScene() {
  const e = usePlayOnce('log', (LOG_LINES.length - LOG_FIRST) * LOG_STEP)
  const count = Math.min(LOG_LINES.length, LOG_FIRST + Math.max(0, Math.floor(e / LOG_STEP) + 1))
  return (
    <span className={cn(AREA, 'block')}>
      <Terminal
        header={
          <>
            <span>$ vinaya log --follow</span>
            <span className='inline-flex items-center gap-2'>
              <i className='inline-block size-[7px] rounded-full bg-success' />
              live
            </span>
          </>
        }
        headerClassName='whitespace-nowrap text-muted-foreground'
        lines={LOG_LINES.slice(0, e < 0 ? LOG_FIRST : count)}
        rows={5}
        anchor='top'
        highlightLast
        className='text-[13px]'
        aria-hidden='true'
      />
    </span>
  )
}

/* ── Telemetry: the Checkout v2 milestone report, its bar filling and figures counting up ── */

const COUNT_TO: Record<string, [number, (n: number) => string]> = {
  'time per task': [34, (n) => `${n} min`],
  'second rounds': [19, (n) => `${n} of 52`],
  'problems caught': [418, (n) => String(n)],
  'checks run': [18508, (n) => n.toLocaleString('en-US')]
}

export function TelemetryScene() {
  const e = usePlayOnce('telemetry', 350 + 120 * 3 + 700)
  return (
    <span aria-hidden='true' className={cn(AREA, 'flex flex-col')}>
      <span className='flex flex-col gap-2 border-b border-border/50 pb-3.5'>
        <span className='font-mono text-xs uppercase tracking-widest text-muted-foreground'>Milestone report</span>
        <span className='flex items-baseline justify-between gap-3'>
          <span className='text-lg leading-snug'>Checkout v2</span>
          <span className='text-sm tabular-nums'>
            {Math.round(52 * ease(e / 800))} of 52 <span className='text-muted-foreground'>tasks merged</span>
          </span>
        </span>
        <span className='block h-1.5 bg-border/50'>
          <span
            className={cn(
              'block h-full w-full origin-left bg-success transition-transform duration-[800ms] ease-out motion-reduce:transition-none',
              e >= 0 ? 'scale-x-100' : 'scale-x-0'
            )}
          />
        </span>
      </span>
      <span className='grid flex-1 grid-cols-4'>
        {improveStats.map((stat, i) => {
          const at = 350 + i * 120
          const [to, fmt] = COUNT_TO[stat.label] ?? [0, String]
          return (
            <span
              key={stat.label}
              className={cn(
                'flex flex-col justify-center gap-2.5 border-r border-border/50 pl-3 transition-[opacity,transform] duration-[400ms] first:pl-0 last:border-r-0 motion-reduce:transition-none',
                e >= at ? 'translate-y-0 opacity-100' : 'translate-y-[3px] opacity-0'
              )}
            >
              <span className='h-8 font-mono text-[11px] uppercase leading-tight tracking-widest text-muted-foreground'>
                {stat.label}
              </span>
              <span className='whitespace-nowrap text-[28px] leading-none tracking-tighter tabular-nums'>
                {Number.isFinite(e) ? fmt(Math.round(to * ease((e - at) / 700))) : stat.value}
              </span>
            </span>
          )
        })}
      </span>
    </span>
  )
}

/* ── Studio: the dev review loop monitor lighting its rounds ── */

type Role = 'dev' | 'code' | 'sec'
type CellState = 'pend' | 'run' | 'ok' | 'bad'
type Round = Record<Role, CellState>
type LoopEvent = readonly [number, number, readonly Role[], CellState, string]

const LOOP_TASKS = [
  { name: 'Custom events', meta: '#893 · opus' },
  { name: 'Streaming parser', meta: '#895 · sonnet' }
]
const LOOP_START: Round[][] = [
  [
    { dev: 'ok', code: 'run', sec: 'run' },
    { dev: 'pend', code: 'pend', sec: 'pend' }
  ],
  [
    { dev: 'run', code: 'pend', sec: 'pend' },
    { dev: 'pend', code: 'pend', sec: 'pend' }
  ]
]
const LOOP_EVENTS: readonly LoopEvent[] = [
  [0, 0, ['sec'], 'ok', 'Security: pass'],
  [0, 0, ['code'], 'bad', 'Code review: changes requested'],
  [1, 0, ['dev'], 'ok', 'Developer: round 1 done'],
  [0, 1, ['dev'], 'run', 'Round 2: developer addressing the findings'],
  [1, 0, ['code', 'sec'], 'run', 'Reviewers dispatched in parallel'],
  [1, 0, ['sec'], 'ok', 'Security: pass'],
  [0, 1, ['dev'], 'ok', 'Developer: round 2 done'],
  [0, 1, ['code', 'sec'], 'run', 'Reviewers dispatched in parallel'],
  [1, 0, ['code'], 'ok', 'Code review: approved · PR #895 up'],
  [0, 1, ['code', 'sec'], 'ok', 'Both approved, PR #893 up'],
  [-1, 0, [], 'ok', '2 PRs waiting for your merge']
]
const LOOP_STEP = 260

const CELL: Record<CellState, string> = {
  pend: 'border-solid border-muted-foreground text-muted-foreground opacity-30',
  run: 'border-dashed border-foreground text-foreground',
  ok: 'border-solid border-success text-success',
  bad: 'border-solid border-destructive text-destructive'
}
const FRESH = 'ring-2 ring-current ring-offset-2 ring-offset-card'
const ROLE_ICON: Record<Role, ReactNode> = {
  dev: <Code className='size-[13px]' />,
  code: <Eye className='size-[13px]' />,
  sec: <Shield className='size-[13px]' />
}
const LOOP_GRID = 'grid grid-cols-[160px_104px_104px_minmax(0,1fr)_26px] items-center gap-x-2'

function Cell({ state, fresh, children }: { state: CellState; fresh: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'grid size-[26px] place-items-center rounded-full border-[1.5px] transition-[border-color,color,opacity,box-shadow] duration-300 motion-reduce:transition-none',
        CELL[state],
        fresh && FRESH
      )}
    >
      {children}
    </span>
  )
}

export function StudioScene() {
  const e = usePlayOnce('studio', LOOP_EVENTS.length * LOOP_STEP)
  const k = Math.min(LOOP_EVENTS.length, Math.max(0, Math.floor(e / LOOP_STEP) + 1))
  const rounds = LOOP_START.map((task) => task.map((round) => ({ ...round })))
  for (const [task, round, roles, state] of LOOP_EVENTS.slice(0, k)) {
    const target = rounds[task]?.[round]
    if (target) for (const role of roles) target[role] = state
  }
  const last = k > 0 ? (LOOP_EVENTS[k - 1] ?? null) : null
  const done = k >= LOOP_EVENTS.length
  const status = done ? 'PUBLISHED · 2 PRs need your merge' : k >= 9 ? 'RUNNING · 1 PR up' : 'RUNNING · 2 tasks'
  return (
    <span aria-hidden='true' className={cn(AREA, 'flex flex-col justify-between')}>
      <span className='block'>
        <span className={cn(LOOP_GRID, 'mb-1 h-4')}>
          <span className='whitespace-nowrap font-mono text-[11px] uppercase tracking-widest text-muted-foreground'>
            dev review loop monitor
          </span>
          <span className='justify-self-center font-mono text-[11px] uppercase text-muted-foreground'>r1</span>
          <span className='justify-self-center font-mono text-[11px] uppercase text-muted-foreground'>r2</span>
          <span />
          <span className='justify-self-center font-mono text-[11px] uppercase text-muted-foreground'>pr</span>
        </span>
        {LOOP_TASKS.map((task, ti) => {
          const taskRounds = rounds[ti] ?? []
          const pr = taskRounds.some((round) => round.code === 'ok' && round.sec === 'ok')
          const prFresh = last !== null && last[0] === ti && pr && /PR/.test(last[4])
          return (
            <span key={task.name} className={cn(LOOP_GRID, 'h-[58px] border-t border-border')}>
              <span className='flex min-w-0 flex-col'>
                <span className='truncate text-base leading-tight'>{task.name}</span>
                <span className='whitespace-nowrap font-mono text-xs text-muted-foreground'>{task.meta}</span>
              </span>
              {taskRounds.map((round, ri) => (
                <span key={ri} className='flex items-center gap-[5px] justify-self-center'>
                  {(['dev', 'code', 'sec'] as const).map((role, roleIndex) => (
                    <span key={role} className='flex items-center gap-[5px]'>
                      {roleIndex === 1 ? <span className='h-[1.5px] w-[5px] bg-border' /> : null}
                      <Cell
                        state={round[role]}
                        fresh={last !== null && last[0] === ti && last[1] === ri && last[2].includes(role)}
                      >
                        {ROLE_ICON[role]}
                      </Cell>
                    </span>
                  ))}
                </span>
              ))}
              <span />
              <span
                className={cn(
                  'grid size-[26px] place-items-center justify-self-center rounded-full border-[1.5px] border-dashed transition-[border-color,color,opacity,box-shadow] duration-300 motion-reduce:transition-none',
                  pr
                    ? 'border-solid border-ring text-ring'
                    : 'border-muted-foreground text-muted-foreground opacity-30',
                  prFresh && FRESH
                )}
              >
                <GitPullRequest className='size-[13px]' />
              </span>
            </span>
          )
        })}
      </span>
      <span className='flex h-7 items-center justify-between gap-3 border border-border bg-background px-3 font-mono text-[11px] tracking-wider text-muted-foreground'>
        <span className={cn('truncate', done && 'text-success')}>{status}</span>
        <span className='whitespace-nowrap'>vinaya log --follow</span>
      </span>
    </span>
  )
}

/* ── Self-improvement: the hero's infinity (hero-canvas/infinity-flow.js), drawn flat, without the harness ── */

const INF = { w: 446, h: 176, samples: 600, packets: 3, speed: 0.07, draw: 0.6, lobe: 183, squash: 1.28 }
const STRANDS = [
  { a: 1, ys: 1, rot: 0, width: 1.4, phase: 0, alpha: 1 },
  { a: 0.988, ys: 0.975, rot: 0.006, width: 1.0, phase: 0.04, alpha: 0.7 },
  { a: 1.01, ys: 1.02, rot: -0.005, width: 0.8, phase: 0.08, alpha: 0.5 }
]
const fract = (x: number) => x - Math.floor(x)
type Pt = { x: number; y: number; u: number }

function sampleStrand({ a, ys, rot }: (typeof STRANDS)[number]): Pt[] {
  const A = a * INF.lobe
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const pts: (Pt & { len: number })[] = []
  let len = 0
  for (let i = 0; i <= INF.samples; i++) {
    const t = Math.PI / 2 - 2 * Math.PI * (i / INF.samples)
    const d = 1 + Math.sin(t) ** 2
    const x0 = (A * Math.cos(t)) / d
    const y0 = ((A * Math.sin(t) * Math.cos(t)) / d) * ys * INF.squash
    const x = INF.w / 2 + (x0 * c - y0 * s)
    const y = INF.h / 2 - (x0 * s + y0 * c)
    const prev = pts[i - 1]
    if (prev) len += Math.hypot(x - prev.x, y - prev.y)
    pts.push({ x, y, len, u: 0 })
  }
  for (const p of pts) p.u = p.len / len
  return pts
}

const rgb = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] as const
const lerp = (p: readonly number[], q: readonly number[], s: number) => p.map((v, i) => v + ((q[i] ?? 0) - v) * s)

function readRamp() {
  const css = getComputedStyle(document.documentElement)
  return ['--warning', '--destructive', '--success'].map((name) => rgb(colorHex(css.getPropertyValue(name).trim())))
}

export function ImproveScene() {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const dpr = window.devicePixelRatio || 1
    el.width = Math.round(INF.w * dpr)
    el.height = Math.round(INF.h * dpr)
    const paths = STRANDS.map(sampleStrand)
    let ramp = readRamp()
    // the scheme toggle rewrites the theme: read the ramp again
    const observer = new MutationObserver(() => {
      ramp = readRamp()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    const colorAt = (x: number, alpha: number) => {
      const s = fract(x) * 3
      const [c1 = [0, 0, 0], c2 = [0, 0, 0], c3 = [0, 0, 0]] = ramp
      const v = s < 1 ? lerp(c1, c2, s) : s < 2 ? lerp(c2, c3, s - 1) : lerp(c3, c1, s - 2)
      return `rgb(${v.map(Math.round).join(' ')} / ${alpha.toFixed(3)})`
    }
    const draw = (time: number, head: number, born: boolean) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, INF.w, INF.h)
      ctx.lineCap = 'round'
      STRANDS.forEach((cfg, si) => {
        const pts = paths[si] ?? []
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i] as Pt
          const q = pts[i + 1] as Pt
          let I = 0.12
          if (!born) {
            if (p.u > head) break
            I += Math.max(0, 1 - (head - p.u) / 0.07) * 1.3
          }
          for (let k = 0; k < INF.packets; k++) {
            const f = 1 - fract(p.u - time * INF.speed - cfg.phase - k / INF.packets)
            if (f < 0.24) {
              const r = 1 - f / 0.24
              I += r * r * r * 1.1
            }
          }
          const a = Math.min(1, I * cfg.alpha)
          if (a <= 0.003) continue
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(q.x, q.y)
          if (I > 0.4) {
            ctx.lineWidth = cfg.width + 3
            ctx.strokeStyle = colorAt(p.u + time * 0.03, a * 0.14)
            ctx.stroke()
          }
          ctx.lineWidth = cfg.width + 0.6
          ctx.strokeStyle = colorAt(p.u + time * 0.03, a)
          ctx.stroke()
        }
      })
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(2, 1, true)
      return () => observer.disconnect()
    }
    mounted++
    clearTimeout(clearTimer)
    const skipDraw = played.has('improve')
    const t0 = performance.now() / 1000 - (skipDraw ? START_MS / 1000 + 1 / INF.draw : 0)
    let raf = 0
    const tick = () => {
      const age = performance.now() / 1000 - t0
      const head = Math.max(0, (age - START_MS / 1000) * INF.draw)
      if (head >= 1) played.add('improve')
      draw(age, Math.min(1, head), head >= 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      mounted--
      if (mounted === 0) clearTimer = setTimeout(() => played.clear(), 300)
    }
  }, [])
  return <canvas ref={canvas} className={cn(AREA, 'block')} />
}

/* ── Configuration: vinaya.config.json, its lines springing in while the window follows the newest ── */

const CONFIG = [
  '{',
  '  "rings": {',
  '    "ring1_forgeWriteInterception": true,',
  '    "ring2_asyncAudits": true',
  '  },',
  '  "checks": {',
  '    "acme/secret-scan": {',
  '      "run": "./scripts/vinaya-checks/secret-scan.ts",',
  '      "scope": "full"',
  '    }',
  '  },',
  '  "logs": {',
  '    "url": "https://logs.acme.dev/v1/events"',
  '  }',
  '}'
]
const CONFIG_STEP = 110
const CONFIG_ROWS = 7
const CONFIG_ROW = 17

export function ConfigScene() {
  const e = usePlayOnce('config', CONFIG.length * CONFIG_STEP + 400)
  const n = Math.min(CONFIG.length, Math.max(0, Math.floor(e / CONFIG_STEP) + 1))
  return (
    <span aria-hidden='true' className={cn(AREA, 'flex flex-col overflow-hidden border border-border bg-card')}>
      <span className='flex h-[33px] flex-none items-center justify-between gap-4 border-b border-border bg-background px-3.5 font-mono text-[0.667rem] tracking-wider text-muted-foreground'>
        <span className='inline-flex items-center gap-2'>
          <FileText className='size-[13px]' />
          vinaya.config.json
        </span>
        <span>rings · checks · logs</span>
      </span>
      <span className='block flex-1 px-3.5 py-[11px]'>
        <span className='block h-[119px] overflow-hidden'>
          <span
            className='block transition-transform duration-300 ease-out motion-reduce:transition-none'
            style={{ transform: `translateY(${-Math.max(0, n - CONFIG_ROWS) * CONFIG_ROW}px)` }}
          >
            {CONFIG.map((line, i) => {
              const match = /^(\s*)("[^"]+")(:.*)$/.exec(line)
              return (
                <span
                  key={i}
                  className={cn(
                    'block h-[17px] whitespace-pre font-mono text-[0.667rem] leading-[17px] text-foreground transition-[opacity,transform] duration-[400ms] ease-out motion-reduce:transition-none',
                    i < n ? 'translate-y-0 opacity-100' : 'translate-y-[6px] opacity-0'
                  )}
                >
                  {match ? (
                    <>
                      {match[1]}
                      <span className='text-muted-foreground'>{match[2]}</span>
                      {match[3]}
                    </>
                  ) : (
                    line
                  )}
                </span>
              )
            })}
          </span>
        </span>
      </span>
    </span>
  )
}
