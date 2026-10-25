'use client'

import { useReducedMotion, type TargetAndTransition, type Transition } from 'motion/react'

export type IconProps = { className?: string; still?: boolean }

export function useIconStill(still: boolean) {
  return Boolean(useReducedMotion()) || still
}

const stepEnd = (progress: number) => (progress < 1 ? 0 : 1)

// Timings from the approved motion reference. Important origin utilities on the drawings
// override Motion’s SVG centering defaults without constant inline styles.
const moves = {
  'a-nut': {
    animate: { rotate: [0, 0, 180, 180] },
    transition: { duration: 3.6, times: [0, 0.08, 0.3, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'a-pulse': {
    animate: { scale: [1, 1, 1.4, 1, 1] },
    transition: { duration: 3.6, times: [0, 0.34, 0.44, 0.56, 1], ease: [0.42, 0, 0.58, 1] }
  },
  'a-flag': {
    animate: { transform: ['skewY(0deg) scaleX(1)', 'skewY(-8deg) scaleX(0.86)', 'skewY(0deg) scaleX(1)'] },
    transition: { duration: 1.6, times: [0, 0.5, 1], ease: [0.42, 0, 0.58, 1] }
  },
  'a-draw': {
    animate: { strokeDashoffset: [1, 1, 0, 0] },
    transition: { duration: 3, times: [0, 0.08, 0.4, 1], ease: [0, 0, 0.58, 1] }
  },
  'a-blink': {
    animate: { opacity: [1, 1, 0.15, 1] },
    transition: { duration: 2.4, times: [0, 0.6, 0.75, 1], ease: [0.42, 0, 0.58, 1] }
  },
  'a-fall': {
    animate: { rotate: [0, 0, -10.4, -10.4, 0] },
    transition: { duration: 3.2, times: [0, 0.15, 0.45, 0.9, 1], ease: [0.55, 0, 0.4, 1.15] }
  },
  'a-opl': {
    animate: {
      d: [
        'M23 18L31 23L31 33L23 38Z',
        'M23 18L31 23L31 33L23 38Z',
        'M20 18L25 18L25 38L20 38Z',
        'M20 18L25 18L25 38L20 38Z',
        'M23 18L31 23L31 33L23 38Z',
        'M23 18L31 23L31 33L23 38Z'
      ]
    },
    transition: { duration: 3.2, times: [0, 0.3, 0.45, 0.8, 0.95, 1], ease: [0.6, 0, 0.3, 1] }
  },
  'a-opr': {
    animate: {
      d: [
        'M31 23L39 28L39 28L31 33Z',
        'M31 23L39 28L39 28L31 33Z',
        'M31 18L36 18L36 38L31 38Z',
        'M31 18L36 18L36 38L31 38Z',
        'M31 23L39 28L39 28L31 33Z',
        'M31 23L39 28L39 28L31 33Z'
      ]
    },
    transition: { duration: 3.2, times: [0, 0.3, 0.45, 0.8, 0.95, 1], ease: [0.6, 0, 0.3, 1] }
  },
  antL: {
    animate: { rotate: [0, 0, -12, 2, 0, -5, 3, 0] },
    transition: { duration: 5, times: [0, 0.04, 0.09, 0.15, 0.2, 0.45, 0.75, 1], ease: [0.42, 0, 0.58, 1] }
  },
  antR: {
    animate: { rotate: [0, 0, 12, -2, 0, 4, -4, 0] },
    transition: { duration: 5, times: [0, 0.04, 0.09, 0.15, 0.2, 0.45, 0.75, 1], ease: [0.42, 0, 0.58, 1] }
  },
  pupil: {
    animate: { x: [0, 0, -1.7, -1.7, 1.7, 1.7, 0, 0], y: [0, 0, 0.3, 0.3, 0.3, 0.3, 0, 0] },
    transition: { duration: 5, times: [0, 0.24, 0.32, 0.48, 0.56, 0.58, 0.64, 1], ease: [0.42, 0, 0.58, 1] }
  },
  eyeR: {
    animate: { scaleY: [1, 1, 0.12, 0.12, 1, 1] },
    transition: { duration: 5, times: [0, 0.7, 0.74, 0.77, 0.82, 1], ease: [0.42, 0, 0.58, 1] }
  },
  'mv-draw': {
    animate: { strokeDashoffset: [1, 1, 0, 0] },
    transition: { duration: 3, times: [0, 0.1, 0.45, 1], ease: [0, 0, 0.58, 1] }
  },
  'mv-grow': {
    animate: { scaleY: [0.4, 0.4, 1, 1] },
    transition: { duration: 3, times: [0, 0.1, 0.45, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'mv-rise': {
    animate: { y: [7.1, 7.1, 0, 0] },
    transition: { duration: 3, times: [0, 0.1, 0.45, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'mv-seq': {
    animate: { opacity: [0, 0, 1, 1, 0] },
    transition: { duration: 3, times: [0, 0.08, 0.16, 0.88, 1], ease: [0, 0, 0.58, 1] }
  },
  'mv-new': {
    animate: { opacity: [0, 0, 1, 1, 1, 0], scale: [0.3, 0.3, 1.3, 1, 1, 1] },
    transition: { duration: 3, times: [0, 0.08, 0.18, 0.26, 0.88, 1], ease: [0, 0, 0.58, 1] }
  },
  'mv-orbit': {
    animate: { strokeDashoffset: [1, 0, 0, 0], opacity: [1, 1, 1, 0] },
    transition: { duration: 4.5, times: [0, 0.75, 0.92, 1], ease: [0.45, 0, 0.35, 1] }
  },
  'mv-slide': {
    animate: { x: [-8, -8, 0, 0, -8] },
    transition: { duration: 3, times: [0, 0.15, 0.45, 0.85, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'mv-blink': { animate: { opacity: [1, 0, 1] }, transition: { duration: 1.1, times: [0, 0.5, 1], ease: stepEnd } },
  'mv-flame': {
    animate: { scaleY: [0.6, 1.15] },
    transition: { duration: 0.6, times: [0, 1], ease: [0.42, 0, 0.58, 1], repeatType: 'reverse' }
  },
  // Dev Process: the branch draws, its head lands, both hold, then branch and head leave together over the same
  // window; the branch is invisible while undrawn, so its round cap never leaves a dot behind.
  'mv-branch': {
    animate: { strokeDashoffset: [1, 1, 0, 0, 1, 1], opacity: [0, 0, 1, 1, 0, 0] },
    transition: { duration: 3.6, times: [0, 0.08, 0.38, 0.84, 0.96, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'mv-branch-head': {
    animate: { opacity: [0, 0, 1, 1, 0, 0], scale: [0.2, 0.2, 1, 1, 0.2, 0.2] },
    transition: { duration: 3.6, times: [0, 0.38, 0.48, 0.84, 0.96, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'mv-commit': {
    animate: { opacity: [0, 0, 1, 1, 0], scale: [0.2, 0.2, 1, 1, 1] },
    transition: { duration: 3, times: [0, 0.4, 0.55, 0.9, 1], ease: [0.5, 0, 0.3, 1.4] }
  },
  'mv-plug': {
    animate: { y: [3, 3, 0, 0, 3] },
    transition: { duration: 3, times: [0, 0.15, 0.5, 0.85, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'mv-cable': {
    animate: { scaleY: [0.09, 0.09, 1, 1, 0.09] },
    transition: { duration: 3, times: [0, 0.15, 0.5, 0.85, 1], ease: [0.5, 0, 0.3, 1] }
  },
  'mv-glow': {
    animate: { opacity: [0.35, 1, 0.35], scale: [0.85, 1.08, 0.85] },
    transition: { duration: 2.4, times: [0, 0.5, 1], ease: [0.42, 0, 0.58, 1] }
  },
  'mv-spin': { animate: { rotate: [0, 360] }, transition: { duration: 3, times: [0, 1], ease: 'linear' } },
  'mv-drop': {
    animate: { y: [-4, -4, 0, 0, -4], opacity: [0.25, 0.25, 1, 1, 0.25] },
    transition: { duration: 3.2, times: [0, 0.15, 0.4, 0.8, 1], ease: [0.6, 0, 0.3, 1] }
  },
  'mv-swing': {
    animate: { rotate: [-6, 6, -6] },
    transition: { duration: 2.6, times: [0, 0.5, 1], ease: [0.42, 0, 0.58, 1] }
  },
  'mv-bob': {
    animate: { y: [-1.2, 0.6] },
    transition: { duration: 1.8, times: [0, 1], ease: [0.42, 0, 0.58, 1], repeatType: 'reverse' }
  },
  'mv-step': { animate: { y: [0, 4, 8, 0] }, transition: { duration: 3.6, times: [0, 0.33, 0.66, 1], ease: stepEnd } },
  'mv-snap': {
    animate: { y: [6, 6, 0, 0, 0], opacity: [0, 0, 1, 1, 0] },
    transition: { duration: 3, times: [0, 0.15, 0.45, 0.85, 1], ease: [0.5, 0, 0.3, 1.3] }
  },
  fsig: {
    animate: { opacity: [0, 1, 1, 0, 0] },
    transition: { duration: 10, times: [0, 0.02, 0.2, 0.22, 1], ease: [0.42, 0, 0.58, 1] }
  },
  pl1: {
    animate: { rotate: [0, 0, -28, -28, 0, 0] },
    transition: { duration: 6, times: [0, 0.2, 0.38, 0.7, 0.88, 1], ease: [0.5, 0, 0.3, 1] }
  },
  pl2: {
    animate: { rotate: [0, 0, 24, 24, 0, 0] },
    transition: { duration: 6, times: [0, 0.2, 0.38, 0.7, 0.88, 1], ease: [0.5, 0, 0.3, 1] }
  },
  pl4: {
    animate: { rotate: [0, 0, 18, 18, 0, 0] },
    transition: { duration: 6, times: [0, 0.2, 0.38, 0.7, 0.88, 1], ease: [0.5, 0, 0.3, 1] }
  },
  pl3: {
    animate: { opacity: [1, 1, 0, 0, 1, 1], scale: [1, 1, 0.6, 0.6, 1, 1] },
    transition: { duration: 6, times: [0, 0.2, 0.34, 0.74, 0.88, 1], ease: [0.5, 0, 0.3, 1] }
  },
  pl5: {
    animate: { opacity: [0, 0, 1, 1, 0, 0], scale: [0.6, 0.6, 1, 1, 0.6, 0.6] },
    transition: { duration: 6, times: [0, 0.26, 0.4, 0.7, 0.84, 1], ease: [0.5, 0, 0.3, 1] }
  }
} satisfies Record<string, { animate: TargetAndTransition; transition: Transition }>

export function iconMotion(name: keyof typeof moves, still: boolean, delay = 0, duration?: number) {
  const move = moves[name]
  return {
    initial: still
      ? (false as const)
      : Object.fromEntries(Object.entries(move.animate).map(([property, values]) => [property, values[0]])),
    animate: still ? undefined : move.animate,
    transition: {
      ...move.transition,
      duration: duration ?? move.transition.duration,
      delay,
      repeat: Number.POSITIVE_INFINITY
    }
  }
}
