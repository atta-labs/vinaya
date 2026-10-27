'use client'

import { motion } from 'motion/react'
import { useId } from 'react'
import { cn } from '@/ui/lib/utils'
import { AgentFrame, type AgentRole, AgentSign } from './agents'
import { Glyph, LINE, MARK } from './glyph'
import { type IconProps, SIGNATURE, useIconStill } from './icon-motion'

const LONG_FLOW: AgentRole[] = [
  'architect',
  'planner',
  'developer',
  'security-reviewer',
  'reviewer',
  'archivist',
  'tranche-archivist'
]
const SHORT_FLOW: AgentRole[] = ['planner', 'operator', 'tranche-archivist']

// Each flow's holds and moves are independent from its crossfade in the shared cycle.
const longTimes = [
  0, 0.04688, 0.075, 0.11562, 0.14375, 0.18438, 0.2125, 0.25313, 0.28125, 0.32188, 0.35, 0.39063, 0.41875, 0.45938, 1
]
const longX = [0, 0, -45, -45, -90, -90, -135, -135, -180, -180, -225, -225, -270, -270, -270]
const shortTimes = [0, 0.64688, 0.69375, 0.72188, 0.7625, 0.79062, 0.83125, 1]
const shortX = [0, 0, 0, -45, -45, -90, -90, -90]

function Flow({ short = false }: { short?: boolean }) {
  return (
    <motion.g
      initial={{ x: 0, opacity: short ? 0 : 1 }}
      animate={{ x: short ? shortX : longX, opacity: short ? [0, 0, 1, 1, 0] : [1, 1, 0, 0, 1] }}
      transition={{
        // Each slide eases in, speeds up and stops short, like every other icon's move.
        x: { duration: 32, repeat: Number.POSITIVE_INFINITY, ease: SIGNATURE, times: short ? shortTimes : longTimes },
        opacity: {
          duration: 32,
          repeat: Number.POSITIVE_INFINITY,
          ease: 'linear',
          times: short ? [0, 0.64688, 0.65938, 0.9875, 1] : [0, 0.63438, 0.64688, 0.9875, 1]
        }
      }}
    >
      {(short ? SHORT_FLOW : LONG_FLOW).map((role, index) => (
        <g key={role} transform={`translate(${index * 45} 0)`}>
          <AgentSign role={role} monochrome paused />
        </g>
      ))}
    </motion.g>
  )
}

function hexagon(x: number, radius: number) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((index * 60 - 90) * Math.PI) / 180
    return `${x + radius * Math.cos(angle)},${33 + radius * Math.sin(angle)}`
  }).join(' ')
}

export function VinayaProcessIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  const clip = useId()
  return (
    <Glyph className={cn('overflow-hidden', className)} viewBox='1.037 1.037 53.926 53.926'>
      <defs>
        <clipPath id={clip}>
          <polygon points={hexagon(28, 20)} />
        </clipPath>
      </defs>
      <polygon {...LINE} points={hexagon(-17, 21)} />
      <polygon {...LINE} points={hexagon(73, 21)} />
      <path {...MARK} d='M2.59 33H8.41M47.59 33H53.41' />
      <AgentFrame paused={paused} />
      <g clipPath={`url(#${clip})`}>
        {paused ? (
          <AgentSign role='architect' monochrome paused />
        ) : (
          <>
            <Flow />
            <Flow short />
          </>
        )}
      </g>
    </Glyph>
  )
}
