'use client'

import { motion } from 'motion/react'
import { Glyph, LINE, MARK, DOT } from './glyph'
import { iconMotion, useIconStill, type IconProps } from './icon-motion'

export function VinayaHarnessIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='5.559 5.559 44.882 44.882'>
      <path {...LINE} d='M28 28L11 11' />
      <path {...LINE} d='M28 28L45 11' />
      <path {...LINE} d='M28 28L11 45' />
      <path {...LINE} d='M28 28L45 45' />
      <circle {...LINE} className='fill-background' cx='28' cy='28' r='8' />
      <motion.g
        key={paused ? 'still-1' : 'moving-1'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('a-nut', paused, 0.0)}
      >
        <path
          {...LINE}
          className='fill-background'
          d='M15.63 12.24 L12.24 15.63 L7.60 14.39 L6.36 9.75 L9.75 6.36 L14.39 7.60Z'
        />
        <path {...LINE} d='M9.13 12.86L12.86 9.13' />
      </motion.g>
      <motion.g
        key={paused ? 'still-2' : 'moving-2'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('a-nut', paused, 0.12)}
      >
        <path
          {...LINE}
          className='fill-background'
          d='M49.63 12.24 L46.24 15.63 L41.60 14.39 L40.36 9.75 L43.75 6.36 L48.39 7.60Z'
        />
        <path {...LINE} d='M43.13 9.13L46.86 12.86' />
      </motion.g>
      <motion.g
        key={paused ? 'still-3' : 'moving-3'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('a-nut', paused, 0.24)}
      >
        <path
          {...LINE}
          className='fill-background'
          d='M15.63 46.24 L12.24 49.63 L7.60 48.39 L6.36 43.75 L9.75 40.36 L14.39 41.60Z'
        />
        <path {...LINE} d='M12.86 46.86L9.13 43.13' />
      </motion.g>
      <motion.g
        key={paused ? 'still-4' : 'moving-4'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('a-nut', paused, 0.36)}
      >
        <path
          {...LINE}
          className='fill-background'
          d='M49.63 46.24 L46.24 49.63 L41.60 48.39 L40.36 43.75 L43.75 40.36 L48.39 41.60Z'
        />
        <path {...LINE} d='M46.86 43.13L43.13 46.86' />
      </motion.g>
      <motion.g
        key={paused ? 'still-5' : 'moving-5'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('a-pulse', paused)}
      >
        <circle {...DOT} cx='28' cy='28' r='3.6' />
      </motion.g>
    </Glyph>
  )
}

export function GetStartedIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='4.072 2.071 15.856 20.464'>
      <path
        {...LINE}
        d='M12 2.5C16 5 17.5 9 17 14L14.5 16.5H9.5L7 14C6.5 9 8 5 12 2.5ZM7 14L4.5 16.5V19L8.5 17.5M17 14L19.5 16.5V19L15.5 17.5'
      />
      <path
        {...LINE}
        className='fill-background'
        d='M13.15 11.49 L10.85 11.49 L9.70 9.50 L10.85 7.50 L13.15 7.50 L14.30 9.50Z'
      />
      <path {...LINE} d='M10.73 9.50L13.26 9.50' />
      <motion.g
        key={paused ? 'still-6' : 'moving-6'}
        className='origin-top! [transform-box:fill-box]!'
        {...iconMotion('mv-flame', paused)}
      >
        <path {...MARK} d='M12 19.5V22' />
      </motion.g>
    </Glyph>
  )
}

export function FeaturesIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.208 0 21.584 21.900'>
      <path {...LINE} d='M6.80 0.40 L12.00 3.40 L12.00 9.40 L6.80 12.40 L1.60 9.40 L1.60 3.40Z' />
      <path {...LINE} d='M17.19 0.40 L22.39 3.40 L22.39 9.40 L17.19 12.40 L12.00 9.40 L12.00 3.40Z' />
      <path {...MARK} d='M12.00 9.40 L17.19 12.40 L17.19 18.40 L12.00 21.40 L6.80 18.40 L6.80 12.40Z' />
      {/* Still (small, or reduced motion), the feature signs are too fine to read: each hexagon holds one dot instead, a feature in
          every slot, which also keeps it apart from Parts' empty hexagons. */}
      {paused ? (
        <>
          <circle fill='currentColor' stroke='none' cx='6.80' cy='6.40' r='1.8' />
          <circle fill='currentColor' stroke='none' cx='17.19' cy='6.40' r='1.8' />
          <circle {...DOT} cx='12.00' cy='15.40' r='1.8' />
        </>
      ) : null}
      {paused ? null : (
        <>
          <motion.g key={paused ? 'still-7' : 'moving-7'} opacity={1} {...iconMotion('fsig', paused, -0.0, 10.0)}>
            <g transform='translate(2.724 2.320) scale(0.34)'>
              <path {...LINE} d='M5 4H19V21H5Z' strokeWidth='1.82' />
              <path {...LINE} d='M8.5 11H15.5M8.5 14.5H15.5' strokeWidth='1.82' />
              <path {...LINE} d='M8.5 18H12.5' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M13.20 6.07 L10.80 6.07 L9.60 4.00 L10.80 1.92 L13.20 1.92 L14.40 4.00Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M10.68 4.00L13.32 4.00' strokeWidth='1.82' />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-8' : 'moving-8'} opacity={0} {...iconMotion('fsig', paused, -2.0, 10.0)}>
            <g transform='translate(2.724 2.320) scale(0.34)'>
              <path {...LINE} d='M3 21H21M6 21V15M10.5 21V11M15 21V13' strokeWidth='1.82' />
              <path {...LINE} d='M19 21V9.2' strokeWidth='1.82' />
              <path
                fill='currentColor'
                stroke='none'
                d='M19.00 3.80 L21.07 5.00 L21.07 7.40 L19.00 8.60 L16.92 7.40 L16.92 5.00Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-9' : 'moving-9'} opacity={0} {...iconMotion('fsig', paused, -4.0, 10.0)}>
            <g transform='translate(2.724 2.320) scale(0.34)'>
              <path {...LINE} d='M2.5 3.5H21.5V17H2.5ZM9 21H15M12 17V21' strokeWidth='1.82' />
              <path {...LINE} d='M5 7.8H19M5 12.8H19' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M6.50 6.45 L7.66 7.12 L7.66 8.47 L6.50 9.15 L5.33 8.47 L5.33 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M11.00 6.45 L12.16 7.12 L12.16 8.47 L11.00 9.15 L9.83 8.47 L9.83 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M15.50 6.45 L16.66 7.12 L16.66 8.47 L15.50 9.15 L14.33 8.47 L14.33 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M6.50 11.45 L7.66 12.12 L7.66 13.47 L6.50 14.15 L5.33 13.47 L5.33 12.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M11.00 11.45 L12.16 12.12 L12.16 13.47 L11.00 14.15 L9.83 13.47 L9.83 12.12Z'
                strokeWidth='1.82'
              />
              <path
                fill='currentColor'
                stroke='none'
                d='M15.50 11.45 L16.66 12.12 L16.66 13.47 L15.50 14.15 L14.33 13.47 L14.33 12.12Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-10' : 'moving-10'} opacity={0} {...iconMotion('fsig', paused, -6.0, 10.0)}>
            <g transform='translate(2.724 2.320) scale(0.34)'>
              <path
                {...LINE}
                d='M15.05 8.95A4.31 4.31 0 1 1 15.05 15.05L8.95 8.95A4.31 4.31 0 1 0 8.95 15.05Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M13.81 10.95 L13.81 13.05 L12.00 14.10 L10.18 13.05 L10.18 10.95 L12.00 9.90Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M12.00 13.15L12.00 10.84' strokeWidth='1.82' />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-11' : 'moving-11'} opacity={0} {...iconMotion('fsig', paused, -8.0, 10.0)}>
            <g transform='translate(2.724 2.320) scale(0.34)'>
              <path {...LINE} d='M3 7H21M3 17H21' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M10.25 5.70 L10.25 8.30 L8.00 9.60 L5.74 8.30 L5.74 5.70 L8.00 4.40Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M8.00 8.43L8.00 5.57' strokeWidth='1.82' />
              <path
                fill='currentColor'
                stroke='none'
                d='M17.30 14.74 L18.60 17.00 L17.30 19.25 L14.70 19.25 L13.40 17.00 L14.70 14.74Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-12' : 'moving-12'} opacity={1} {...iconMotion('fsig', paused, -0.7, 11.5)}>
            <g transform='translate(13.116 2.320) scale(0.34)'>
              <path {...LINE} d='M2.5 3.5H21.5V17H2.5ZM9 21H15M12 17V21' strokeWidth='1.82' />
              <path {...LINE} d='M5 7.8H19M5 12.8H19' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M6.50 6.45 L7.66 7.12 L7.66 8.47 L6.50 9.15 L5.33 8.47 L5.33 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M11.00 6.45 L12.16 7.12 L12.16 8.47 L11.00 9.15 L9.83 8.47 L9.83 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M15.50 6.45 L16.66 7.12 L16.66 8.47 L15.50 9.15 L14.33 8.47 L14.33 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M6.50 11.45 L7.66 12.12 L7.66 13.47 L6.50 14.15 L5.33 13.47 L5.33 12.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M11.00 11.45 L12.16 12.12 L12.16 13.47 L11.00 14.15 L9.83 13.47 L9.83 12.12Z'
                strokeWidth='1.82'
              />
              <path
                fill='currentColor'
                stroke='none'
                d='M15.50 11.45 L16.66 12.12 L16.66 13.47 L15.50 14.15 L14.33 13.47 L14.33 12.12Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-13' : 'moving-13'} opacity={0} {...iconMotion('fsig', paused, -3.0, 11.5)}>
            <g transform='translate(13.116 2.320) scale(0.34)'>
              <path
                {...LINE}
                d='M15.05 8.95A4.31 4.31 0 1 1 15.05 15.05L8.95 8.95A4.31 4.31 0 1 0 8.95 15.05Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M13.81 10.95 L13.81 13.05 L12.00 14.10 L10.18 13.05 L10.18 10.95 L12.00 9.90Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M12.00 13.15L12.00 10.84' strokeWidth='1.82' />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-14' : 'moving-14'} opacity={0} {...iconMotion('fsig', paused, -5.3, 11.5)}>
            <g transform='translate(13.116 2.320) scale(0.34)'>
              <path {...LINE} d='M3 7H21M3 17H21' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M10.25 5.70 L10.25 8.30 L8.00 9.60 L5.74 8.30 L5.74 5.70 L8.00 4.40Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M8.00 8.43L8.00 5.57' strokeWidth='1.82' />
              <path
                fill='currentColor'
                stroke='none'
                d='M17.30 14.74 L18.60 17.00 L17.30 19.25 L14.70 19.25 L13.40 17.00 L14.70 14.74Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-15' : 'moving-15'} opacity={0} {...iconMotion('fsig', paused, -7.6, 11.5)}>
            <g transform='translate(13.116 2.320) scale(0.34)'>
              <path {...LINE} d='M5 4H19V21H5Z' strokeWidth='1.82' />
              <path {...LINE} d='M8.5 11H15.5M8.5 14.5H15.5' strokeWidth='1.82' />
              <path {...LINE} d='M8.5 18H12.5' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M13.20 6.07 L10.80 6.07 L9.60 4.00 L10.80 1.92 L13.20 1.92 L14.40 4.00Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M10.68 4.00L13.32 4.00' strokeWidth='1.82' />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-16' : 'moving-16'} opacity={0} {...iconMotion('fsig', paused, -9.9, 11.5)}>
            <g transform='translate(13.116 2.320) scale(0.34)'>
              <path {...LINE} d='M3 21H21M6 21V15M10.5 21V11M15 21V13' strokeWidth='1.82' />
              <path {...LINE} d='M19 21V9.2' strokeWidth='1.82' />
              <path
                fill='currentColor'
                stroke='none'
                d='M19.00 3.80 L21.07 5.00 L21.07 7.40 L19.00 8.60 L16.92 7.40 L16.92 5.00Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-17' : 'moving-17'} opacity={1} {...iconMotion('fsig', paused, -1.4, 13.0)}>
            <g transform='translate(7.920 11.320) scale(0.34)'>
              <path {...LINE} d='M3 7H21M3 17H21' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M10.25 5.70 L10.25 8.30 L8.00 9.60 L5.74 8.30 L5.74 5.70 L8.00 4.40Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M8.00 8.43L8.00 5.57' strokeWidth='1.82' />
              <path
                fill='currentColor'
                stroke='none'
                d='M17.30 14.74 L18.60 17.00 L17.30 19.25 L14.70 19.25 L13.40 17.00 L14.70 14.74Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-18' : 'moving-18'} opacity={0} {...iconMotion('fsig', paused, -4.0, 13.0)}>
            <g transform='translate(7.920 11.320) scale(0.34)'>
              <path {...LINE} d='M5 4H19V21H5Z' strokeWidth='1.82' />
              <path {...LINE} d='M8.5 11H15.5M8.5 14.5H15.5' strokeWidth='1.82' />
              <path {...LINE} d='M8.5 18H12.5' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M13.20 6.07 L10.80 6.07 L9.60 4.00 L10.80 1.92 L13.20 1.92 L14.40 4.00Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M10.68 4.00L13.32 4.00' strokeWidth='1.82' />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-19' : 'moving-19'} opacity={0} {...iconMotion('fsig', paused, -6.6, 13.0)}>
            <g transform='translate(7.920 11.320) scale(0.34)'>
              <path {...LINE} d='M3 21H21M6 21V15M10.5 21V11M15 21V13' strokeWidth='1.82' />
              <path {...LINE} d='M19 21V9.2' strokeWidth='1.82' />
              <path
                fill='currentColor'
                stroke='none'
                d='M19.00 3.80 L21.07 5.00 L21.07 7.40 L19.00 8.60 L16.92 7.40 L16.92 5.00Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-20' : 'moving-20'} opacity={0} {...iconMotion('fsig', paused, -9.2, 13.0)}>
            <g transform='translate(7.920 11.320) scale(0.34)'>
              <path {...LINE} d='M2.5 3.5H21.5V17H2.5ZM9 21H15M12 17V21' strokeWidth='1.82' />
              <path {...LINE} d='M5 7.8H19M5 12.8H19' strokeWidth='1.82' />
              <path
                {...LINE}
                d='M6.50 6.45 L7.66 7.12 L7.66 8.47 L6.50 9.15 L5.33 8.47 L5.33 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M11.00 6.45 L12.16 7.12 L12.16 8.47 L11.00 9.15 L9.83 8.47 L9.83 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M15.50 6.45 L16.66 7.12 L16.66 8.47 L15.50 9.15 L14.33 8.47 L14.33 7.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M6.50 11.45 L7.66 12.12 L7.66 13.47 L6.50 14.15 L5.33 13.47 L5.33 12.12Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M11.00 11.45 L12.16 12.12 L12.16 13.47 L11.00 14.15 L9.83 13.47 L9.83 12.12Z'
                strokeWidth='1.82'
              />
              <path
                fill='currentColor'
                stroke='none'
                d='M15.50 11.45 L16.66 12.12 L16.66 13.47 L15.50 14.15 L14.33 13.47 L14.33 12.12Z'
              />
            </g>
          </motion.g>
          <motion.g key={paused ? 'still-21' : 'moving-21'} opacity={0} {...iconMotion('fsig', paused, -11.8, 13.0)}>
            <g transform='translate(7.920 11.320) scale(0.34)'>
              <path
                {...LINE}
                d='M15.05 8.95A4.31 4.31 0 1 1 15.05 15.05L8.95 8.95A4.31 4.31 0 1 0 8.95 15.05Z'
                strokeWidth='1.82'
              />
              <path
                {...LINE}
                d='M13.81 10.95 L13.81 13.05 L12.00 14.10 L10.18 13.05 L10.18 10.95 L12.00 9.90Z'
                strokeWidth='1.82'
              />
              <path {...LINE} d='M12.00 13.15L12.00 10.84' strokeWidth='1.82' />
            </g>
          </motion.g>
        </>
      )}
    </Glyph>
  )
}

export function DevProcessIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='4.666 1.371 14.412 21.258'>
      <path {...LINE} d='M7 6.2V17.8' />
      <g>
        <motion.path
          key={paused ? 'still-22' : 'moving-22'}
          {...LINE}
          pathLength='1'
          d='M7 9.5C7 13 17 11 17 15V15.4'
          {...iconMotion('mv-branch', paused)}
          strokeDasharray={paused ? undefined : 1}
        />
      </g>
      <path
        {...LINE}
        className='fill-background'
        d='M7.00 1.80 L8.90 2.90 L8.90 5.10 L7.00 6.20 L5.09 5.10 L5.09 2.90Z'
      />
      <path
        {...LINE}
        className='fill-background'
        d='M7.00 17.80 L8.90 18.90 L8.90 21.10 L7.00 22.20 L5.09 21.10 L5.09 18.90Z'
      />
      <motion.g
        key={paused ? 'still-23' : 'moving-23'}
        className='origin-center! [transform-box:fill-box]!'
        {...iconMotion('mv-branch-head', paused)}
      >
        <path {...DOT} d='M17.00 15.40 L19.07 16.60 L19.07 19.00 L17.00 20.20 L14.92 19.00 L14.92 16.60Z' />
      </motion.g>
    </Glyph>
  )
}

export function CliIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='2.071 3.571 19.857 16.857'>
      <path {...LINE} d='M2.5 4H21.5V20H2.5ZM2.5 8.4H21.5' />
      <path {...DOT} d='M5.60 5.05 L6.59 5.62 L6.59 6.77 L5.60 7.35 L4.60 6.77 L4.60 5.62Z' />
      <path {...LINE} d='M8.90 5.05 L9.89 5.62 L9.89 6.77 L8.90 7.35 L7.90 6.77 L7.90 5.62Z' />
      <path {...LINE} d='M12.20 5.05 L13.19 5.62 L13.19 6.77 L12.20 7.35 L11.20 6.77 L11.20 5.62Z' />
      <path {...LINE} d='M6.5 11.8L9.6 14.4L6.5 17' />
      <motion.g key={paused ? 'still-24' : 'moving-24'} {...iconMotion('mv-blink', paused)}>
        <path {...LINE} d='M12 17H17' />
      </motion.g>
    </Glyph>
  )
}
