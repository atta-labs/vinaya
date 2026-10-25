'use client'

import { motion } from 'motion/react'
import { Glyph, LINE, MARK, DOT } from './glyph'
import { iconMotion, useIconStill, type IconProps } from './icon-motion'

export function LogIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='4.572 1.493 14.856 19.935'>
      <path {...LINE} d='M5 4H19V21H5Z' />
      <path {...LINE} d='M8.5 11H15.5M8.5 14.5H15.5' />
      <g>
        <motion.path
          key={paused ? 'still-1' : 'moving-1'}
          {...MARK}
          pathLength='1'
          d='M8.5 18H12.5'
          {...iconMotion('mv-draw', paused)}
          strokeDasharray={paused ? undefined : 1}
        />
      </g>
      <path
        {...LINE}
        className='fill-background'
        d='M13.20 6.07 L10.80 6.07 L9.60 4.00 L10.80 1.92 L13.20 1.92 L14.40 4.00Z'
      />
      <path {...LINE} d='M10.68 4.00L13.32 4.00' />
    </Glyph>
  )
}

export function TelemetryIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='2.571 3.8 18.857 17.735'>
      <path {...LINE} d='M3 21H21M6 21V15M10.5 21V11M15 21V13' />
      <motion.g
        key={paused ? 'still-2' : 'moving-2'}
        className='origin-bottom! [transform-box:fill-box]!'
        {...iconMotion('mv-grow', paused)}
      >
        <path {...MARK} d='M19 21V9.2' />
      </motion.g>
      <motion.g key={paused ? 'still-3' : 'moving-3'} {...iconMotion('mv-rise', paused)}>
        <path {...DOT} d='M19.00 3.80 L21.07 5.00 L21.07 7.40 L19.00 8.60 L16.92 7.40 L16.92 5.00Z' />
      </motion.g>
    </Glyph>
  )
}

export function StudioIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='2.071 3.071 19.857 18.357'>
      <path {...LINE} d='M2.5 3.5H21.5V17H2.5ZM9 21H15M12 17V21' />
      <path {...LINE} d='M5 7.8H19M5 12.8H19' />
      <motion.g key={paused ? 'still-4' : 'moving-4'} {...iconMotion('mv-seq', paused, 0)}>
        <path
          {...LINE}
          className='fill-background'
          d='M6.50 6.45 L7.66 7.12 L7.66 8.47 L6.50 9.15 L5.33 8.47 L5.33 7.12Z'
        />
      </motion.g>
      <motion.g key={paused ? 'still-5' : 'moving-5'} {...iconMotion('mv-seq', paused, 0.5)}>
        <path
          {...LINE}
          className='fill-background'
          d='M11.00 6.45 L12.16 7.12 L12.16 8.47 L11.00 9.15 L9.83 8.47 L9.83 7.12Z'
        />
      </motion.g>
      <motion.g key={paused ? 'still-6' : 'moving-6'} {...iconMotion('mv-seq', paused, 1.0)}>
        <path
          {...LINE}
          className='fill-background'
          d='M15.50 6.45 L16.66 7.12 L16.66 8.47 L15.50 9.15 L14.33 8.47 L14.33 7.12Z'
        />
      </motion.g>
      <motion.g key={paused ? 'still-7' : 'moving-7'} {...iconMotion('mv-seq', paused, 0.25)}>
        <path
          {...LINE}
          className='fill-background'
          d='M6.50 11.45 L7.66 12.12 L7.66 13.47 L6.50 14.15 L5.33 13.47 L5.33 12.12Z'
        />
      </motion.g>
      <motion.g key={paused ? 'still-8' : 'moving-8'} {...iconMotion('mv-seq', paused, 0.75)}>
        <path
          {...LINE}
          className='fill-background'
          d='M11.00 11.45 L12.16 12.12 L12.16 13.47 L11.00 14.15 L9.83 13.47 L9.83 12.12Z'
        />
      </motion.g>
      <motion.g
        key={paused ? 'still-9' : 'moving-9'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('mv-new', paused, 1.25)}
      >
        <path {...DOT} d='M15.50 11.45 L16.66 12.12 L16.66 13.47 L15.50 14.15 L14.33 13.47 L14.33 12.12Z' />
      </motion.g>
    </Glyph>
  )
}

export function SelfImprovementIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.052 7.152 21.896 9.697'>
      <path {...LINE} d='M12 12L15.05 8.95A4.31 4.31 0 1 1 15.05 15.05L8.95 8.95A4.31 4.31 0 1 0 8.95 15.05L12 12' />
      <motion.path
        key={paused ? 'still-10' : 'moving-10'}
        {...MARK}
        pathLength='1'
        d='M12 12L15.05 8.95A4.31 4.31 0 1 1 15.05 15.05L8.95 8.95A4.31 4.31 0 1 0 8.95 15.05L12 12'
        {...iconMotion('mv-orbit', paused)}
        strokeDasharray={paused ? undefined : 1}
      />
      {/* Flat-top, corners pointing into the two loops: the hexagon shares the loop's own mirror axes, so all four
          strands meet it the same way. The screw line stands upright between its flat top and bottom. */}
      <path
        {...LINE}
        className='fill-background'
        d='M14.10 12.00 L13.05 13.81 L10.95 13.81 L9.90 12.00 L10.95 10.18 L13.05 10.18Z'
      />
      <path {...LINE} d='M12.00 13.15L12.00 10.84' />
    </Glyph>
  )
}

export function ConfigurationIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='2.571 3.972 18.857 15.280'>
      <path {...LINE} d='M3 7H21M3 17H21' />
      <path
        {...LINE}
        className='fill-background'
        d='M10.25 5.70 L10.25 8.30 L8.00 9.60 L5.74 8.30 L5.74 5.70 L8.00 4.40Z'
      />
      <path {...LINE} d='M8.00 8.43L8.00 5.57' />
      <motion.g key={paused ? 'still-11' : 'moving-11'} {...iconMotion('mv-slide', paused)}>
        <path {...DOT} d='M17.30 14.74 L18.60 17.00 L17.30 19.25 L14.70 19.25 L13.40 17.00 L14.70 14.74Z' />
      </motion.g>
    </Glyph>
  )
}
