'use client'

import { motion } from 'motion/react'
import { Glyph, LINE, MARK, DOT } from './glyph'
import { iconMotion, useIconStill, type IconProps } from './icon-motion'

export function IntegrationIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='4.972 2.064 14.057 19.965'>
      <motion.g key={paused ? 'still-1' : 'moving-1'} {...iconMotion('mv-plug', paused)}>
        <path {...LINE} d='M18.60 12.60 L15.30 18.31 L8.70 18.31 L5.40 12.60 L8.70 6.88 L15.30 6.88Z' />
        <path {...MARK} d='M9.5 2.6V6.9M14.5 2.6V6.9' />
      </motion.g>
      <motion.g
        key={paused ? 'still-2' : 'moving-2'}
        className='origin-[12px_21.6px]! [transform-box:view-box]!'
        {...iconMotion('mv-cable', paused)}
      >
        <path {...LINE} d='M12 18.3V21.6' />
      </motion.g>
    </Glyph>
  )
}

export function ThinkingIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='5.054 2.071 13.892 18.858'>
      <path
        {...LINE}
        d='M12 2.5A6.5 6.5 0 0 0 7.6 13.8C8.6 14.8 9.2 15.8 9.2 17.2H14.8C14.8 15.8 15.4 14.8 16.4 13.8A6.5 6.5 0 0 0 12 2.5ZM9.6 20.5H14.4'
      />
      <motion.g
        key={paused ? 'still-3' : 'moving-3'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('mv-glow', paused)}
      >
        <path {...MARK} d='M12.00 7.00 L14.25 8.30 L14.25 10.90 L12.00 12.20 L9.74 10.90 L9.74 8.30Z' />
      </motion.g>
    </Glyph>
  )
}

export function ExecutingIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.917 1.917 20.166 20.166'>
      {/* A gear whose six teeth are hexagons set into its rim, turning slowly round its hub, the orange hexagon set in it like a nut on an axle: work running. */}
      <motion.g
        key={paused ? 'still-4' : 'moving-4'}
        className='origin-[12px_12px]! [transform-box:view-box]!'
        {...iconMotion('mv-gear', paused)}
      >
        <path
          {...LINE}
          d='M9.92 5.95 L9.92 3.55 L12.00 2.35 L14.08 3.55 L14.08 5.95 A6.4 6.4 0 0 1 16.20 7.17 L18.28 5.97 L20.36 7.17 L20.36 9.57 L18.28 10.77 A6.4 6.4 0 0 1 18.28 13.23 L20.36 14.43 L20.36 16.83 L18.28 18.03 L16.20 16.83 A6.4 6.4 0 0 1 14.08 18.05 L14.08 20.45 L12.00 21.65 L9.92 20.45 L9.92 18.05 A6.4 6.4 0 0 1 7.80 16.83 L5.72 18.03 L3.64 16.83 L3.64 14.43 L5.72 13.23 A6.4 6.4 0 0 1 5.72 10.77 L3.64 9.57 L3.64 7.17 L5.72 5.97 L7.80 7.17 A6.4 6.4 0 0 1 9.92 5.95Z'
        />
      </motion.g>
      <path {...MARK} d='M12.00 9.00 L14.59 10.50 L14.59 13.50 L12.00 15.00 L9.40 13.50 L9.40 10.50Z' />
    </Glyph>
  )
}

/* Retrospecting: a hexagonal lens over the work. Each beat the handle sits at another corner of the lens
   and the lens reads something else: approved, still thinking, rejected, thinking, concluded, thinking.
   Still (small, or reduced motion), it holds the first beat: the handle low right, an approval inside. */
const RETRO_BEATS: { handle: string; sign: 'approve' | 'think' | 'reject' | 'conclude' }[] = [
  { handle: 'M13.95 16.84L16.25 20.83', sign: 'approve' },
  { handle: 'M6.05 3.16L3.75 -0.83', sign: 'think' },
  { handle: 'M17.90 10.00L22.50 10.00', sign: 'reject' },
  { handle: 'M6.05 16.84L3.75 20.83', sign: 'think' },
  { handle: 'M13.95 3.16L16.25 -0.83', sign: 'conclude' },
  { handle: 'M2.10 10.00L-2.50 10.00', sign: 'think' }
]
const RETRO_BEAT_S = 2

/* One beat's visibility over the whole cycle: off, on for its own slot (with a short fade at each end), off. */
function beatMotion(i: number, paused: boolean) {
  if (paused) return { initial: false as const, animate: { opacity: i === 0 ? 1 : 0 } }
  const n = RETRO_BEATS.length
  const a = i / n
  const b = (i + 1) / n
  const f = 0.15 / n
  return {
    initial: { opacity: 0 },
    animate: { opacity: [0, 0, 1, 1, 0, 0] },
    transition: {
      duration: n * RETRO_BEAT_S,
      times: [0, a, a + f, b - f, b, 1],
      ease: 'linear' as const,
      repeat: Number.POSITIVE_INFINITY
    }
  }
}

function RetroSign({ sign }: { sign: (typeof RETRO_BEATS)[number]['sign'] }) {
  switch (sign) {
    case 'approve':
      return <path {...MARK} d='M7.2 10.2L9.2 12.2L12.9 8.3' />
    case 'reject':
      return <path {...MARK} d='M7.7 7.7L12.3 12.3M12.3 7.7L7.7 12.3' />
    case 'think':
      return (
        <>
          <circle {...DOT} cx='7' cy='10' r='0.95' />
          <circle {...DOT} cx='10' cy='10' r='0.95' />
          <circle {...DOT} cx='13' cy='10' r='0.95' />
        </>
      )
    case 'conclude':
      return <path {...DOT} d='M12.40 10.00 L11.20 12.08 L8.80 12.08 L7.60 10.00 L8.80 7.92 L11.20 7.92Z' />
  }
}

export function RetrospectingIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='-3.1 -1.43 26.2 22.86'>
      <path {...LINE} d='M17.20 10.00 L13.60 16.23 L6.40 16.23 L2.80 10.00 L6.40 3.76 L13.60 3.76Z' />
      {RETRO_BEATS.map((beat, i) => (
        <motion.g key={`${paused ? 'still' : 'moving'}-${beat.handle}`} {...beatMotion(i, paused)}>
          <path {...LINE} d={beat.handle} />
          <RetroSign sign={beat.sign} />
        </motion.g>
      ))}
    </Glyph>
  )
}

export function GatesIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='2.571 3.571 18.857 17.964'>
      <path {...LINE} d='M3 21V6H6V4H10V6H14V4H18V6H21V21' />
      <path {...LINE} d='M8 21V13.5L12 9.5L16 13.5V21' />
      <motion.g key={paused ? 'still-6' : 'moving-6'} {...iconMotion('mv-drop', paused)}>
        <path {...MARK} d='M10.2 12.2V21M12 10.6V21M13.8 12.2V21' />
      </motion.g>
    </Glyph>
  )
}

export function UsingItIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='4.572 2.371 14.856 19.058'>
      <motion.g
        key={paused ? 'still-7' : 'moving-7'}
        className='origin-[12px_2.8px]! [transform-box:view-box]!'
        {...iconMotion('mv-swing', paused)}
      >
        <path {...LINE} d='M5 6.5H19V21H5ZM10 6.5L12 2.8L14 6.5' />
        <path {...MARK} d='M12.00 9.00 L14.59 10.50 L14.59 13.50 L12.00 15.00 L9.40 13.50 L9.40 10.50Z' />
        <path {...LINE} d='M8.5 17.5H15.5' />
      </motion.g>
    </Glyph>
  )
}

export function GuidesIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='2.071 4.072 19.857 17.356'>
      <path
        {...LINE}
        d='M2.5 5C5.8 4 9 4.5 12 6.5C15 4.5 18.2 4 21.5 5V19.5C18.2 18.5 15 19 12 21C9 19 5.8 18.5 2.5 19.5ZM12 6.5V21'
      />
      <path {...MARK} d='M16.5 5V10.5' />
      <motion.g key={paused ? 'still-8' : 'moving-8'} {...iconMotion('mv-bob', paused)}>
        <path {...DOT} d='M16.50 10.40 L18.05 11.30 L18.05 13.10 L16.50 14.00 L14.94 13.10 L14.94 11.30Z' />
      </motion.g>
    </Glyph>
  )
}

export function ReferenceIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='4.072 2.571 15.856 18.857'>
      <path {...LINE} d='M4.5 3H19.5V21H4.5Z' />
      <motion.g key={paused ? 'still-9' : 'moving-9'} {...iconMotion('mv-step', paused)}>
        <path {...DOT} d='M8.20 6.70 L9.32 7.35 L9.32 8.65 L8.20 9.30 L7.07 8.65 L7.07 7.35Z' />
      </motion.g>
      <path {...LINE} d='M8.20 10.70 L9.32 11.35 L9.32 12.65 L8.20 13.30 L7.07 12.65 L7.07 11.35Z' />
      <path {...LINE} d='M8.20 14.70 L9.32 15.35 L9.32 16.65 L8.20 17.30 L7.07 16.65 L7.07 15.35Z' />
      <path {...LINE} d='M11 8H16.5M11 12H16.5M11 16H14.5' />
    </Glyph>
  )
}

export function PartsIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='-1.5 -2.55 27 27'>
      <path {...LINE} d='M6.80 0.40 L12.00 3.40 L12.00 9.40 L6.80 12.40 L1.60 9.40 L1.60 3.40Z' />
      <path {...LINE} d='M17.19 0.40 L22.39 3.40 L22.39 9.40 L17.19 12.40 L12.00 9.40 L12.00 3.40Z' />
      <motion.g key={paused ? 'still-10' : 'moving-10'} {...iconMotion('mv-snap', paused)}>
        <path {...MARK} d='M12.00 9.40 L17.19 12.40 L17.19 18.40 L12.00 21.40 L6.80 18.40 L6.80 12.40Z' />
      </motion.g>
    </Glyph>
  )
}
