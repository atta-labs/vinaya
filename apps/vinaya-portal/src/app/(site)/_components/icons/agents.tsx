'use client'

import { motion } from 'motion/react'
import { Glyph, GlyphStrokes, LINE, MARK, DOT } from './glyph'
import { iconMotion, useIconStill, type IconProps } from './icon-motion'

/** Shared frame for the agents and the process. */
export function AgentFrame({ paused }: { paused: boolean }) {
  return (
    <>
      <path {...LINE} d='M28.00 12.00 L46.18 22.50 L46.18 43.50 L28.00 54.00 L9.81 43.50 L9.81 22.50Z' />
      <motion.g
        className='origin-[19.816px_16.725px]! [transform-box:view-box]!'
        {...iconMotion('antL', paused)}
        key={paused ? 'still-1' : 'moving-1'}
      >
        <path {...LINE} d='M19.81 16.72L7.51 7.35' />
        <g className='origin-[4.944px_5.400px]! [transform-box:view-box]!'>
          <path
            {...LINE}
            className='fill-background'
            d='M4.94 2.00 L7.88 3.70 L7.88 7.10 L4.94 8.80 L2.00 7.10 L2.00 3.70Z'
          />
          <motion.g {...iconMotion('pupil', paused)} key={paused ? 'still-2' : 'moving-2'}>
            <circle fill='currentColor' stroke='none' cx='4.944' cy='5.400' r='1.25' />
          </motion.g>
        </g>
      </motion.g>
      <motion.g
        className='origin-[36.184px_16.725px]! [transform-box:view-box]!'
        {...iconMotion('antR', paused)}
        key={paused ? 'still-3' : 'moving-3'}
      >
        <path {...LINE} d='M36.18 16.72L48.48 7.35' />
        <motion.g
          className='origin-[51.056px_5.400px]! [transform-box:view-box]!'
          {...iconMotion('eyeR', paused)}
          key={paused ? 'still-4' : 'moving-4'}
        >
          <path
            {...LINE}
            className='fill-background'
            d='M51.05 2.00 L54.00 3.70 L54.00 7.10 L51.05 8.80 L48.11 7.10 L48.11 3.70Z'
          />
          <motion.g {...iconMotion('pupil', paused)} key={paused ? 'still-5' : 'moving-5'}>
            <circle fill='currentColor' stroke='none' cx='51.056' cy='5.400' r='1.25' />
          </motion.g>
        </motion.g>
      </motion.g>
    </>
  )
}

export type AgentRole =
  | 'architect'
  | 'planner'
  | 'developer'
  | 'reviewer'
  | 'security-reviewer'
  | 'operator'
  | 'archivist'
  | 'tranche-archivist'

export function AgentSign({
  role,
  monochrome = false,
  paused
}: {
  role: AgentRole
  monochrome?: boolean
  paused: boolean
}) {
  switch (role) {
    case 'architect':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <path {...LINE} d='M20 40V16' />
            <motion.g
              className='origin-left! [transform-box:fill-box]!'
              {...iconMotion('a-flag', paused)}
              key={paused ? 'still-6' : 'moving-6'}
            >
              <path {...(monochrome ? LINE : MARK)} d='M20 17H36L32 22.5L36 28H20' />
            </motion.g>
          </g>
        </GlyphStrokes>
      )
    case 'planner':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <motion.g
              className='origin-[27px_29px]! [transform-box:view-box]!'
              {...iconMotion('pl1', paused)}
              key={paused ? 'still-7' : 'moving-7'}
            >
              <path {...LINE} d='M24.68 25.03L21.91 20.28' />
              <circle {...LINE} cx='20' cy='17' r='3.8' />
            </motion.g>
            <motion.g
              className='origin-[27px_29px]! [transform-box:view-box]!'
              {...iconMotion('pl2', paused)}
              key={paused ? 'still-8' : 'moving-8'}
            >
              <path {...LINE} d='M31.27 27.29L36.34 25.26' />
              <circle {...LINE} cx='39.5' cy='24' r='3.4' />
            </motion.g>
            <motion.g
              className='origin-[27px_29px]! [transform-box:view-box]!'
              {...iconMotion('pl3', paused)}
              key={paused ? 'still-9' : 'moving-9'}
            >
              <path {...LINE} d='M30.17 32.33L34.16 36.54' />
              <circle {...LINE} cx='36.5' cy='39' r='3.4' />
            </motion.g>
            <motion.g
              className='origin-[27px_29px]! [transform-box:view-box]!'
              {...iconMotion('pl4', paused)}
              key={paused ? 'still-10' : 'moving-10'}
            >
              <path {...LINE} d='M23.44 31.91L18.79 35.72' />
              <circle {...LINE} cx='16' cy='38' r='3.6' />
            </motion.g>
            <motion.g
              className='origin-[27px_29px]! [transform-box:view-box]!'
              {...iconMotion('pl5', paused)}
              key={paused ? 'still-11' : 'moving-11'}
            >
              <path {...LINE} d='M29.12 24.92L32.43 18.52' />
              <circle {...LINE} cx='34' cy='15.5' r='3.4' />
            </motion.g>
            <circle {...LINE} className='fill-background' cx='27' cy='29' r='4.6' />
            <circle {...(monochrome ? LINE : MARK)} cx='27' cy='29' r='4.6' />
          </g>
        </GlyphStrokes>
      )
    case 'developer':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <path {...LINE} d='M22 22L15 29L22 36M34 22L41 29L34 36' />
            <g>
              <motion.path
                {...(monochrome ? LINE : MARK)}
                pathLength='1'
                d='M30.5 19L25.5 39'
                {...iconMotion('a-draw', paused)}
                key={paused ? 'still-12' : 'moving-12'}
                strokeDasharray={paused ? undefined : 1}
              />
            </g>
          </g>
        </GlyphStrokes>
      )
    case 'reviewer':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <g>
              <motion.path
                {...(monochrome ? LINE : MARK)}
                pathLength='1'
                d='M17 29L24.5 36.5L39 22'
                {...iconMotion('a-draw', paused)}
                key={paused ? 'still-13' : 'moving-13'}
                strokeDasharray={paused ? undefined : 1}
              />
            </g>
          </g>
        </GlyphStrokes>
      )
    case 'security-reviewer':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <path {...LINE} d='M28 15L39 19V27C39 34 34.5 39 28 41C21.5 39 17 34 17 27V19Z' />
            <motion.g {...iconMotion('a-blink', paused)} key={paused ? 'still-14' : 'moving-14'}>
              <circle {...(monochrome ? { fill: 'currentColor', stroke: 'none' } : DOT)} cx='28' cy='26.5' r='3' />
              <path {...(monochrome ? LINE : MARK)} d='M28 29.5V33.5' />
            </motion.g>
          </g>
        </GlyphStrokes>
      )
    case 'operator':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <motion.path
              {...(monochrome ? LINE : MARK)}
              d='M23 18L31 23L31 33L23 38Z'
              {...iconMotion('a-opl', paused)}
              key={paused ? 'still-15' : 'moving-15'}
            />
            <motion.path
              {...(monochrome ? LINE : MARK)}
              d='M31 23L39 28L39 28L31 33Z'
              {...iconMotion('a-opr', paused)}
              key={paused ? 'still-16' : 'moving-16'}
            />
          </g>
        </GlyphStrokes>
      )
    case 'archivist':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <path {...LINE} d='M14 41H42' />
            <rect {...LINE} x='16' y='19' width='6.5' height='22' rx='1.2' />
            <rect {...LINE} x='24.5' y='22' width='6.5' height='19' rx='1.2' />
            <motion.g
              className='origin-bottom-left! [transform-box:fill-box]!'
              {...iconMotion('a-fall', paused)}
              key={paused ? 'still-17' : 'moving-17'}
            >
              <rect {...(monochrome ? LINE : MARK)} x='34.5' y='20' width='6.5' height='21' rx='1.2' />
            </motion.g>
          </g>
        </GlyphStrokes>
      )
    case 'tranche-archivist':
      return (
        <GlyphStrokes longerSide={53.926}>
          <g data-role-sign transform='translate(28 33) scale(0.80769) translate(-28 -28)'>
            <g>
              <motion.path
                {...(monochrome ? LINE : MARK)}
                pathLength='1'
                d='M13 22L28 12L43 22Z'
                {...iconMotion('a-draw', paused)}
                key={paused ? 'still-18' : 'moving-18'}
                strokeDasharray={paused ? undefined : 1}
              />
            </g>
            <path {...LINE} d='M13 22H43' />
            <path {...LINE} d='M18 25V38M24.7 25V38M31.3 25V38M38 25V38' />
            <path {...LINE} d='M14 41H42' />
          </g>
        </GlyphStrokes>
      )
  }
}

export function AgentIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <path {...MARK} d='M19.12 31.35V34.65M23.56 28.93V37.07M28.00 23.31V42.69M32.44 28.93V37.07M36.88 31.35V34.65' />
    </Glyph>
  )
}

export function ArchitectIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='architect' paused={paused} />
    </Glyph>
  )
}

export function PlannerIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='planner' paused={paused} />
    </Glyph>
  )
}

export function DeveloperIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='developer' paused={paused} />
    </Glyph>
  )
}

export function ReviewerIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='reviewer' paused={paused} />
    </Glyph>
  )
}

export function SecurityReviewerIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='security-reviewer' paused={paused} />
    </Glyph>
  )
}

export function OperatorIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='operator' paused={paused} />
    </Glyph>
  )
}

export function ArchivistIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='archivist' paused={paused} />
    </Glyph>
  )
}

export function TrancheArchivistIcon({ className, still = false }: IconProps) {
  const paused = useIconStill(still)
  return (
    <Glyph className={className} viewBox='1.037 1.037 53.926 53.926'>
      <AgentFrame paused={paused} />
      <AgentSign role='tranche-archivist' paused={paused} />
    </Glyph>
  )
}
