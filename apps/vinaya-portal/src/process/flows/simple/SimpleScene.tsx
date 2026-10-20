'use client'

import { useEffect, useRef, useState } from 'react'
import { lerp, progressBetween } from '@/ui/lib/math'
import { brandPath } from '../../components/BrandIcon'
import { shownAt, stepLines } from '../../replay'
import { useProcess } from '../../store'
import { trackerLabel } from '../../types'
import { simpleFlow } from './flow'

/**
 * Simple task's right column: one flat picture, the tracker's backlog, and one row's loop out and back.
 * The Planner writes #1000 into the list; it lifts onto a lane off main, runs the loop (sandbox, hooks,
 * pull request, CI, two reviewers), merges, drops back Done; the Log's report sends #1001 into the same list.
 *
 * Every value is a pure function of the walk's cursor, counted in typed lines of the step in view, so
 * scrolling back replays the same frames; under reduced motion each step's progress is 1, its last frame.
 * Drawn in a 720 × 600 box, scaled to the column; colours are the theme's tokens. Below 720px the type grows
 * against the scale (`k`, up to 1.8), so a label never renders under about 8px on a tablet's half column.
 */

const W = 720
const H = 600
const ROW = 48
const HEAD = 44
const PANEL = { x: 24, w: 672, h: HEAD + ROW * 5 }
const PANEL_MID = (H - PANEL.h) / 2
const PANEL_LOW = 300
const RAIL = 260
const LANE = 150
const LIFTED = { x: 24, y: 24, w: 400, h: 40 }

const typeOut = (text: string, f: number) => text.slice(0, Math.round(text.length * f))
/** A label in two lines, split at the word nearest its middle. */
const halves = (text: string) => {
  const words = text.split(' ')
  if (words.length < 2) return [text]
  let at = 1
  while (at < words.length - 1 && words.slice(0, at + 1).join(' ').length <= text.length / 2) at++
  return [words.slice(0, at).join(' '), words.slice(at).join(' ')]
}

const task = simpleFlow.tranches[0]?.tasks[0]
const ISSUE = task?.issue ?? 1000
const TITLE = task?.title ?? 'Resume refuses kept work'
const FILE = task?.file.split('/').pop() ?? 'resume.ts'
const NEXT = { issue: ISSUE + 1, title: 'Test resume after a half-way run' }
const STATS = simpleFlow.steps.find((s) => s.kind === 'improve')?.stats ?? []
const OTHERS = [
  'Theme flicker on reload',
  'Rename gate summary field',
  'Doc links in CLI help',
  'Trim Studio empty state'
]

// type sizes in px at full scale, multiplied by `k` when the drawing is shown smaller. A label is never under
// LABEL_MIN of the drawing: 14px on screen at 1440, where the drawing shows at about 1.1×.
const LABEL_MIN = 13
const LABEL = 'font-mono tracking-widest'
/** A label's size in the drawing's px, for the layout that measures it. */
const labelPx = (k: number) => Math.max(LABEL_MIN, 10 * k)
const ROW_TEXT = 'font-mono'
/** Baseline of a line of `px` type centred in a box of height `h` at `y`. */
const mid = (y: number, h: number, px: number, k: number) => y + h / 2 + 0.35 * px * k

/** One stretch of the lane, drawn as far as `f`. */
function Stroke({ d, f, className }: { d: string; f: number; className?: string }) {
  return (
    <path
      d={d}
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - f}
      opacity={f > 0 ? 1 : 0}
      fill='none'
      className={className}
    />
  )
}

/** A stop on the lane: lit as its line types, its label above or below. */
function Stop({
  x,
  y,
  f,
  k,
  label,
  below
}: {
  x: number
  y: number
  f: number
  k: number
  label: string
  below?: boolean
}) {
  return (
    <g opacity={f}>
      <circle cx={x} cy={y} r={5} className='fill-primary' />
      <text
        fontSize={labelPx(k)}
        x={x}
        y={below ? y + 14 + labelPx(k) : y - 4 - labelPx(k)}
        textAnchor='middle'
        className={`${LABEL} fill-foreground`}
      >
        {label}
      </text>
    </g>
  )
}

export function SimpleScene() {
  const { state, currentStep, live } = useProcess()
  // how much the type grows against the drawing's scale
  const svgRef = useRef<SVGSVGElement>(null)
  const [k, setK] = useState(1)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const ro = new ResizeObserver(() => {
      const scale = svg.getBoundingClientRect().width / W
      setK(scale > 0 ? Math.min(1.8, Math.max(1, 1 / scale)) : 1)
    })
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])
  const steps = simpleFlow.steps
  const at = state.cursor.step
  // typed lines of each step: whole steps behind the cursor, none ahead of it
  const typed = (i: number) => {
    const step = steps[i]
    if (!step) return 0
    const n = stepLines(step, state.flow, state.agent).length
    if (i < at) return n
    if (i > at) return 0
    const { full, partial } = shownAt(n, state.cursor.progress)
    return full + partial
  }
  const P = typed(0) // Planning: 7 lines
  const E = typed(1) // Executing: 9 lines of the loop, then 2 of closure
  const I = typed(2) // Self-improvement: 4 lines

  // Planning: #1000 opens a slot at the top of the list, then writes in
  const open = progressBetween(P, 5, 5.5)
  const write = progressBetween(P, 5.5, 6.6)
  const meta = progressBetween(P, 6.6, 7)
  // Executing: the row lifts onto the lane; each stop lights on its line
  const lift = progressBetween(E, 0, 1)
  const lane = [
    progressBetween(E, 0.3, 1),
    progressBetween(E, 1, 3),
    progressBetween(E, 3, 4),
    progressBetween(E, 4, 5),
    progressBetween(E, 5, 6),
    progressBetween(E, 6, 7)
  ] as const
  const stop = (line: number) => progressBetween(E, line - 0.4, line)
  const merged = progressBetween(E, 6.6, 7)
  // closure: back into the list, Done
  const back = progressBetween(E, 9, 10)
  const done = progressBetween(E, 9.3, 10)
  // Self-improvement: the lane gives way to the report; #1001 writes into the list
  const report = progressBetween(I, 0, 0.6)
  const tile = (n: number) => progressBetween(I, 0.3 + 0.2 * n, 0.7 + 0.2 * n)
  const finding = progressBetween(I, 1, 2)
  const next = progressBetween(I, 3, 3.5)
  const nextWrite = progressBetween(I, 3.5, 4)

  const panelY = lerp(PANEL_MID, PANEL_LOW, lift)
  const laneOpacity = (1 - 0.6 * back) * (1 - report)
  const rowY = (slot: number) => panelY + HEAD + ROW * slot + 8
  // the slots: #1001 (once opened), #1000 (once opened), then the rest
  const slot1000 = next
  const slotOthers = next + open

  // #1000: in its slot, or lifted above the lane
  const out = lift * (1 - back)
  const r = {
    x: lerp(PANEL.x + 12, LIFTED.x, out),
    y: lerp(rowY(slot1000), LIFTED.y, out),
    w: lerp(PANEL.w - 24, LIFTED.w + 200 * (k - 1), out),
    h: lerp(ROW - 16, LIFTED.h, out)
  }
  const status = done > 0.5 ? 'DONE' : lift > 0 ? 'RUNNING' : 'TODO'
  const tracker = trackerLabel[state.env.tracker]
  const records = live.log.length
  const ticks = Math.min(records, 40)

  return (
    <div className='grid min-h-0 flex-1 place-items-center'>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role='img'
        aria-label={`${tracker} backlog: Issue #${ISSUE}, ${TITLE}, ${status.toLowerCase()}`}
        className='block h-auto max-h-full w-full'
        data-step={currentStep.stage}
      >
        {/* ── the lane: main, the branch off it, its stops, the merge ── */}
        <g opacity={laneOpacity * (lift > 0 ? 1 : 0)}>
          <line x1={24} y1={RAIL} x2={696} y2={RAIL} className='stroke-muted-foreground' strokeOpacity={0.6} />
          <text fontSize={labelPx(k)} x={24} y={RAIL + 10 + labelPx(k)} className={`${LABEL} fill-muted-foreground`}>
            MAIN
          </text>
          <text
            fontSize={labelPx(k)}
            x={100}
            y={LANE - 26 - 20 * k}
            className={`${LABEL} fill-muted-foreground`}
            opacity={lane[0]}
          >
            {`TASK/ISSUE-${ISSUE}`}
          </text>
          <line
            x1={80}
            y1={LIFTED.y + LIFTED.h}
            x2={80}
            y2={LANE - 12}
            className='stroke-foreground'
            strokeOpacity={0.4}
            strokeDasharray='2 4'
            opacity={lift}
          />
          <g className='stroke-primary' strokeWidth={2}>
            <Stroke d={`M80 ${RAIL} V${LANE + 20} Q80 ${LANE} 100 ${LANE} H160`} f={lane[0]} />
            <Stroke d={`M160 ${LANE} H240`} f={lane[1]} />
            <Stroke d={`M240 ${LANE} H320`} f={lane[2]} />
            <Stroke d={`M320 ${LANE} H400`} f={lane[3]} />
          </g>
          <g className='stroke-primary' strokeWidth={1.5}>
            <Stroke
              d={`M400 ${LANE} H440 C464 ${LANE} 464 ${LANE - 40} 488 ${LANE - 40} H512 C536 ${LANE - 40} 536 ${LANE} 560 ${LANE}`}
              f={lane[4]}
            />
            <Stroke
              d={`M400 ${LANE} H440 C464 ${LANE} 464 ${LANE + 40} 488 ${LANE + 40} H512 C536 ${LANE + 40} 536 ${LANE} 560 ${LANE}`}
              f={lane[4]}
            />
          </g>
          <Stroke
            d={`M560 ${LANE} H620 Q640 ${LANE} 640 ${LANE + 20} V${RAIL}`}
            f={lane[5]}
            className='stroke-primary [stroke-width:2]'
          />
          <Stop x={160} y={LANE} f={stop(1)} k={k} label='SANDBOX' />
          <Stop x={240} y={LANE} f={stop(3)} k={k} label='HOOKS' below />
          <Stop x={320} y={LANE} f={stop(4)} k={k} label='PR' />
          <Stop x={400} y={LANE} f={stop(5)} k={k} label='CI 38' below />
          <Stop x={500} y={LANE - 40} f={stop(6)} k={k} label='REVIEWER · APPROVE' />
          <Stop x={500} y={LANE + 40} f={stop(6)} k={k} label='REVIEWER · APPROVE' below />
          <g opacity={merged}>
            <circle cx={640} cy={RAIL} r={6} className='fill-success' />
            <rect x={604} y={96} width={92} height={28} className='fill-background stroke-success' />
            <text
              fontSize={Math.max(LABEL_MIN, 12 * k)}
              x={650}
              y={mid(96, 28, 12, k)}
              textAnchor='middle'
              className='fill-success font-mono'
            >
              Merged
            </text>
            <text
              fontSize={labelPx(k)}
              x={630}
              y={RAIL + 10 + labelPx(k)}
              textAnchor='end'
              className={`${LABEL} fill-success`}
            >
              {`#${ISSUE} → MAIN`}
            </text>
          </g>
        </g>

        {/* ── the report, in the lane's place ── */}
        <g opacity={report}>
          <rect x={24} y={16} width={672} height={256} className='fill-card stroke-foreground' strokeOpacity={0.6} />
          <text fontSize={labelPx(k)} x={44} y={46} className={`${LABEL} fill-muted-foreground`}>
            {`REPORT · #${ISSUE}`}
          </text>
          <text fontSize={18 * k} x={44} y={76} className='fill-foreground font-sans'>
            {TITLE}
          </text>
          {STATS.map((st, n) => (
            <g key={st.label} opacity={tile(n)} transform={`translate(${44 + 216 * n} ${96 + 8 * (1 - tile(n))})`}>
              <rect width={200} height={100} className='fill-background stroke-border' />
              <text fontSize={28 * k} x={16} y={46} className='fill-foreground font-sans tracking-tight'>
                {st.value}
              </text>
              {/* one line at full scale; shown smaller, the label wraps instead of shrinking */}
              <text fontSize={labelPx(k)} x={16} y={k > 1.25 ? 68 : 78} className={`${LABEL} fill-muted-foreground`}>
                {(k > 1.25 ? halves(st.label.toUpperCase()) : [st.label.toUpperCase()]).map((line, l) => (
                  <tspan key={line} x={16} dy={l ? 1.2 * labelPx(k) : 0}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          ))}
          <g opacity={finding}>
            <line x1={44} y1={208} x2={676} y2={208} className='stroke-border' />
            <text fontSize={labelPx(k)} x={44} y={232} className={`${LABEL} fill-muted-foreground`}>
              THE IMPROVER FOUND
            </text>
            <text fontSize={13 * k} x={44} y={256} className={`${ROW_TEXT} fill-foreground`}>
              resume has no test for a run left half-way
            </text>
          </g>
        </g>

        {/* ── the backlog: always on screen ── */}
        <clipPath id='simple-backlog'>
          <rect x={PANEL.x} y={panelY} width={PANEL.w} height={PANEL.h} />
        </clipPath>
        <rect
          x={PANEL.x}
          y={panelY}
          width={PANEL.w}
          height={PANEL.h}
          className='fill-card stroke-foreground'
          strokeOpacity={0.6}
        />
        <line x1={PANEL.x} y1={panelY + HEAD} x2={PANEL.x + PANEL.w} y2={panelY + HEAD} className='stroke-border' />
        <g transform={`translate(40 ${panelY + 12}) scale(0.833)`}>
          <path d={brandPath(state.env.tracker)} className='fill-foreground' />
        </g>
        <text fontSize={13 * k} x={68} y={panelY + 27} className='fill-foreground font-mono'>
          {`${tracker}  /  Backlog`}
        </text>
        <g opacity={ticks ? 1 : 0}>
          <text
            fontSize={labelPx(k)}
            x={PANEL.x + PANEL.w - 16}
            y={panelY + 27}
            textAnchor='end'
            className={`${LABEL} fill-muted-foreground`}
          >
            {`LOG · ${records}`}
          </text>
          {Array.from({ length: ticks }, (_, i) => (
            <rect
              key={i}
              x={PANEL.x + PANEL.w - 28 - 0.72 * labelPx(k) * `LOG · ${records}`.length - 5 * (ticks - i)}
              y={panelY + 16}
              width={2}
              height={14}
              className={i === ticks - 1 ? 'fill-foreground' : 'fill-muted-foreground'}
              opacity={i === ticks - 1 ? 1 : 0.5}
            />
          ))}
        </g>

        <g clipPath='url(#simple-backlog)'>
          {/* #1001, from the Log */}
          <g opacity={next}>
            <rect
              x={PANEL.x + 12}
              y={rowY(0)}
              width={PANEL.w - 24}
              height={ROW - 16}
              className='fill-background stroke-foreground'
            />
            <text
              fontSize={13 * k}
              x={PANEL.x + 28}
              y={mid(rowY(0), ROW - 16, 13, k)}
              className={`${ROW_TEXT} fill-foreground`}
            >
              {`#${NEXT.issue}  ${typeOut(NEXT.title, nextWrite)}`}
            </text>
            <text
              fontSize={labelPx(k)}
              x={PANEL.x + PANEL.w - 28}
              y={mid(rowY(0), ROW - 16, labelPx(k), 1)}
              textAnchor='end'
              className={`${LABEL} fill-muted-foreground`}
              opacity={k > 1.25 ? 0 : 1}
            >
              FROM THE LOG
            </text>
          </g>
          {/* #1000's place, kept while it is out */}
          <rect
            x={PANEL.x + 12}
            y={rowY(slot1000)}
            width={PANEL.w - 24}
            height={ROW - 16}
            fill='none'
            className='stroke-border'
            strokeDasharray='3 4'
            opacity={out}
          />
          {OTHERS.map((title, j) => (
            <g key={title} opacity={0.45 * (j === OTHERS.length - 1 ? 1 - next : 1)}>
              <line
                x1={PANEL.x + 12}
                y1={rowY(slotOthers + j) - 8}
                x2={PANEL.x + PANEL.w - 12}
                y2={rowY(slotOthers + j) - 8}
                className='stroke-border'
              />
              <text
                fontSize={13 * k}
                x={PANEL.x + 28}
                y={mid(rowY(slotOthers + j), ROW - 16, 13, k)}
                className={`${ROW_TEXT} fill-muted-foreground`}
              >
                {`#${String(ISSUE - 6 - 6 * j).padStart(4, '0')}  ${title}`}
              </text>
              <text
                fontSize={labelPx(k)}
                x={PANEL.x + PANEL.w - 28}
                y={mid(rowY(slotOthers + j), ROW - 16, labelPx(k), 1)}
                textAnchor='end'
                className={`${LABEL} fill-muted-foreground`}
              >
                TODO
              </text>
            </g>
          ))}
        </g>

        {/* #1000 itself, drawn last: it leaves the list */}
        <g opacity={open}>
          <rect
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            className={done > 0.5 ? 'fill-background stroke-success' : 'fill-background stroke-foreground'}
          />
          <text
            fontSize={13 * k}
            x={r.x + 16}
            y={mid(r.y, r.h, 13, k)}
            className={`${ROW_TEXT} ${done > 0.5 ? 'fill-muted-foreground line-through' : 'fill-foreground'}`}
          >
            {`#${ISSUE}  ${typeOut(TITLE, write)}`}
          </text>
          <g opacity={meta * (1 - out) * (k > 1.25 ? 0 : 1)}>
            <rect x={r.x + r.w - 220} y={r.y + 7} width={96} height={18} fill='none' className='stroke-border' />
            <text
              fontSize={labelPx(k)}
              x={r.x + r.w - 172}
              y={r.y + 20}
              textAnchor='middle'
              className={`${LABEL} fill-muted-foreground`}
            >
              {FILE}
            </text>
          </g>
          <text
            fontSize={labelPx(k)}
            x={r.x + r.w - 16}
            y={mid(r.y, r.h, labelPx(k), 1)}
            textAnchor='end'
            className={`${LABEL} ${done > 0.5 ? 'fill-success' : 'fill-muted-foreground'}`}
          >
            {status}
          </text>
        </g>
      </svg>
    </div>
  )
}
